import type {
  AddManualNodeRequestPayload,
  NodeProtocol,
  UpdateManualNodeRequestPayload,
  VpnNode,
} from "../../../../shared/daemon";
import {
  createDefaultNodeFormValues,
  normalizeTransportForProtocol,
  type SubscriptionNodeFormValues,
} from "./nodeProtocolFormSchema";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (text !== "") {
      return text;
    }
  }
  return "";
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asString(item))
    .filter((item) => item !== "");
}

function splitMultiline(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function joinMultiline(values: string[]): string {
  return values.join("\n");
}

function parseReservedValues(value: string): number[] {
  return value
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function safeParseRawConfig(rawConfig: string): Record<string, unknown> {
  const input = rawConfig.trim();
  if (input === "") {
    return {};
  }
  try {
    return asRecord(JSON.parse(input));
  } catch {
    return {};
  }
}

function getNestedTransport(raw: Record<string, unknown>): Record<string, unknown> {
  return asRecord(raw.transport);
}

function getPreferredTransport(raw: Record<string, unknown>, outbound: Record<string, unknown>): Record<string, unknown> {
  const rawTransport = getNestedTransport(raw);
  if (Object.keys(rawTransport).length > 0) {
    return rawTransport;
  }
  return getNestedTransport(outbound);
}

function getTLSOptions(config: Record<string, unknown>): Record<string, unknown> {
  return asRecord(config.tls);
}

function hasTLSConfig(value: unknown): boolean {
  if (asBoolean(value)) {
    return true;
  }
  return Object.keys(asRecord(value)).length > 0;
}

function readTransportHost(transport: Record<string, unknown>): string {
  const directHost = asString(transport.host);
  if (directHost !== "") {
    return directHost;
  }
  const hostList = asStringArray(transport.host);
  if (hostList.length > 0) {
    return hostList[0] ?? "";
  }
  const headers = asRecord(transport.headers);
  return asString(headers.Host) || asString(headers.host);
}

function readTransportPath(transport: Record<string, unknown>): string {
  return asString(transport.path);
}

function readTransportServiceName(transport: Record<string, unknown>): string {
  return asString(transport.service_name) || asString(transport.serviceName);
}

function readTransportMethod(transport: Record<string, unknown>): string {
  return asString(transport.method);
}

function readTransportTimeout(transport: Record<string, unknown>, key: "idle_timeout" | "ping_timeout"): string {
  return asString(transport[key]);
}

function readTransportHeadersText(transport: Record<string, unknown>): string {
  const headers = Object.keys(asRecord(transport.headers)).length > 0 ? asRecord(transport.headers) : transport;
  const entries = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() !== "host")
    .map(([key, value]) => {
      const text = asString(value);
      return text === "" ? "" : `${key}: ${text}`;
    })
    .filter((item) => item !== "");
  return entries.join("\n");
}

function parseTransportHeaders(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const headerValue = line.slice(separatorIndex + 1).trim();
    if (key !== "" && headerValue !== "" && key.toLowerCase() !== "host") {
      result[key] = headerValue;
    }
  }
  return result;
}

function normalizeShadowsocksPluginName(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "simple-obfs":
    case "obfs":
    case "obfs-local":
      return "obfs-local";
    default:
      return value.trim();
  }
}

function buildShadowsocksPluginOptionsText(value: unknown): string {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return "";
  }
  const parts: string[] = [];
  const mode = firstNonEmptyString(record.obfs, record.mode);
  const host = firstNonEmptyString(record["obfs-host"], record.host);
  if (mode !== "") {
    parts.push(`obfs=${mode}`);
  }
  if (host !== "") {
    parts.push(`obfs-host=${host}`);
  }
  for (const key of ["uri", "path", "mux", "tls"]) {
    const item = asString(record[key]);
    if (item !== "") {
      parts.push(`${key}=${item}`);
    }
  }
  return parts.join(";");
}

function readShadowsocksPluginOptions(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (text !== "") {
      return text;
    }
    const recordText = buildShadowsocksPluginOptionsText(value);
    if (recordText !== "") {
      return recordText;
    }
  }
  return "";
}

function resolveTransportPayload(
  protocol: NodeProtocol,
  values: SubscriptionNodeFormValues,
  raw: Record<string, unknown>,
): void {
  const transport = normalizeTransportForProtocol(protocol, values.transport);
  const host = safeString(values.host);
  const path = safeString(values.path);
  const serviceName = safeString(values.serviceName);
  const transportMethod = safeString(values.transportMethod);
  const wsEarlyDataHeaderName = safeString(values.wsEarlyDataHeaderName);
  const httpIdleTimeout = safeString(values.httpIdleTimeout);
  const httpPingTimeout = safeString(values.httpPingTimeout);
  const grpcIdleTimeout = safeString(values.grpcIdleTimeout);
  const grpcPingTimeout = safeString(values.grpcPingTimeout);
  raw.transport = transport;
  if (host !== "" && (transport === "ws" || transport === "http" || transport === "httpupgrade")) {
    raw.host = host;
  }
  if (path !== "" && (transport === "ws" || transport === "http" || transport === "httpupgrade")) {
    raw.path = path;
  }
  if (serviceName !== "" && transport === "grpc") {
    raw.service_name = serviceName;
  }
  const headers = parseTransportHeaders(values.transportHeaders);
  if (Object.keys(headers).length > 0 && (transport === "ws" || transport === "http" || transport === "httpupgrade")) {
    raw.transport_headers = headers;
  }
  if (transportMethod !== "" && transport === "http") {
    raw.transport_method = transportMethod;
  }
  if (values.wsMaxEarlyData && values.wsMaxEarlyData > 0 && transport === "ws") {
    raw.ws_max_early_data = values.wsMaxEarlyData;
  }
  if (wsEarlyDataHeaderName !== "" && transport === "ws") {
    raw.ws_early_data_header_name = wsEarlyDataHeaderName;
  }
  if (httpIdleTimeout !== "" && transport === "http") {
    raw.http_idle_timeout = httpIdleTimeout;
  }
  if (httpPingTimeout !== "" && transport === "http") {
    raw.http_ping_timeout = httpPingTimeout;
  }
  if (grpcIdleTimeout !== "" && transport === "grpc") {
    raw.grpc_idle_timeout = grpcIdleTimeout;
  }
  if (grpcPingTimeout !== "" && transport === "grpc") {
    raw.grpc_ping_timeout = grpcPingTimeout;
  }
  if (values.grpcPermitWithoutStream && transport === "grpc") {
    raw.grpc_permit_without_stream = true;
  }
}

function resolveTLSPayload(
  protocol: NodeProtocol,
  values: SubscriptionNodeFormValues,
  raw: Record<string, unknown>,
): void {
  const tlsMode = safeString(values.tlsMode);
  const sni = safeString(values.sni);
  if (!values.tlsEnabled) {
    return;
  }
  raw.tls = true;
  if (protocol !== "vmess") {
    raw.security = tlsMode || "tls";
  }
  if (sni !== "") {
    raw.sni = sni;
  }
  if (values.insecure) {
    raw.insecure = true;
  }
}

function buildBaseRawConfig(values: SubscriptionNodeFormValues): Record<string, unknown> {
  const protocol = values.protocol;
  const transport = normalizeTransportForProtocol(protocol, values.transport);
  const address = safeString(values.address);
  const raw: Record<string, unknown> = {
    schema: "wateray.node.v1",
    source: "manual_form",
    protocol,
    server: address,
    server_port: values.port,
    display: {
      address,
      port: values.port,
      transport,
      security: "",
    },
  };
  return raw;
}

export function encodeNodeFormToCreatePayload(
  values: SubscriptionNodeFormValues,
): AddManualNodeRequestPayload {
  const protocol = values.protocol;
  const groupId = safeString(values.groupId);
  const name = safeString(values.name);
  const region = safeString(values.region);
  const country = safeString(values.country);
  const address = safeString(values.address);
  const uuid = safeString(values.uuid);
  const flow = safeString(values.flow);
  const password = safeString(values.password);
  const method = safeString(values.method);
  const username = safeString(values.username);
  const plugin = safeString(values.plugin);
  const pluginOptions = safeString(values.pluginOptions);
  const tlsMode = safeString(values.tlsMode);
  const sni = safeString(values.sni);
  const vmessCipher = safeString(values.vmessCipher);
  const wireguardPrivateKey = safeString(values.wireguardPrivateKey);
  const wireguardPeerPublicKey = safeString(values.wireguardPeerPublicKey);
  const wireguardPreSharedKey = safeString(values.wireguardPreSharedKey);
  const transport = normalizeTransportForProtocol(protocol, values.transport);
  if (protocol === "wireguard") {
    const outbound: Record<string, unknown> = {
      type: "wireguard",
      server: address,
      server_port: values.port,
      local_address: splitMultiline(values.wireguardLocalAddress),
      private_key: wireguardPrivateKey,
      peer_public_key: wireguardPeerPublicKey,
    };
    if (wireguardPreSharedKey !== "") {
      outbound.pre_shared_key = wireguardPreSharedKey;
    }
    if (values.wireguardMtu && values.wireguardMtu > 0) {
      outbound.mtu = values.wireguardMtu;
    }
    const reserved = parseReservedValues(values.wireguardReserved);
    if (reserved.length > 0) {
      outbound.reserved = reserved;
    }
    return {
      groupId,
      name,
      region,
      country,
      address,
      port: values.port,
      transport,
      protocol,
      rawConfig: JSON.stringify(
        {
          schema: "wateray.node.v1",
          source: "manual_form",
          protocol,
          singboxOutbound: outbound,
          display: {
            address,
            port: values.port,
            transport,
            security: "wireguard",
          },
        },
        null,
        2,
      ),
    };
  }

  const raw = buildBaseRawConfig(values);
  switch (protocol) {
    case "vmess":
      raw.uuid = uuid;
      raw.security = vmessCipher || "auto";
      if (values.alterId && values.alterId > 0) {
        raw.alter_id = values.alterId;
      }
      resolveTransportPayload(protocol, values, raw);
      resolveTLSPayload(protocol, values, raw);
      (raw.display as Record<string, unknown>).security = raw.security;
      break;
    case "vless":
      raw.uuid = uuid;
      if (flow !== "") {
        raw.flow = flow;
      }
      resolveTransportPayload(protocol, values, raw);
      resolveTLSPayload(protocol, values, raw);
      (raw.display as Record<string, unknown>).security = values.tlsEnabled
        ? tlsMode || "tls"
        : "none";
      break;
    case "trojan":
      raw.password = password;
      resolveTransportPayload(protocol, values, raw);
      resolveTLSPayload(protocol, values, raw);
      (raw.display as Record<string, unknown>).security = values.tlsEnabled
        ? tlsMode || "tls"
        : "none";
      break;
    case "shadowsocks":
      raw.method = method;
      raw.password = password;
      raw.transport = "-";
      (raw.display as Record<string, unknown>).transport = "-";
      (raw.display as Record<string, unknown>).security = method;
      if (plugin !== "") {
        raw.plugin = normalizeShadowsocksPluginName(plugin);
      }
      if (plugin !== "" && pluginOptions !== "") {
        raw.plugin_opts = pluginOptions;
      }
      if (normalizeShadowsocksPluginName(plugin) === "obfs-local") {
        raw.network = "tcp";
      }
      break;
    case "socks5":
      if (username !== "") {
        raw.username = username;
      }
      if (password !== "") {
        raw.password = password;
      }
      (raw.display as Record<string, unknown>).security = username !== "" ? "auth" : "none";
      break;
    case "http":
      if (username !== "") {
        raw.username = username;
      }
      if (password !== "") {
        raw.password = password;
      }
      resolveTLSPayload(protocol, values, raw);
      (raw.display as Record<string, unknown>).security = values.tlsEnabled
        ? tlsMode || "tls"
        : "none";
      break;
    case "hysteria2":
      raw.password = password;
      raw.transport = "udp";
      resolveTLSPayload(protocol, values, raw);
      (raw.display as Record<string, unknown>).transport = "udp";
      (raw.display as Record<string, unknown>).security = values.tlsEnabled
        ? tlsMode || "tls"
        : "none";
      break;
    case "tuic":
      raw.uuid = uuid;
      raw.password = password;
      raw.transport = "udp";
      resolveTLSPayload(protocol, values, raw);
      (raw.display as Record<string, unknown>).transport = "udp";
      (raw.display as Record<string, unknown>).security = values.tlsEnabled
        ? tlsMode || "tls"
        : "none";
      break;
  }

  return {
    groupId,
    name,
    region,
    country,
    address,
    port: values.port,
    transport: normalizeTransportForProtocol(protocol, transport),
    protocol,
    rawConfig: JSON.stringify(raw, null, 2),
  };
}

export function encodeNodeFormToUpdatePayload(
  nodeId: string,
  values: SubscriptionNodeFormValues,
): UpdateManualNodeRequestPayload {
  return {
    ...encodeNodeFormToCreatePayload(values),
    nodeId,
  };
}

export function decodeNodeToFormValues(
  groupId: string,
  node: VpnNode,
): SubscriptionNodeFormValues {
  const protocol = node.protocol;
  const raw = safeParseRawConfig(node.rawConfig);
  const outbound = asRecord(raw.singboxOutbound);
  const nestedTransport = getPreferredTransport(raw, outbound);
  const rawTLSOptions = getTLSOptions(raw);
  const outboundTLSOptions = getTLSOptions(outbound);
  const security = firstNonEmptyString(raw.security, outbound.security);
  const values = createDefaultNodeFormValues(protocol, {
    groupId,
    name: node.name,
    region: node.region,
    country: node.country,
    address: firstNonEmptyString(outbound.server, raw.server, node.address),
    port: asNumber(outbound.server_port) || asNumber(raw.server_port) || node.port,
    transport: normalizeTransportForProtocol(
      protocol,
      firstNonEmptyString(
        nestedTransport.type,
        raw.transport,
        raw.network,
        outbound.network,
        outbound.type === protocol ? "" : outbound.type,
        node.transport,
      ),
    ),
  });

  if (protocol === "wireguard") {
    return {
      ...values,
      wireguardLocalAddress: joinMultiline(asStringArray(outbound.local_address)),
      wireguardPrivateKey: asString(outbound.private_key),
      wireguardPeerPublicKey: asString(outbound.peer_public_key),
      wireguardPreSharedKey: asString(outbound.pre_shared_key),
      wireguardReserved: asStringArray(outbound.reserved).join(", "),
      wireguardMtu: asNumber(outbound.mtu) || undefined,
    };
  }

  return {
    ...values,
    uuid: firstNonEmptyString(raw.uuid, raw.id, raw.username, outbound.uuid, outbound.id, outbound.username),
    alterId: asNumber(raw.alter_id) || asNumber(raw.aid) || asNumber(outbound.alter_id) || asNumber(outbound.aid) || undefined,
    vmessCipher: firstNonEmptyString(raw.security, outbound.security, "auto"),
    flow: firstNonEmptyString(raw.flow, outbound.flow),
    password: firstNonEmptyString(raw.password, outbound.password),
    method: firstNonEmptyString(raw.method, outbound.method, raw.security, outbound.security, values.method),
    plugin: firstNonEmptyString(raw.plugin, outbound.plugin),
    pluginOptions: readShadowsocksPluginOptions(
      raw.plugin_opts,
      raw["plugin-opts"],
      raw.pluginOpts,
      outbound.plugin_opts,
      outbound["plugin-opts"],
      outbound.pluginOpts,
    ),
    username: firstNonEmptyString(raw.username, outbound.username),
    tlsEnabled:
      hasTLSConfig(raw.tls) ||
      hasTLSConfig(outbound.tls) ||
      security === "tls" ||
      security === "reality",
    tlsMode:
      security === "reality" || Object.keys(asRecord(outboundTLSOptions.reality)).length > 0
        ? "reality"
        : values.tlsMode,
    sni: firstNonEmptyString(
      raw.sni,
      raw.server_name,
      outbound.sni,
      outbound.server_name,
      rawTLSOptions.server_name,
      rawTLSOptions.sni,
      outboundTLSOptions.server_name,
      outboundTLSOptions.sni,
    ),
    insecure:
      asBoolean(raw.insecure) ||
      asBoolean(outbound.insecure) ||
      asBoolean(rawTLSOptions.insecure) ||
      asBoolean(outboundTLSOptions.insecure),
    host: firstNonEmptyString(raw.host, raw.authority, outbound.host, outbound.authority, readTransportHost(nestedTransport)),
    path: firstNonEmptyString(raw.path, outbound.path, readTransportPath(nestedTransport)),
    serviceName: firstNonEmptyString(
      raw.service_name,
      raw.serviceName,
      outbound.service_name,
      outbound.serviceName,
      readTransportServiceName(nestedTransport),
    ),
    transportHeaders:
      readTransportHeadersText(asRecord(raw.transport_headers)) ||
      readTransportHeadersText(nestedTransport),
    transportMethod: firstNonEmptyString(raw.transport_method, outbound.transport_method, readTransportMethod(nestedTransport)),
    wsMaxEarlyData:
      asNumber(raw.ws_max_early_data) ||
      asNumber(outbound.ws_max_early_data) ||
      asNumber(nestedTransport.max_early_data) ||
      undefined,
    wsEarlyDataHeaderName:
      firstNonEmptyString(raw.ws_early_data_header_name, outbound.ws_early_data_header_name, nestedTransport.early_data_header_name),
    httpIdleTimeout: firstNonEmptyString(raw.http_idle_timeout, outbound.http_idle_timeout, readTransportTimeout(nestedTransport, "idle_timeout")),
    httpPingTimeout: firstNonEmptyString(raw.http_ping_timeout, outbound.http_ping_timeout, readTransportTimeout(nestedTransport, "ping_timeout")),
    grpcIdleTimeout: firstNonEmptyString(raw.grpc_idle_timeout, outbound.grpc_idle_timeout, readTransportTimeout(nestedTransport, "idle_timeout")),
    grpcPingTimeout: firstNonEmptyString(raw.grpc_ping_timeout, outbound.grpc_ping_timeout, readTransportTimeout(nestedTransport, "ping_timeout")),
    grpcPermitWithoutStream:
      asBoolean(raw.grpc_permit_without_stream) ||
      asBoolean(outbound.grpc_permit_without_stream) ||
      asBoolean(nestedTransport.permit_without_stream),
  };
}
