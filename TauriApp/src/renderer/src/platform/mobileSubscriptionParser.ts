import { load as loadYaml } from "js-yaml";

import type { NodeProtocol, VpnNode } from "../../../shared/daemon";

type UnknownRecord = Record<string, unknown>;

export interface ParsedSubscriptionResult {
  nodes: VpnNode[];
  status: string;
}

const subscriptionTrafficPattern = /\d+(?:\.\d+)?\s*(?:[KMGTP]i?B)\s*\/\s*\d+(?:\.\d+)?\s*(?:[KMGTP]i?B)/i;
const subscriptionDatePattern = /\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/;
const subscriptionStatusKeywords = [
  "status",
  "traffic",
  "expire",
  "expiration",
  "到期",
  "到期时间",
  "流量",
];

const countryAliases: Record<string, string> = {
  hk: "HK",
  "hong kong": "HK",
  hongkong: "HK",
  "香港": "HK",
  mo: "MO",
  macau: "MO",
  macao: "MO",
  "澳门": "MO",
  jp: "JP",
  japan: "JP",
  "日本": "JP",
  sg: "SG",
  singapore: "SG",
  "新加坡": "SG",
  tw: "TW",
  taiwan: "TW",
  "台湾": "TW",
  kr: "KR",
  korea: "KR",
  "south korea": "KR",
  "韩国": "KR",
  us: "US",
  usa: "US",
  "united states": "US",
  "美国": "US",
  gb: "GB",
  uk: "GB",
  "united kingdom": "GB",
  "英国": "GB",
  de: "DE",
  germany: "DE",
  "德国": "DE",
  fr: "FR",
  france: "FR",
  "法国": "FR",
  ca: "CA",
  canada: "CA",
  "加拿大": "CA",
  au: "AU",
  australia: "AU",
  "澳大利亚": "AU",
};

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
    if (["1", "true", "yes", "on", "tls"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = toStringValue(value);
    if (text !== "") {
      return text;
    }
  }
  return "";
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function decodeBase64String(raw: string): string {
  const compact = raw.trim().replace(/\s+/g, "");
  if (compact === "") {
    return "";
  }
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (item) => item.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function decodeFragment(fragment: string): string {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (raw.trim() === "") {
    return "";
  }
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

function resolveRegionalIndicatorCountry(value: string): string {
  const runes = Array.from(value.trim());
  for (let index = 0; index < runes.length - 1; index += 1) {
    const first = runes[index] ?? "";
    const second = runes[index + 1] ?? "";
    const firstCode = first.codePointAt(0) ?? 0;
    const secondCode = second.codePointAt(0) ?? 0;
    if (
      firstCode >= 0x1f1e6 &&
      firstCode <= 0x1f1ff &&
      secondCode >= 0x1f1e6 &&
      secondCode <= 0x1f1ff
    ) {
      return String.fromCharCode(
        65 + firstCode - 0x1f1e6,
        65 + secondCode - 0x1f1e6,
      );
    }
  }
  return "";
}

function normalizeCountry(value: string): string {
  const flagCode = resolveRegionalIndicatorCountry(value);
  if (flagCode !== "") {
    return flagCode;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (/^[a-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (normalized in countryAliases) {
    return countryAliases[normalized];
  }
  for (const [alias, code] of Object.entries(countryAliases)) {
    if (normalized.includes(alias)) {
      return code;
    }
  }
  return "";
}

function resolveNodeCountry(explicitValue: string, name: string): string {
  return normalizeCountry(explicitValue) || normalizeCountry(name);
}

function normalizeDisplayTransport(protocol: NodeProtocol, transport: string): string {
  const normalized = transport.trim().toLowerCase();
  if (protocol === "shadowsocks") {
    return "-";
  }
  if (normalized === "" || normalized === protocol) {
    return "tcp";
  }
  return normalized;
}

function buildNode(params: {
  groupId: string;
  suffix: string;
  name: string;
  address: string;
  port: number;
  protocol: NodeProtocol;
  transport: string;
  country: string;
  rawConfig: string;
}): VpnNode {
  const country = normalizeCountry(params.country);
  return {
    id: `${params.groupId}-${params.suffix}`,
    name: params.name,
    region: country,
    country,
    protocol: params.protocol,
    latencyMs: 0,
    address: params.address,
    port: params.port,
    transport: params.transport,
    totalDownloadMb: 0,
    totalUploadMb: 0,
    todayDownloadMb: 0,
    todayUploadMb: 0,
    favorite: false,
    rawConfig: params.rawConfig,
  };
}

function buildRawConfig(payload: UnknownRecord): string {
  return JSON.stringify(payload);
}

function mapTypeToProtocol(value: string): NodeProtocol | null {
  switch (value.trim().toLowerCase()) {
    case "vmess":
      return "vmess";
    case "vless":
      return "vless";
    case "trojan":
      return "trojan";
    case "ss":
    case "shadowsocks":
      return "shadowsocks";
    case "hysteria2":
    case "hy2":
      return "hysteria2";
    case "tuic":
      return "tuic";
    case "wireguard":
    case "wg":
      return "wireguard";
    case "socks":
    case "socks5":
      return "socks5";
    case "http":
    case "https":
      return "http";
    default:
      return null;
  }
}

function defaultPortForProtocol(protocol: NodeProtocol): number {
  switch (protocol) {
    case "http":
      return 80;
    case "socks5":
      return 1080;
    default:
      return 443;
  }
}

function resolveTransport(query: URLSearchParams): string {
  return (
    query.get("type")?.trim() ||
    query.get("network")?.trim() ||
    query.get("transport")?.trim() ||
    query.get("obfs")?.trim() ||
    "tcp"
  );
}

function buildUriRawConfig(
  line: string,
  protocol: NodeProtocol,
  parsed: URL,
  server: string,
  port: number,
  transport: string,
): string {
  const query = parsed.searchParams;
  const username = parsed.username?.trim() || "";
  const password = parsed.password?.trim() || "";
  const insecureValue = [
    "insecure",
    "allowInsecure",
    "allow_insecure",
    "allow-insecure",
    "skip-cert-verify",
    "skip_cert_verify",
    "skipCertVerify",
  ]
    .map((key) => toBooleanValue(query.get(key)))
    .find((value) => value !== null);
  const raw: UnknownRecord = {
    schema: "wateray.node.v1",
    source: "uri",
    protocol,
    uri: line,
    server,
    server_port: port,
    transport,
    username,
    password,
    security: query.get("security")?.trim() || "",
    sni: firstNonEmptyString(query.get("sni"), query.get("peer")),
    host: firstNonEmptyString(query.get("host"), query.get("authority")),
    path: query.get("path")?.trim() || "",
    flow: query.get("flow")?.trim() || "",
    service_name: firstNonEmptyString(query.get("serviceName"), query.get("service_name")),
    tls: (query.get("security")?.trim() || "").toLowerCase() === "tls",
    country: resolveNodeCountry(
      firstNonEmptyString(query.get("country"), query.get("region")),
      decodeFragment(parsed.hash),
    ),
    display: {
      address: server,
      port,
      transport: normalizeDisplayTransport(protocol, transport),
      security: query.get("security")?.trim() || "",
    },
  };
  if (insecureValue !== undefined && insecureValue !== null) {
    raw.insecure = insecureValue;
  }
  switch (protocol) {
    case "vless":
      raw.uuid = username;
      break;
    case "trojan":
    case "hysteria2":
      raw.password = username;
      break;
    case "tuic":
      raw.uuid = username;
      break;
    default:
      break;
  }
  return buildRawConfig(raw);
}

function parseVmessNode(line: string, groupId: string, index: number): VpnNode | null {
  const decoded = decodeBase64String(line.trim().slice("vmess://".length));
  if (decoded === "") {
    return null;
  }
  let root: unknown;
  try {
    root = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!isRecord(root)) {
    return null;
  }
  const server = toStringValue(root.add);
  const port = toIntValue(root.port);
  if (server === "" || port <= 0) {
    return null;
  }
  const name = toStringValue(root.ps) || `vmess-${server}:${port}`;
  const transport = toStringValue(root.net) || "tcp";
  const rawConfig = buildRawConfig({
    schema: "wateray.node.v1",
    source: "vmess_uri",
    protocol: "vmess",
    uri: line,
    server,
    server_port: port,
    uuid: toStringValue(root.id),
    alter_id: toIntValue(root.aid),
    security: firstNonEmptyString(root.scy, "auto"),
    transport,
    tls: toStringValue(root.tls).toLowerCase() === "tls",
    sni: toStringValue(root.sni),
    host: toStringValue(root.host),
    path: toStringValue(root.path),
    display: {
      address: server,
      port,
      transport: normalizeDisplayTransport("vmess", transport),
      security: toStringValue(root.scy),
    },
  });
  return buildNode({
    groupId,
    suffix: `vmess-${index}`,
    name,
    address: server,
    port,
    protocol: "vmess",
    transport,
    country: resolveNodeCountry(firstNonEmptyString(root.country, root.region), name),
    rawConfig,
  });
}

function parseHostPort(raw: string): { host: string; port: number } | null {
  const value = raw.trim();
  if (value === "") {
    return null;
  }
  if (value.startsWith("[") && value.includes("]:")) {
    const separatorIndex = value.lastIndexOf("]:");
    const host = value.slice(1, separatorIndex).trim();
    const port = Number.parseInt(value.slice(separatorIndex + 2).trim(), 10);
    if (host !== "" && Number.isFinite(port) && port > 0) {
      return { host, port };
    }
    return null;
  }
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }
  const host = value.slice(0, separatorIndex).trim();
  const port = Number.parseInt(value.slice(separatorIndex + 1).trim(), 10);
  if (host === "" || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  return { host, port };
}

function parseShadowsocksNode(line: string, groupId: string, index: number): VpnNode | null {
  const body = line.trim().slice("ss://".length);
  const corePart = body.split("#")[0]?.split("?")[0]?.trim() || "";
  let hostPortPart = "";
  let method = "";
  let password = "";
  if (corePart.includes("@")) {
    const separatorIndex = corePart.lastIndexOf("@");
    let userInfo = corePart.slice(0, separatorIndex);
    hostPortPart = corePart.slice(separatorIndex + 1).replace(/\/+$/, "").trim();
    const decoded = decodeBase64String(userInfo);
    if (decoded.includes(":")) {
      userInfo = decoded;
    } else {
      try {
        userInfo = decodeURIComponent(userInfo);
      } catch {
        // Ignore malformed encoding.
      }
    }
    const authSeparatorIndex = userInfo.indexOf(":");
    if (authSeparatorIndex > 0) {
      method = userInfo.slice(0, authSeparatorIndex).trim();
      password = userInfo.slice(authSeparatorIndex + 1).trim();
    }
  } else {
    const decoded = decodeBase64String(corePart);
    if (!decoded.includes("@")) {
      return null;
    }
    const separatorIndex = decoded.lastIndexOf("@");
    hostPortPart = decoded.slice(separatorIndex + 1).replace(/\/+$/, "").trim();
    const userInfo = decoded.slice(0, separatorIndex);
    const authSeparatorIndex = userInfo.indexOf(":");
    if (authSeparatorIndex > 0) {
      method = userInfo.slice(0, authSeparatorIndex).trim();
      password = userInfo.slice(authSeparatorIndex + 1).trim();
    }
  }
  const hostPort = parseHostPort(hostPortPart);
  if (!hostPort || method === "" || password === "") {
    return null;
  }
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(line);
  } catch {
    parsedUrl = null;
  }
  const name = decodeFragment(parsedUrl?.hash || "") || `ss-${hostPort.host}:${hostPort.port}`;
  const rawConfig = buildRawConfig({
    schema: "wateray.node.v1",
    source: "ss_uri",
    protocol: "shadowsocks",
    uri: line,
    server: hostPort.host,
    server_port: hostPort.port,
    method,
    password,
    transport: "",
    security: method,
    display: {
      address: hostPort.host,
      port: hostPort.port,
      transport: "-",
      security: method,
    },
  });
  return buildNode({
    groupId,
    suffix: `ss-${index}`,
    name,
    address: hostPort.host,
    port: hostPort.port,
    protocol: "shadowsocks",
    transport: "-",
    country: resolveNodeCountry("", name),
    rawConfig,
  });
}

function parseUriNode(line: string, groupId: string, index: number): VpnNode | null {
  const lower = line.trim().toLowerCase();
  if (lower.startsWith("vmess://")) {
    return parseVmessNode(line, groupId, index);
  }
  if (lower.startsWith("ss://")) {
    return parseShadowsocksNode(line, groupId, index);
  }
  let parsed: URL;
  try {
    parsed = new URL(line);
  } catch {
    return null;
  }
  const protocol = mapTypeToProtocol(parsed.protocol.replace(/:$/, ""));
  if (!protocol) {
    return null;
  }
  const server = parsed.hostname.trim();
  const port = parsed.port.trim() !== "" ? toIntValue(parsed.port) : defaultPortForProtocol(protocol);
  if (server === "" || port <= 0) {
    return null;
  }
  const name = decodeFragment(parsed.hash) || `${protocol}-${server}:${port}`;
  const transport = resolveTransport(parsed.searchParams);
  const rawConfig = buildUriRawConfig(line, protocol, parsed, server, port, transport);
  return buildNode({
    groupId,
    suffix: `uri-${index}`,
    name,
    address: server,
    port,
    protocol,
    transport: normalizeDisplayTransport(protocol, transport),
    country: resolveNodeCountry(
      firstNonEmptyString(parsed.searchParams.get("country"), parsed.searchParams.get("region")),
      name,
    ),
    rawConfig,
  });
}

function parseUriLines(content: string, groupId: string): VpnNode[] {
  const candidates = [content];
  const decodedContent = decodeBase64String(content);
  if (decodedContent.includes("://")) {
    candidates.push(decodedContent);
  }
  const nodes: VpnNode[] = [];
  let index = 0;
  for (const candidate of candidates) {
    for (const rawLine of splitLines(candidate)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("//")) {
        continue;
      }
      const directNode = parseUriNode(line, groupId, index);
      if (directNode) {
        nodes.push(directNode);
        index += 1;
        continue;
      }
      const decodedLine = decodeBase64String(line);
      if (!decodedLine.includes("://")) {
        continue;
      }
      for (const decodedItem of splitLines(decodedLine)) {
        const normalizedItem = decodedItem.trim();
        if (normalizedItem === "" || normalizedItem.startsWith("#") || normalizedItem.startsWith("//")) {
          continue;
        }
        const nestedNode = parseUriNode(normalizedItem, groupId, index);
        if (!nestedNode) {
          continue;
        }
        nodes.push(nestedNode);
        index += 1;
      }
    }
  }
  return nodes;
}

function parseClashYaml(content: string, groupId: string): VpnNode[] {
  let root: unknown;
  try {
    root = loadYaml(content);
  } catch {
    return [];
  }
  if (!isRecord(root) || !Array.isArray(root.proxies)) {
    return [];
  }
  const nodes: VpnNode[] = [];
  let index = 0;
  for (const item of root.proxies) {
    if (!isRecord(item)) {
      continue;
    }
    const protocol = mapTypeToProtocol(toStringValue(item.type));
    const server = firstNonEmptyString(item.server, item.address);
    const port = toIntValue(item.port);
    if (!protocol || server === "" || port <= 0) {
      continue;
    }
    const name = toStringValue(item.name) || `${protocol}-${server}:${port}`;
    const transport = firstNonEmptyString(item.network, item.obfs, item.type);
    const country = resolveNodeCountry(
      firstNonEmptyString(item.country, item.region, item.location),
      name,
    );
    const method = firstNonEmptyString(item.cipher, item.method, item.security);
    const rawConfig = buildRawConfig({
      schema: "wateray.node.v1",
      source: "clash",
      protocol,
      server,
      server_port: port,
      transport,
      uuid: toStringValue(item.uuid),
      alter_id: toIntValue(item.alterId),
      security: method,
      password: toStringValue(item.password),
      method,
      flow: toStringValue(item.flow),
      sni: toStringValue(item.servername),
      host: toStringValue(item.host),
      path: toStringValue(item.path),
      service_name: toStringValue(item.serviceName),
      tls: Boolean(toBooleanValue(item.tls)),
      country,
      display: {
        address: server,
        port,
        transport: normalizeDisplayTransport(protocol, transport),
        security: method,
        country,
      },
    });
    nodes.push(
      buildNode({
        groupId,
        suffix: `clash-${index}`,
        name,
        address: server,
        port,
        protocol,
        transport: normalizeDisplayTransport(protocol, transport),
        country,
        rawConfig,
      }),
    );
    index += 1;
  }
  return nodes;
}

function parseSingBoxJson(content: string, groupId: string): VpnNode[] {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(root) || !Array.isArray(root.outbounds)) {
    return [];
  }
  const nodes: VpnNode[] = [];
  let index = 0;
  for (const item of root.outbounds) {
    if (!isRecord(item)) {
      continue;
    }
    const protocol = mapTypeToProtocol(toStringValue(item.type));
    const server = firstNonEmptyString(item.server, item.address);
    const port = toIntValue(item.server_port) || toIntValue(item.port);
    if (!protocol || server === "" || port <= 0) {
      continue;
    }
    const name = toStringValue(item.tag) || `${protocol}-${server}:${port}`;
    const nestedTransport = isRecord(item.transport) ? item.transport : {};
    const transport = firstNonEmptyString(item.network, nestedTransport.type, item.type);
    const country = resolveNodeCountry(
      firstNonEmptyString(item.country, item.region, item.location),
      name,
    );
    const singboxOutbound = JSON.parse(JSON.stringify(item)) as UnknownRecord;
    if (toStringValue(singboxOutbound.tag) === "") {
      singboxOutbound.tag = name;
    }
    const rawConfig = buildRawConfig({
      schema: "wateray.node.v1",
      source: "singbox",
      singboxOutbound,
      protocol,
      server,
      server_port: port,
      country,
      display: {
        address: server,
        port,
        transport: normalizeDisplayTransport(protocol, transport),
        security: toStringValue(item.security),
        country,
      },
    });
    nodes.push(
      buildNode({
        groupId,
        suffix: `sb-${index}`,
        name,
        address: server,
        port,
        protocol,
        transport: normalizeDisplayTransport(protocol, transport),
        country,
        rawConfig,
      }),
    );
    index += 1;
  }
  return nodes;
}

function normalizeHeaderValue(raw: string): string {
  let value = raw.trim();
  if (value === "") {
    return "";
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.trim() !== "") {
      value = decoded.trim();
    }
  } catch {
    // Ignore malformed encoding.
  }
  const decodedBase64 = decodeBase64String(value);
  if (decodedBase64.trim() !== "" && /[\u0020-\u007e\u4e00-\u9fff]/.test(decodedBase64)) {
    value = decodedBase64.trim();
  }
  return value.trim();
}

function extractSubscriptionStatusParts(text: string): { traffic: string; date: string } {
  const normalized = text.replace(/[｜|]/g, "/");
  const traffic = normalized.match(subscriptionTrafficPattern)?.[0]?.replace(/\s*\/\s*/g, "/").trim() || "";
  const date = text.match(subscriptionDatePattern)?.[0]?.trim() || "";
  return { traffic, date };
}

function composeSubscriptionStatus(traffic: string, date: string, fallback: string): string {
  const primary = [traffic.trim(), date.trim()].filter((item) => item !== "").join(" ");
  return primary || fallback.trim();
}

function isLikelyStatusText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }
  if (subscriptionStatusKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }
  const parts = extractSubscriptionStatusParts(value);
  return parts.traffic !== "" || parts.date !== "";
}

function parseSubscriptionStatus(content: string): string {
  const candidates = [content];
  const decodedContent = decodeBase64String(content);
  if (decodedContent.trim() !== "") {
    candidates.push(decodedContent);
  }
  let traffic = "";
  let date = "";
  let fallback = "";
  for (const candidate of candidates) {
    for (const rawLine of splitLines(candidate)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("//")) {
        continue;
      }
      let valueText = line;
      let hasStatusKey = false;
      const separatorIndex = line.includes("=")
        ? line.indexOf("=")
        : line.includes(":")
          ? line.indexOf(":")
          : -1;
      if (separatorIndex > 0) {
        const key = line.slice(0, separatorIndex).trim().toLowerCase();
        valueText = normalizeHeaderValue(line.slice(separatorIndex + 1));
        hasStatusKey = key === "status" || key === "remarks";
      }
      if (valueText === "") {
        continue;
      }
      const parts = extractSubscriptionStatusParts(valueText);
      if (traffic === "" && parts.traffic !== "") {
        traffic = parts.traffic;
      }
      if (date === "" && parts.date !== "") {
        date = parts.date;
      }
      if (fallback === "" && (hasStatusKey || isLikelyStatusText(valueText))) {
        fallback = valueText;
      }
      if (traffic !== "" && date !== "") {
        return composeSubscriptionStatus(traffic, date, fallback);
      }
    }
  }
  return composeSubscriptionStatus(traffic, date, fallback);
}

function isStatusPseudoNodeName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }
  if (subscriptionStatusKeywords.some((keyword) => normalized.includes(keyword))) {
    return true;
  }
  const parts = extractSubscriptionStatusParts(name);
  return parts.traffic !== "" || parts.date !== "";
}

function filterStatusPseudoNodes(nodes: VpnNode[], status: string): ParsedSubscriptionResult {
  let nextStatus = status.trim();
  const filtered = nodes.filter((node) => {
    if (!isStatusPseudoNodeName(node.name)) {
      return true;
    }
    if (nextStatus === "") {
      nextStatus = parseSubscriptionStatus(node.name);
    }
    return false;
  });
  return {
    nodes: filtered.length > 0 ? filtered : nodes,
    status: nextStatus,
  };
}

export function parseSubscriptionText(content: string, groupId: string): ParsedSubscriptionResult {
  const text = content.replace(/^\uFEFF/, "").trim();
  if (text === "") {
    throw new Error("订阅内容为空");
  }
  let nodes = parseSingBoxJson(text, groupId);
  if (nodes.length === 0) {
    nodes = parseClashYaml(text, groupId);
  }
  if (nodes.length === 0) {
    nodes = parseUriLines(text, groupId);
  }
  if (nodes.length === 0) {
    throw new Error("未解析到可用节点");
  }
  return filterStatusPseudoNodes(nodes, parseSubscriptionStatus(text));
}
