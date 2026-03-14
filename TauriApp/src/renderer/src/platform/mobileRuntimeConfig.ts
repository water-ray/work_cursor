import type {
  DaemonSnapshot,
  DNSConfig,
  DNSResolverEndpoint,
  DNSRule,
  LogLevel,
  NodeGroup,
  ProxyMode,
  ProxyTunStack,
  VpnNode,
} from "../../../shared/daemon";

type UnknownRecord = Record<string, unknown>;

export interface MobileResolverContext {
  systemDnsServers?: string[];
}

const defaultTunInterfaceName = "wateray-tun";
const defaultTunMTU = 1420;
const minTunMTU = 576;
const defaultLocalMixedListenAddress = "127.0.0.1";
const defaultLocalMixedListenPort = 1088;

const bootstrapDnsServerTag = "bootstrap";
const localDnsServerTag = "local-resolver";
const dnsDirectOutboundTag = "dns-direct";
const proxySelectorTag = "proxy";
const proxyUrlTestTag = "proxy-auto";
const defaultUrlTestProbeUrl = "https://www.gstatic.com/generate_204";
const defaultUrlTestInterval = "3m";
const defaultUrlTestIdleTimeout = "30m";
const defaultUrlTestToleranceMs = 50;
const defaultSniffTimeoutMs = 1000;

const defaultProbeSocksListenAddress = "127.0.0.1";
export const defaultMobileProbeSocksPort = 39091;

const defaultDnsConfig: DNSConfig = {
  version: 2,
  remote: {
    type: "https",
    address: "dns.google",
    port: 443,
    path: "/dns-query",
    detour: "proxy",
  },
  direct: {
    type: "https",
    address: "dns.alidns.com",
    port: 443,
    path: "/dns-query",
    detour: "direct",
  },
  bootstrap: {
    type: "udp",
    address: "223.5.5.5",
    port: 53,
    detour: "direct",
  },
  policy: {
    strategy: "prefer_ipv4",
    final: "remote",
  },
  cache: {
    independentCache: false,
    capacity: 4096,
    fileEnabled: false,
    storeRDRC: false,
  },
  fakeip: {
    enabled: false,
    ipv4Range: "10.128.0.0/9",
    ipv6Range: "fc00::/18",
  },
  hosts: {
    useSystemHosts: false,
    useCustomHosts: false,
    customHosts: "",
  },
  rules: [
    {
      id: "builtin-lan-direct",
      enabled: true,
      domainSuffix: ["lan", "local"],
      action: "route",
      server: "direct",
    },
  ],
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "";
}

function firstNonEmptyString(source: UnknownRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = toStringValue(source[key]);
    if (value !== "") {
      return value;
    }
  }
  return "";
}

function toIntValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function toFlatStringMap(value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    return {};
  }
  const result: UnknownRecord = {};
  for (const [key, item] of Object.entries(value)) {
    const text = toStringValue(item);
    if (text !== "") {
      result[key] = text;
    }
  }
  return result;
}

function parseNodeRawConfig(rawConfig: string): UnknownRecord {
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTunStack(value: ProxyTunStack | string | undefined): ProxyTunStack {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "mixed":
      return "mixed";
    case "gvisor":
      return "gvisor";
    default:
      return "system";
  }
}

function normalizeTunMtu(value: number | undefined): number {
  const normalized = Math.trunc(Number(value ?? defaultTunMTU));
  return normalized >= minTunMTU ? normalized : defaultTunMTU;
}

function shouldUseBootstrapResolver(server: string): boolean {
  const value = server.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (value === "") {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }
  if (value.includes(":")) {
    return false;
  }
  return true;
}

function runtimeNodeTag(nodeId: string): string {
  return `node-${nodeId}`;
}

function looksLikeShadowsocksMethod(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "-" || normalized === "tcp" || normalized === "udp") {
    return false;
  }
  return (
    normalized.includes("gcm") ||
    normalized.includes("poly1305") ||
    normalized.startsWith("aes-") ||
    normalized.startsWith("chacha20") ||
    normalized.startsWith("xchacha20") ||
    normalized === "none"
  );
}

function applyOutboundDomainResolver(outbound: UnknownRecord, server: string): void {
  if (toStringValue(outbound.domain_resolver) !== "") {
    return;
  }
  if (!shouldUseBootstrapResolver(server)) {
    return;
  }
  outbound.domain_resolver = bootstrapDnsServerTag;
}

function normalizeSystemDnsServers(value: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    ),
  );
}

export function materializeMobileDnsEndpoint(
  tag: string,
  endpoint: DNSResolverEndpoint,
  resolverContext: MobileResolverContext,
): DNSResolverEndpoint {
  if (endpoint.type !== "local") {
    return endpoint;
  }
  const systemDnsServers = normalizeSystemDnsServers(resolverContext.systemDnsServers);
  const address = systemDnsServers[0] ?? "";
  if (address === "") {
    throw new Error(`移动端当前无法获取系统 DNS，${tag} 解析器不能使用 local 类型`);
  }
  return {
    ...endpoint,
    type: "udp",
    address,
    port: Number(endpoint.port ?? 53) > 0 ? Number(endpoint.port ?? 53) : 53,
    detour: endpoint.detour ?? "direct",
  };
}

function applyTransportAndTls(outbound: UnknownRecord, raw: UnknownRecord): void {
  const transport = firstNonEmptyString(raw, "transport", "network", "net").toLowerCase();
  const headers = toFlatStringMap(raw.transport_headers);
  switch (transport) {
    case "ws":
    case "websocket": {
      const ws: UnknownRecord = { type: "ws" };
      const path = firstNonEmptyString(raw, "path");
      if (path !== "") {
        ws.path = path;
      }
      const host = firstNonEmptyString(raw, "host", "authority");
      if (host !== "") {
        headers.Host = host;
      }
      if (Object.keys(headers).length > 0) {
        ws.headers = headers;
      }
      const maxEarlyData = toIntValue(raw.ws_max_early_data);
      if (maxEarlyData > 0) {
        ws.max_early_data = maxEarlyData;
      }
      const earlyHeaderName = firstNonEmptyString(raw, "ws_early_data_header_name");
      if (earlyHeaderName !== "") {
        ws.early_data_header_name = earlyHeaderName;
      }
      outbound.transport = ws;
      break;
    }
    case "grpc": {
      const grpc: UnknownRecord = { type: "grpc" };
      const serviceName = firstNonEmptyString(raw, "service_name", "serviceName");
      if (serviceName !== "") {
        grpc.service_name = serviceName;
      }
      const idleTimeout = firstNonEmptyString(raw, "grpc_idle_timeout");
      if (idleTimeout !== "") {
        grpc.idle_timeout = idleTimeout;
      }
      const pingTimeout = firstNonEmptyString(raw, "grpc_ping_timeout");
      if (pingTimeout !== "") {
        grpc.ping_timeout = pingTimeout;
      }
      const permitWithoutStream = toBooleanValue(raw.grpc_permit_without_stream);
      if (permitWithoutStream !== null) {
        grpc.permit_without_stream = permitWithoutStream;
      }
      outbound.transport = grpc;
      break;
    }
    case "quic":
      outbound.transport = { type: "quic" };
      break;
    case "http":
    case "h2": {
      const httpTransport: UnknownRecord = { type: "http" };
      const path = firstNonEmptyString(raw, "path");
      if (path !== "") {
        httpTransport.path = path;
      }
      const host = firstNonEmptyString(raw, "host", "authority");
      if (host !== "") {
        httpTransport.host = [host];
      }
      const method = firstNonEmptyString(raw, "transport_method");
      if (method !== "") {
        httpTransport.method = method;
      }
      if (Object.keys(headers).length > 0) {
        httpTransport.headers = headers;
      }
      const idleTimeout = firstNonEmptyString(raw, "http_idle_timeout");
      if (idleTimeout !== "") {
        httpTransport.idle_timeout = idleTimeout;
      }
      const pingTimeout = firstNonEmptyString(raw, "http_ping_timeout");
      if (pingTimeout !== "") {
        httpTransport.ping_timeout = pingTimeout;
      }
      outbound.transport = httpTransport;
      break;
    }
    case "httpupgrade":
    case "http-upgrade": {
      const upgrade: UnknownRecord = { type: "httpupgrade" };
      const path = firstNonEmptyString(raw, "path");
      if (path !== "") {
        upgrade.path = path;
      }
      const host = firstNonEmptyString(raw, "host", "authority");
      if (host !== "") {
        upgrade.host = host;
      }
      if (Object.keys(headers).length > 0) {
        upgrade.headers = headers;
      }
      outbound.transport = upgrade;
      break;
    }
    default:
      break;
  }

  const security = firstNonEmptyString(raw, "security").toLowerCase();
  let tlsEnabled = false;
  if (raw.tls !== undefined) {
    tlsEnabled = toBooleanValue(raw.tls) === true;
  }
  if (security === "tls" || security === "reality") {
    tlsEnabled = true;
  }
  if (!tlsEnabled) {
    return;
  }
  const tls: UnknownRecord = { enabled: true };
  const serverName = firstNonEmptyString(raw, "sni", "server_name");
  if (serverName !== "") {
    tls.server_name = serverName;
  }
  const insecure = toBooleanValue(raw.insecure);
  if (insecure !== null) {
    tls.insecure = insecure;
  }
  outbound.tls = tls;
}

function buildNodeOutbound(node: VpnNode, tag: string): UnknownRecord {
  const raw = parseNodeRawConfig(node.rawConfig);
  if (isRecord(raw.singboxOutbound)) {
    const outbound = deepClone(raw.singboxOutbound);
    if (toStringValue(outbound.type) === "") {
      throw new Error("节点缺少 sing-box outbound.type");
    }
    if (firstNonEmptyString(outbound, "server") === "") {
      outbound.server = node.address;
    }
    if (toIntValue(outbound.server_port) <= 0 && node.port > 0) {
      outbound.server_port = node.port;
    }
    outbound.tag = tag;
    delete outbound.multiplex;
    applyOutboundDomainResolver(outbound, firstNonEmptyString(outbound, "server"));
    return outbound;
  }

  const server = firstNonEmptyString(raw, "server", "address") || node.address.trim();
  const serverPort = toIntValue(raw.server_port) || toIntValue(raw.port) || node.port;
  if (server === "" || serverPort <= 0) {
    throw new Error(`节点 ${node.name} 的服务端地址或端口无效`);
  }

  switch (node.protocol) {
    case "vmess": {
      const uuid = firstNonEmptyString(raw, "uuid", "id", "username");
      if (uuid === "") {
        throw new Error(`节点 ${node.name} 缺少 VMess UUID`);
      }
      const outbound: UnknownRecord = {
        type: "vmess",
        tag,
        server,
        server_port: serverPort,
        uuid,
        security: firstNonEmptyString(raw, "security", "scy") || "auto",
      };
      const alterId = toIntValue(raw.alter_id) || toIntValue(raw.aid);
      if (alterId > 0) {
        outbound.alter_id = alterId;
      }
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "vless": {
      const uuid = firstNonEmptyString(raw, "uuid", "username");
      if (uuid === "") {
        throw new Error(`节点 ${node.name} 缺少 VLESS UUID`);
      }
      const outbound: UnknownRecord = {
        type: "vless",
        tag,
        server,
        server_port: serverPort,
        uuid,
      };
      const flow = firstNonEmptyString(raw, "flow");
      if (flow !== "") {
        outbound.flow = flow;
      }
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "trojan": {
      const password = firstNonEmptyString(raw, "password", "username");
      if (password === "") {
        throw new Error(`节点 ${node.name} 缺少 Trojan 密码`);
      }
      const outbound: UnknownRecord = {
        type: "trojan",
        tag,
        server,
        server_port: serverPort,
        password,
      };
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "shadowsocks": {
      let method = firstNonEmptyString(raw, "method", "cipher", "security");
      if (method === "" && looksLikeShadowsocksMethod(node.transport)) {
        method = node.transport;
      }
      const password = firstNonEmptyString(raw, "password", "user_password");
      if (method === "" || password === "") {
        throw new Error(`节点 ${node.name} 缺少 Shadowsocks method/password`);
      }
      const outbound: UnknownRecord = {
        type: "shadowsocks",
        tag,
        server,
        server_port: serverPort,
        method,
        password,
      };
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "socks5": {
      const outbound: UnknownRecord = {
        type: "socks",
        tag,
        server,
        server_port: serverPort,
        version: "5",
      };
      const username = firstNonEmptyString(raw, "username");
      if (username !== "") {
        outbound.username = username;
      }
      const password = firstNonEmptyString(raw, "password");
      if (password !== "") {
        outbound.password = password;
      }
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "http": {
      const outbound: UnknownRecord = {
        type: "http",
        tag,
        server,
        server_port: serverPort,
      };
      const username = firstNonEmptyString(raw, "username");
      if (username !== "") {
        outbound.username = username;
      }
      const password = firstNonEmptyString(raw, "password");
      if (password !== "") {
        outbound.password = password;
      }
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "hysteria2": {
      const password = firstNonEmptyString(raw, "password", "username");
      if (password === "") {
        throw new Error(`节点 ${node.name} 缺少 Hysteria2 密码`);
      }
      const outbound: UnknownRecord = {
        type: "hysteria2",
        tag,
        server,
        server_port: serverPort,
        password,
      };
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "tuic": {
      const uuid = firstNonEmptyString(raw, "uuid", "username");
      const password = firstNonEmptyString(raw, "password");
      if (uuid === "" || password === "") {
        throw new Error(`节点 ${node.name} 缺少 TUIC UUID 或密码`);
      }
      const outbound: UnknownRecord = {
        type: "tuic",
        tag,
        server,
        server_port: serverPort,
        uuid,
        password,
      };
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "wireguard":
      throw new Error(`节点 ${node.name} 需要 sing-box 原始 outbound 才能在移动端启动`);
    default:
      throw new Error(`移动端暂不支持协议 ${node.protocol}`);
  }
}

function resolveActiveGroup(snapshot: DaemonSnapshot): NodeGroup | null {
  const groups = snapshot.groups ?? [];
  if (groups.length === 0) {
    return null;
  }
  return groups.find((group) => group.id === snapshot.activeGroupId) ?? groups[0] ?? null;
}

function resolveSelectedNode(snapshot: DaemonSnapshot, group: NodeGroup): VpnNode | null {
  if (!group.nodes.length) {
    return null;
  }
  return group.nodes.find((node) => node.id === snapshot.selectedNodeId) ?? group.nodes[0] ?? null;
}

function resolveDnsServerTag(server: string | undefined, fakeipEnabled = true): string {
  switch (String(server ?? "").trim().toLowerCase()) {
    case "direct":
      return "direct";
    case "bootstrap":
      return bootstrapDnsServerTag;
    case "fakeip":
      return fakeipEnabled ? "fakeip" : "remote";
    default:
      return "remote";
  }
}

function buildStructuredDnsServer(
  tag: string,
  endpoint: DNSResolverEndpoint,
  resolverTag: string,
  proxyDetourTag: string,
  resolverContext: MobileResolverContext,
): UnknownRecord {
  const resolvedEndpoint = materializeMobileDnsEndpoint(tag, endpoint, resolverContext);
  const entry: UnknownRecord = {
    type: resolvedEndpoint.type,
    tag,
  };
  switch (resolvedEndpoint.type) {
    case "local":
    case "hosts":
    case "resolved":
      return entry;
    case "dhcp":
      if (resolvedEndpoint.interface?.trim()) {
        entry.interface = resolvedEndpoint.interface.trim();
      }
      return entry;
    default:
      entry.server = resolvedEndpoint.address;
      if (Number(resolvedEndpoint.port ?? 0) > 0) {
        entry.server_port = resolvedEndpoint.port;
      }
      if (
        resolvedEndpoint.path?.trim() &&
        (resolvedEndpoint.type === "https" || resolvedEndpoint.type === "h3")
      ) {
        entry.path = resolvedEndpoint.path.trim();
      }
      const detour = String(resolvedEndpoint.detour ?? "").trim().toLowerCase();
      if (detour === "proxy") {
        entry.detour = proxyDetourTag;
      } else if (detour === "direct") {
        entry.detour = dnsDirectOutboundTag;
      }
      if (
        shouldUseBootstrapResolver(String(resolvedEndpoint.address ?? "")) &&
        resolverTag.trim() !== "" &&
        tag !== resolverTag
      ) {
        entry.domain_resolver = resolverTag;
      }
      return entry;
  }
}

function buildStructuredDnsRule(rule: DNSRule, fakeipEnabled: boolean): UnknownRecord | null {
  if (!rule.enabled) {
    return null;
  }
  const compiled: UnknownRecord = {};
  const domain = rule.domain ?? [];
  if (domain.length > 0) {
    compiled.domain = [...domain];
  }
  const domainSuffix = rule.domainSuffix ?? [];
  if (domainSuffix.length > 0) {
    compiled.domain_suffix = [...domainSuffix];
  }
  const domainKeyword = rule.domainKeyword ?? [];
  if (domainKeyword.length > 0) {
    compiled.domain_keyword = [...domainKeyword];
  }
  const domainRegex = rule.domainRegex ?? [];
  if (domainRegex.length > 0) {
    compiled.domain_regex = [...domainRegex];
  }
  const queryType = rule.queryType ?? [];
  if (queryType.length > 0) {
    compiled.query_type = [...queryType];
  }
  const outbound = rule.outbound ?? [];
  if (outbound.length > 0) {
    compiled.outbound = [...outbound];
  }
  if (Object.keys(compiled).length === 0) {
    return null;
  }
  if (rule.action === "reject") {
    compiled.action = "reject";
    return compiled;
  }
  compiled.action = "route";
  compiled.server = resolveDnsServerTag(rule.server, fakeipEnabled);
  if (rule.disableCache) {
    compiled.disable_cache = true;
  }
  if (rule.clientSubnet?.trim()) {
    compiled.client_subnet = rule.clientSubnet.trim();
  }
  return compiled;
}

function buildDnsConfig(
  snapshot: DaemonSnapshot,
  proxyDetourTag: string,
  resolverContext: MobileResolverContext,
  options?: {
    fakeipEnabled?: boolean;
  },
): UnknownRecord {
  const dnsConfig = deepClone(snapshot.dns ?? defaultDnsConfig);
  const fakeipEnabled = options?.fakeipEnabled ?? (dnsConfig.fakeip?.enabled ?? false);
  const servers: UnknownRecord[] = [
    { type: "local", tag: localDnsServerTag },
    buildStructuredDnsServer(
      "remote",
      dnsConfig.remote,
      bootstrapDnsServerTag,
      proxyDetourTag,
      resolverContext,
    ),
    buildStructuredDnsServer(
      "direct",
      dnsConfig.direct,
      bootstrapDnsServerTag,
      proxyDetourTag,
      resolverContext,
    ),
    buildStructuredDnsServer(
      bootstrapDnsServerTag,
      dnsConfig.bootstrap,
      "",
      proxyDetourTag,
      resolverContext,
    ),
  ];
  const rules = (dnsConfig.rules ?? [])
    .map((item) => buildStructuredDnsRule(item, fakeipEnabled))
    .filter((item): item is UnknownRecord => Boolean(item));
  const dns: UnknownRecord = {
    servers,
    rules,
    final: resolveDnsServerTag(dnsConfig.policy?.final, fakeipEnabled),
    strategy: dnsConfig.policy?.strategy || defaultDnsConfig.policy.strategy,
    independent_cache: dnsConfig.cache?.independentCache ?? false,
    cache_capacity: Math.max(1024, Number(dnsConfig.cache?.capacity ?? 4096)),
    reverse_mapping: fakeipEnabled,
  };
  if (dnsConfig.policy?.clientSubnet?.trim()) {
    dns.client_subnet = dnsConfig.policy.clientSubnet.trim();
  }
  if (fakeipEnabled) {
    servers.push({
      type: "fakeip",
      tag: "fakeip",
      inet4_range: dnsConfig.fakeip.ipv4Range || "10.128.0.0/9",
      inet6_range: dnsConfig.fakeip.ipv6Range || "fc00::/18",
    });
    rules.push({
      query_type: ["A", "AAAA"],
      action: "route",
      server: "fakeip",
    });
  }
  return dns;
}

function normalizeSniffTimeoutMs(value: number | undefined): string {
  const timeoutMs = Math.trunc(Number(value ?? defaultSniffTimeoutMs));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    return `${defaultSniffTimeoutMs}ms`;
  }
  return `${timeoutMs}ms`;
}

function buildDnsHijackRule(): UnknownRecord {
  return {
    type: "logical",
    mode: "or",
    rules: [{ protocol: "dns" }, { port: 53 }],
    action: "hijack-dns",
  };
}

function buildFakeipRouteRule(snapshot: DaemonSnapshot, targetMode: ProxyMode): UnknownRecord | null {
  if (targetMode !== "tun") {
    return null;
  }
  const fakeip = snapshot.dns?.fakeip ?? defaultDnsConfig.fakeip;
  if (!fakeip?.enabled) {
    return null;
  }
  const ipCidr = [fakeip.ipv4Range, fakeip.ipv6Range]
    .map((item) => String(item ?? "").trim())
    .filter((item) => item !== "");
  if (ipCidr.length === 0) {
    return null;
  }
  return {
    ip_cidr: ipCidr,
    action: "route",
    outbound: proxySelectorTag,
  };
}

function buildRuntimeRouteRules(snapshot: DaemonSnapshot, targetMode: ProxyMode): UnknownRecord[] {
  const rules: UnknownRecord[] = [];
  if (targetMode === "tun") {
    if (snapshot.sniffEnabled) {
      rules.push({
        action: "sniff",
        timeout: normalizeSniffTimeoutMs(snapshot.sniffTimeoutMs),
      });
    }
    rules.push(buildDnsHijackRule());
  }
  if (snapshot.blockUdp) {
    rules.push({ network: "udp", action: "reject" });
  } else if (snapshot.blockQuic) {
    rules.push({ protocol: "quic", action: "reject" }, { network: "udp", port: 443, action: "reject" });
  }
  const fakeipRouteRule = buildFakeipRouteRule(snapshot, targetMode);
  if (fakeipRouteRule) {
    rules.push(fakeipRouteRule);
  }
  rules.push({ ip_is_private: true, action: "route", outbound: "direct" });
  return rules;
}

function buildProbeRouteRules(): UnknownRecord[] {
  return [
    { ip_is_private: true, action: "route", outbound: "direct" },
  ];
}

function buildTunInbound(snapshot: DaemonSnapshot): UnknownRecord {
  return {
    type: "tun",
    tag: "tun-in",
    interface_name: defaultTunInterfaceName,
    address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
    auto_route: true,
    strict_route: true,
    mtu: normalizeTunMtu(snapshot.tunMtu),
    stack: normalizeTunStack(snapshot.tunStack),
  };
}

function normalizeLocalMixedListenPort(value: number | undefined): number {
  if (Number.isFinite(value) && (value ?? 0) >= 1 && (value ?? 0) <= 65535) {
    return Math.trunc(value as number);
  }
  return defaultLocalMixedListenPort;
}

function resolveLocalMixedListenAddress(snapshot: DaemonSnapshot): string {
  return snapshot.allowExternalConnections ? "0.0.0.0" : defaultLocalMixedListenAddress;
}

function buildMixedInbound(snapshot: DaemonSnapshot): UnknownRecord {
  return {
    type: "mixed",
    tag: "mixed-in",
    listen: resolveLocalMixedListenAddress(snapshot),
    listen_port: normalizeLocalMixedListenPort(snapshot.localProxyPort),
  };
}

function toSingboxLogLevel(level: LogLevel | string | undefined): string {
  switch (String(level ?? "").trim().toLowerCase()) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "none":
      return "error";
    default:
      return "info";
  }
}

export function buildMobileRuntimeConfig(
  snapshot: DaemonSnapshot,
  targetMode: ProxyMode = snapshot.configuredProxyMode,
  resolverContext: MobileResolverContext = {},
): {
  configJson: string;
  profileName: string;
  selectedNodeId: string;
} {
  const group = resolveActiveGroup(snapshot);
  if (!group || group.nodes.length === 0) {
    throw new Error("当前没有可用节点，无法启动移动端代理");
  }
  const selectedNode = resolveSelectedNode(snapshot, group);
  if (!selectedNode) {
    throw new Error("当前没有可用节点，无法启动移动端代理");
  }

  const nodeOutbounds: UnknownRecord[] = [];
  const nodeTags: string[] = [];
  for (const node of group.nodes) {
    const tag = runtimeNodeTag(node.id);
    try {
      nodeOutbounds.push(buildNodeOutbound(node, tag));
      nodeTags.push(tag);
    } catch (error) {
      if (node.id === selectedNode.id) {
        throw error;
      }
    }
  }
  const selectedTag = runtimeNodeTag(selectedNode.id);
  if (!nodeTags.includes(selectedTag)) {
    throw new Error(`当前选中节点 ${selectedNode.name} 暂不支持移动端启动`);
  }

  const outbounds: UnknownRecord[] = [];
  outbounds.push({
    type: "selector",
    tag: proxySelectorTag,
    outbounds: [proxyUrlTestTag, ...nodeTags, "direct"],
    default: selectedTag,
    interrupt_exist_connections: true,
  });
  outbounds.push(...nodeOutbounds);
  outbounds.push({
    type: "direct",
    tag: dnsDirectOutboundTag,
    connect_timeout: "5s",
  });
  outbounds.push({
    type: "urltest",
    tag: proxyUrlTestTag,
    outbounds: [...nodeTags],
    url: defaultUrlTestProbeUrl,
    interval: defaultUrlTestInterval,
    tolerance: defaultUrlTestToleranceMs,
    idle_timeout: defaultUrlTestIdleTimeout,
    interrupt_exist_connections: true,
  });
  outbounds.push({ type: "direct", tag: "direct" }, { type: "block", tag: "block" });

  const config = {
    log: {
      level: toSingboxLogLevel(snapshot.proxyLogLevel),
      timestamp: true,
    },
    inbounds: targetMode === "system"
      ? [buildMixedInbound(snapshot)]
      : [buildTunInbound(snapshot), buildMixedInbound(snapshot)],
    outbounds,
    dns: buildDnsConfig(snapshot, proxySelectorTag, resolverContext, {
      fakeipEnabled:
        targetMode === "tun" &&
        ((snapshot.dns?.fakeip?.enabled ?? defaultDnsConfig.fakeip.enabled) === true),
    }),
    route: {
      rules: buildRuntimeRouteRules(snapshot, targetMode),
      final: proxySelectorTag,
      default_domain_resolver: bootstrapDnsServerTag,
      auto_detect_interface: targetMode === "tun",
      override_android_vpn: targetMode === "tun",
    },
  };

  return {
    configJson: JSON.stringify(config),
    profileName: `${group.name || "移动代理"} · ${selectedNode.name}${targetMode === "system" ? " · 本地代理" : ""}`,
    selectedNodeId: selectedNode.id,
  };
}

export function buildMobileProbeConfig(
  snapshot: DaemonSnapshot,
  node: VpnNode,
  resolverContext: MobileResolverContext = {},
  socksPort = defaultMobileProbeSocksPort,
): string {
  const tag = runtimeNodeTag(node.id);
  const config = {
    log: {
      level: "error",
      timestamp: false,
    },
    inbounds: [
      {
        type: "socks",
        tag: "probe-in",
        listen: defaultProbeSocksListenAddress,
        listen_port: socksPort,
      },
    ],
    outbounds: [
      buildNodeOutbound(node, tag),
      {
        type: "direct",
        tag: dnsDirectOutboundTag,
        connect_timeout: "5s",
      },
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
    ],
    dns: buildDnsConfig(snapshot, tag, resolverContext, { fakeipEnabled: false }),
    route: {
      rules: buildProbeRouteRules(),
      final: tag,
      default_domain_resolver: bootstrapDnsServerTag,
    },
  };
  return JSON.stringify(config);
}
