import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type {
  DaemonSnapshot,
  DNSHealthCheckResult,
  DNSHealthReport,
  DNSResolverEndpoint,
} from "../../../shared/daemon";
import type { WaterayMobileHostApi } from "./mobileHost";
import {
  defaultMobileDnsHealthDirectSocksPort,
  defaultMobileDnsHealthProxySocksPort,
  materializeMobileDnsEndpoint,
  type MobileResolverContext,
} from "./mobileRuntimeConfig";

const defaultDnsHealthDomain = "www.baidu.com";
const defaultDnsHealthTimeoutMs = 5000;
const minDnsHealthTimeoutMs = 500;
const maxDnsHealthTimeoutMs = 20000;
const dnsTypeA = 1;
const dnsTypeAAAA = 28;

interface MobileDnsHealthRuntimeStatus {
  serviceRunning?: boolean;
  tunReady?: boolean;
}

function normalizeDnsHealthDomain(value: string | undefined): string {
  const domain = (value ?? "").trim();
  return domain === "" ? defaultDnsHealthDomain : domain;
}

function normalizeDnsHealthTimeoutMs(value: number | undefined): number {
  const timeoutMs = Math.trunc(Number(value ?? defaultDnsHealthTimeoutMs));
  if (!Number.isFinite(timeoutMs) || timeoutMs < minDnsHealthTimeoutMs || timeoutMs > maxDnsHealthTimeoutMs) {
    return defaultDnsHealthTimeoutMs;
  }
  return timeoutMs;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((item) => item.trim()).filter((item) => item !== "")),
  );
}

function toDnsLabelBytes(domain: string): number[] {
  const normalized = domain.trim().replace(/\.+$/, "");
  if (normalized === "") {
    throw new Error("domain is required");
  }
  const labels = normalized.split(".");
  const bytes: number[] = [];
  for (const label of labels) {
    const encoder = new TextEncoder();
    const encoded = Array.from(encoder.encode(label));
    if (encoded.length === 0 || encoded.length > 63) {
      throw new Error("invalid domain label for dns query");
    }
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return bytes;
}

function buildDnsQueryWire(domain: string, queryType: number): Uint8Array {
  const questionName = toDnsLabelBytes(domain);
  const wire = new Uint8Array(12 + questionName.length + 4);
  const view = new DataView(wire.buffer);
  view.setUint16(0, Date.now() & 0xffff);
  view.setUint16(2, 0x0100);
  view.setUint16(4, 1);
  let offset = 12;
  wire.set(questionName, offset);
  offset += questionName.length;
  view.setUint16(offset, queryType);
  view.setUint16(offset + 2, 1);
  return wire;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function skipDnsName(bytes: Uint8Array, startOffset: number): number {
  let offset = startOffset;
  let maxHops = bytes.length;
  while (offset < bytes.length && maxHops > 0) {
    maxHops -= 1;
    const length = bytes[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= bytes.length) {
        throw new Error("invalid compressed dns name");
      }
      return offset + 2;
    }
    if (length === 0) {
      return offset + 1;
    }
    offset += 1 + length;
  }
  throw new Error("invalid dns name");
}

function formatIpv6(bytes: Uint8Array, startOffset: number): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    const high = bytes[startOffset + index] ?? 0;
    const low = bytes[startOffset + index + 1] ?? 0;
    groups.push(((high << 8) | low).toString(16));
  }
  return groups.join(":");
}

function extractResolvedIps(responseBytes: Uint8Array): string[] {
  if (responseBytes.length < 12) {
    throw new Error("empty dns response");
  }
  const view = new DataView(
    responseBytes.buffer,
    responseBytes.byteOffset,
    responseBytes.byteLength,
  );
  const flags = view.getUint16(2);
  const rcode = flags & 0x000f;
  if (rcode !== 0) {
    throw new Error(`dns response rcode=${rcode}`);
  }
  const questionCount = view.getUint16(4);
  const answerCount = view.getUint16(6);
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    offset = skipDnsName(responseBytes, offset);
    offset += 4;
    if (offset > responseBytes.length) {
      throw new Error("invalid dns question section");
    }
  }
  const ips: string[] = [];
  for (let index = 0; index < answerCount; index += 1) {
    offset = skipDnsName(responseBytes, offset);
    if (offset + 10 > responseBytes.length) {
      throw new Error("invalid dns answer header");
    }
    const recordType = view.getUint16(offset);
    const rdLength = view.getUint16(offset + 8);
    const rdataOffset = offset + 10;
    if (rdataOffset + rdLength > responseBytes.length) {
      throw new Error("invalid dns answer body");
    }
    if (recordType === dnsTypeA && rdLength === 4) {
      ips.push(
        [
          responseBytes[rdataOffset],
          responseBytes[rdataOffset + 1],
          responseBytes[rdataOffset + 2],
          responseBytes[rdataOffset + 3],
        ].join("."),
      );
    } else if (recordType === dnsTypeAAAA && rdLength === 16) {
      ips.push(formatIpv6(responseBytes, rdataOffset));
    }
    offset = rdataOffset + rdLength;
  }
  return uniqueNonEmptyStrings(ips);
}

async function executeDohQuery(
  endpoint: DNSResolverEndpoint,
  domain: string,
  queryType: number,
  timeoutMs: number,
): Promise<string[]> {
  const address = (endpoint.address ?? "").trim();
  if (address === "") {
    throw new Error("dns resolver address is required");
  }
  const port = Number(endpoint.port ?? 443) > 0 ? Number(endpoint.port ?? 443) : 443;
  const path = endpoint.path?.trim() ? endpoint.path.trim() : "/dns-query";
  const queryBytes = buildDnsQueryWire(domain, queryType);
  const url = new URL(`https://${address}:${port}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("dns", bytesToBase64Url(queryBytes));
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort("dns health timeout"), timeoutMs);
  try {
    const response = await tauriFetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/dns-message",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const bodyText = (await response.text()).trim();
      throw new Error(
        `dns-over-https status=${response.status}${bodyText ? ` body=${bodyText}` : ""}`,
      );
    }
    const payload = new Uint8Array(await response.arrayBuffer());
    return extractResolvedIps(payload);
  } finally {
    window.clearTimeout(timer);
  }
}

async function resolveDnsOverHttps(
  endpoint: DNSResolverEndpoint,
  domain: string,
  timeoutMs: number,
): Promise<string[]> {
  const resolved = uniqueNonEmptyStrings([
    ...(await executeDohQuery(endpoint, domain, dnsTypeA, timeoutMs)),
    ...(await executeDohQuery(endpoint, domain, dnsTypeAAAA, timeoutMs)),
  ]);
  if (resolved.length === 0) {
    throw new Error("dns response contains no A/AAAA records");
  }
  return resolved;
}

function createUnsupportedResult(
  target: string,
  serverTag: string,
  endpoint: DNSResolverEndpoint,
  latencyMs: number,
  resolverContext: MobileResolverContext,
): DNSHealthCheckResult {
  if (endpoint.type === "local") {
    const systemDnsServers = Array.isArray(resolverContext.systemDnsServers)
      ? resolverContext.systemDnsServers.filter((item) => item.trim() !== "")
      : [];
    return {
      target,
      serverTag,
      reachable: false,
      latencyMs,
      error:
        systemDnsServers.length > 0
          ? `移动端当前会把 local 解析器展开为系统 DNS：${systemDnsServers.join(", ")}，但健康检查暂未支持 local/udp 实测`
          : "移动端当前未获取到系统 DNS，local 类型解析器不可用",
    };
  }
  return {
    target,
    serverTag,
    reachable: false,
    latencyMs,
    error: `移动端暂未支持 ${endpoint.type} 类型 DNS 健康检查`,
  };
}

function createHostUnavailableResult(
  target: string,
  serverTag: string,
  endpoint: DNSResolverEndpoint,
  latencyMs: number,
): DNSHealthCheckResult {
  return {
    target,
    serverTag,
    reachable: false,
    latencyMs,
    error: `移动端原生宿主暂未接入 ${endpoint.type} 类型 DNS 健康检查`,
  };
}

function createServiceInactiveResult(
  target: string,
  serverTag: string,
  latencyMs: number,
): DNSHealthCheckResult {
  return {
    target,
    serverTag,
    reachable: false,
    latencyMs,
    error: "移动端仅支持在 VPN 代理运行中检测 remote/direct DNS 链路；未启动时系统 DNS 由 Android 接管",
  };
}

function createActiveServiceUnsupportedResult(
  target: string,
  serverTag: string,
  endpoint: DNSResolverEndpoint,
  latencyMs: number,
): DNSHealthCheckResult {
  return {
    target,
    serverTag,
    reachable: false,
    latencyMs,
    error: `移动端暂未支持通过运行中的 VPN 服务验证 ${endpoint.type} 类型 DNS`,
  };
}

function shouldUseRunningServiceDns(
  serverTag: string,
  endpoint: DNSResolverEndpoint,
  hostStatus: MobileDnsHealthRuntimeStatus | undefined,
): boolean {
  if (serverTag === "bootstrap") {
    return false;
  }
  if (hostStatus?.serviceRunning !== true || hostStatus.tunReady !== true) {
    return false;
  }
  return endpoint.type === "https" || endpoint.type === "tcp" || endpoint.type === "tls";
}

function resolveServiceSocksPortWithContext(
  serverTag: string,
  endpoint: DNSResolverEndpoint,
  resolverContext: MobileResolverContext,
): number | undefined {
  const detour = String(endpoint.detour ?? "").trim().toLowerCase();
  const proxyPort = resolverContext.internalPorts?.dnsHealthProxySocksPort;
  const directPort = resolverContext.internalPorts?.dnsHealthDirectSocksPort;
  if (detour === "proxy") {
    return proxyPort ?? defaultMobileDnsHealthProxySocksPort;
  }
  if (detour === "direct") {
    return directPort ?? defaultMobileDnsHealthDirectSocksPort;
  }
  if (serverTag === "remote") {
    return proxyPort ?? defaultMobileDnsHealthProxySocksPort;
  }
  if (serverTag === "direct") {
    return directPort ?? defaultMobileDnsHealthDirectSocksPort;
  }
  return undefined;
}

async function resolveDnsViaNative(params: {
  endpoint: DNSResolverEndpoint;
  domain: string;
  timeoutMs: number;
  host: Pick<WaterayMobileHostApi, "dnsHealth">;
  viaService?: boolean;
  serviceSocksPort?: number;
}): Promise<{
  reachable: boolean;
  latencyMs: number;
  resolvedIp?: string[];
  error?: string | null;
}> {
  const { endpoint, domain, timeoutMs, host, viaService, serviceSocksPort } = params;
  return host.dnsHealth({
    type: endpoint.type,
    address: String(endpoint.address ?? "").trim(),
    port: Number(endpoint.port ?? 0) > 0 ? Number(endpoint.port ?? 0) : undefined,
    path: endpoint.path?.trim() || undefined,
    domain,
    viaService: viaService === true,
    serviceSocksPort:
      Number(serviceSocksPort ?? 0) > 0 ? Number(serviceSocksPort ?? 0) : undefined,
    timeoutMs,
  });
}

async function checkEndpoint(params: {
  target: string;
  serverTag: string;
  endpoint: DNSResolverEndpoint;
  domain: string;
  timeoutMs: number;
  resolverContext: MobileResolverContext;
  host?: Pick<WaterayMobileHostApi, "dnsHealth"> | null;
  hostStatus?: MobileDnsHealthRuntimeStatus;
}): Promise<DNSHealthCheckResult> {
  const startedAt = Date.now();
  const { target, serverTag, endpoint, domain, timeoutMs, resolverContext, host, hostStatus } = params;
  try {
    const resolvedEndpoint = materializeMobileDnsEndpoint(serverTag, endpoint, resolverContext);
    const shouldUseRunningService = shouldUseRunningServiceDns(serverTag, resolvedEndpoint, hostStatus);
    if (
      serverTag !== "bootstrap"
      && (hostStatus?.serviceRunning !== true || hostStatus.tunReady !== true)
    ) {
      return createServiceInactiveResult(
        target,
        serverTag,
        Math.max(0, Date.now() - startedAt),
      );
    }
    if (
      serverTag !== "bootstrap"
      && hostStatus?.serviceRunning === true
      && hostStatus.tunReady === true
      && !shouldUseRunningService
    ) {
      return createActiveServiceUnsupportedResult(
        target,
        serverTag,
        resolvedEndpoint,
        Math.max(0, Date.now() - startedAt),
      );
    }
    switch (resolvedEndpoint.type) {
      case "https": {
        if (host) {
          const result = await resolveDnsViaNative({
            endpoint: resolvedEndpoint,
            domain,
            timeoutMs,
            host,
            viaService: shouldUseRunningService,
            serviceSocksPort: resolveServiceSocksPortWithContext(
              serverTag,
              resolvedEndpoint,
              resolverContext,
            ),
          });
          return {
            target,
            serverTag,
            reachable: result.reachable,
            latencyMs: Math.max(0, Number(result.latencyMs ?? Date.now() - startedAt)),
            resolvedIp: Array.isArray(result.resolvedIp) ? result.resolvedIp : undefined,
            error: result.error ?? undefined,
          };
        }
        const resolvedIp = await resolveDnsOverHttps(resolvedEndpoint, domain, timeoutMs);
        return {
          target,
          serverTag,
          reachable: true,
          latencyMs: Math.max(0, Date.now() - startedAt),
          resolvedIp,
        };
      }
      case "udp":
      case "tcp":
      case "tls": {
        if (!host) {
          return createHostUnavailableResult(
            target,
            serverTag,
            resolvedEndpoint,
            Math.max(0, Date.now() - startedAt),
          );
        }
        const result = await resolveDnsViaNative({
          endpoint: resolvedEndpoint,
          domain,
          timeoutMs,
          host,
          viaService: shouldUseRunningService,
          serviceSocksPort: resolveServiceSocksPortWithContext(
            serverTag,
            resolvedEndpoint,
            resolverContext,
          ),
        });
        return {
          target,
          serverTag,
          reachable: result.reachable,
          latencyMs: Math.max(0, Number(result.latencyMs ?? Date.now() - startedAt)),
          resolvedIp: Array.isArray(result.resolvedIp) ? result.resolvedIp : undefined,
          error: result.error ?? undefined,
        };
      }
      default:
        return createUnsupportedResult(
          target,
          serverTag,
          resolvedEndpoint,
          Math.max(0, Date.now() - startedAt),
          resolverContext,
        );
    }
  } catch (error) {
    return {
      target,
      serverTag,
      reachable: false,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error: error instanceof Error ? error.message : "dns health check failed",
    };
  }
}

export async function checkMobileDnsHealth(
  snapshot: DaemonSnapshot,
  input?: {
    domain?: string;
    timeoutMs?: number;
  },
  resolverContext: MobileResolverContext = {},
  host?: Pick<WaterayMobileHostApi, "dnsHealth"> | null,
  hostStatus?: MobileDnsHealthRuntimeStatus,
): Promise<{
  report: DNSHealthReport;
  error?: string;
}> {
  const domain = normalizeDnsHealthDomain(input?.domain);
  const timeoutMs = normalizeDnsHealthTimeoutMs(input?.timeoutMs);
  const results = await Promise.all([
    checkEndpoint({
      target: "remote",
      serverTag: "remote",
      endpoint: snapshot.dns.remote,
      domain,
      timeoutMs,
      resolverContext,
      host,
      hostStatus,
    }),
    checkEndpoint({
      target: "direct",
      serverTag: "direct",
      endpoint: snapshot.dns.direct,
      domain,
      timeoutMs,
      resolverContext,
      host,
      hostStatus,
    }),
    checkEndpoint({
      target: "bootstrap",
      serverTag: "bootstrap",
      endpoint: snapshot.dns.bootstrap,
      domain,
      timeoutMs,
      resolverContext,
      host,
      hostStatus,
    }),
  ]);
  const passed = results.every((item) => item.reachable);
  const unsupportedTargets = results
    .filter((item) => (item.error ?? "").includes("暂未支持"))
    .map((item) => item.target);
  const firstFailure = results.find((item) => !item.reachable && (item.error ?? "").trim() !== "");
  return {
    report: {
      domain,
      timeoutMs,
      checkedAtMs: Date.now(),
      passed,
      results,
    },
    error: passed
      ? undefined
      : unsupportedTargets.length > 0
        ? `移动端 DNS 健康检查暂未完全覆盖当前 resolver 类型：${unsupportedTargets.join(", ")}`
        : firstFailure?.error ?? "dns health check failed",
  };
}
