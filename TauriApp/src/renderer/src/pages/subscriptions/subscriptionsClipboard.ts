import type { NodeProtocol, VpnNode } from "../../../../shared/daemon";

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

function encodeBase64(value: string): string {
  return window.btoa(unescape(encodeURIComponent(value)));
}

function appendCommonTransportQuery(params: URLSearchParams, node: VpnNode, raw: Record<string, unknown>): void {
  const transport = asString(raw.transport) || node.transport;
  if (transport !== "" && transport !== "tcp" && transport !== "-") {
    params.set("type", transport);
  }
  const host = asString(raw.host) || asString(raw.authority);
  if (host !== "") {
    params.set("host", host);
  }
  const path = asString(raw.path);
  if (path !== "") {
    params.set("path", path);
  }
  const serviceName = asString(raw.service_name) || asString(raw.serviceName);
  if (serviceName !== "") {
    params.set("serviceName", serviceName);
  }
  const security = asString(raw.security);
  if (security !== "") {
    params.set("security", security);
  } else if (asBoolean(raw.tls)) {
    params.set("security", "tls");
  }
  const sni = asString(raw.sni) || asString(raw.server_name);
  if (sni !== "") {
    params.set("sni", sni);
  }
  const flow = asString(raw.flow);
  if (flow !== "") {
    params.set("flow", flow);
  }
}

function buildStandardURL(
  protocol: string,
  username: string,
  password: string,
  node: VpnNode,
  raw: Record<string, unknown>,
): string {
  const encodedUser = encodeURIComponent(username);
  const encodedPassword = password !== "" ? `:${encodeURIComponent(password)}` : "";
  const params = new URLSearchParams();
  appendCommonTransportQuery(params, node, raw);
  const query = params.toString();
  const fragment = node.name.trim() !== "" ? `#${encodeURIComponent(node.name.trim())}` : "";
  return `${protocol}://${encodedUser}${encodedPassword}@${node.address}:${node.port}${query ? `?${query}` : ""}${fragment}`;
}

function encodeVmessURI(node: VpnNode, raw: Record<string, unknown>): string | null {
  const uuid = asString(raw.uuid) || asString(raw.id) || asString(raw.username);
  if (uuid === "") {
    return null;
  }
  const payload: Record<string, unknown> = {
    v: "2",
    ps: node.name.trim(),
    add: node.address,
    port: String(node.port),
    id: uuid,
    aid: String(asNumber(raw.alter_id) || asNumber(raw.aid) || 0),
    scy: asString(raw.security) || "auto",
    net: asString(raw.transport) || node.transport || "tcp",
    type: "none",
  };
  const host = asString(raw.host) || asString(raw.authority);
  if (host !== "") {
    payload.host = host;
  }
  const path = asString(raw.path);
  if (path !== "") {
    payload.path = path;
  }
  if (asBoolean(raw.tls) || asString(raw.security) === "tls") {
    payload.tls = "tls";
  }
  const sni = asString(raw.sni) || asString(raw.server_name);
  if (sni !== "") {
    payload.sni = sni;
  }
  return `vmess://${encodeBase64(JSON.stringify(payload))}`;
}

function encodeShadowsocksURI(node: VpnNode, raw: Record<string, unknown>): string | null {
  const method = asString(raw.method);
  const password = asString(raw.password);
  if (method === "" || password === "") {
    return null;
  }
  const userInfo = encodeBase64(`${method}:${password}`);
  const fragment = node.name.trim() !== "" ? `#${encodeURIComponent(node.name.trim())}` : "";
  return `ss://${userInfo}@${node.address}:${node.port}${fragment}`;
}

function encodeHTTPLikeURI(node: VpnNode, raw: Record<string, unknown>, protocol: "http" | "https" | "socks5"): string {
  const username = asString(raw.username);
  const password = asString(raw.password);
  return buildStandardURL(protocol, username, password, node, raw);
}

function encodeByProtocol(protocol: NodeProtocol, node: VpnNode, raw: Record<string, unknown>): string | null {
  switch (protocol) {
    case "vmess":
      return encodeVmessURI(node, raw);
    case "vless":
    {
      const uuid = asString(raw.uuid) || asString(raw.id) || asString(raw.username);
      return uuid === "" ? null : buildStandardURL("vless", uuid, "", node, raw);
    }
    case "trojan":
    {
      const password = asString(raw.password);
      return password === "" ? null : buildStandardURL("trojan", password, "", node, raw);
    }
    case "shadowsocks":
      return encodeShadowsocksURI(node, raw);
    case "socks5":
      return encodeHTTPLikeURI(node, raw, "socks5");
    case "http":
      return encodeHTTPLikeURI(node, raw, asBoolean(raw.tls) || asString(raw.security) === "tls" ? "https" : "http");
    case "hysteria2":
    {
      const password = asString(raw.password);
      return password === "" ? null : buildStandardURL("hy2", password, "", node, raw);
    }
    case "tuic": {
      const uuid = asString(raw.uuid) || asString(raw.id) || asString(raw.username);
      const password = asString(raw.password);
      if (uuid === "") {
        return null;
      }
      return buildStandardURL("tuic", uuid, password, node, raw);
    }
    default:
      return null;
  }
}

export function serializeNodeToClipboardLine(node: VpnNode): string | null {
  const raw = safeParseRawConfig(node.rawConfig);
  const rawURI = asString(raw.uri);
  if (rawURI !== "") {
    return rawURI;
  }
  return encodeByProtocol(node.protocol, node, raw);
}

