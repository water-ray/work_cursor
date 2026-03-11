import {
  Alert,
  Button,
  Card,
  Divider,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import type {
  DNSConfig,
  DNSHealthReport,
  DNSResolverEndpoint,
  DNSResolverType,
  DNSRuleServer,
  DNSStrategy,
} from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { BiIcon } from "../../components/icons/BiIcon";
import { DraftActionBar } from "../../components/draft/DraftActionBar";
import { HelpLabel } from "../../components/form/HelpLabel";
import { SwitchWithLabel } from "../../components/form/SwitchWithLabel";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../hooks/useDraftNotice";
import { daemonApi } from "../../services/daemonApi";

type DNSResolverRole = "remote" | "direct" | "bootstrap";
type ResolverDetour = "direct" | "proxy";

interface DNSResolverServerPreset {
  label: string;
  address: string;
  port: number;
  path?: string;
}

const defaultDNSFakeIPV4Range = "10.128.0.0/9";
const defaultDNSFakeIPV6Range = "fc00::/18";
const defaultHealthDomain = "www.gstatic.com";
const defaultHealthTimeoutMS = 5000;
const defaultCustomHostsPlaceholder = [
  "127.0.0.1 localhost",
  "192.168.1.10 nas.local",
  "8.8.8.8 dns.google",
].join("\n");

const resolverTypeOptions: Array<{ label: string; value: DNSResolverType }> = [
  { label: "UDP", value: "udp" },
  { label: "HTTPS", value: "https" },
  { label: "TCP", value: "tcp" },
  { label: "TLS", value: "tls" },
  { label: "DHCP", value: "dhcp" },
  { label: "系统本地", value: "local" },
  { label: "系统(Linux)", value: "resolved" },
];

const dnsStrategyOptions: Array<{ value: DNSStrategy; label: string }> = [
  { value: "prefer_ipv4", label: "优先 IPv4" },
  { value: "prefer_ipv6", label: "优先 IPv6" },
  { value: "ipv4_only", label: "仅 IPv4" },
  { value: "ipv6_only", label: "仅 IPv6" },
];

const dnsFinalServerOptions: Array<{ value: DNSRuleServer; label: string }> = [
  { value: "remote", label: "默认走远程 DNS" },
  { value: "direct", label: "默认走直连 DNS" },
  { value: "bootstrap", label: "默认走 Bootstrap DNS" },
];

const resolverRoleHelpContent: Record<
  DNSResolverRole,
  { scene: string; effect: string; caution: string; recommendation: string }
> = {
  remote: {
    scene: "代理链路主解析器。",
    effect: "承载默认远程解析请求。",
    caution: "常配合 解析策略->默认服务器=默认远程DNS 使用。",
    recommendation: "使用代理+国外 DNS 解析服务器。",
  },
  direct: {
    scene: "直连链路解析。",
    effect: "用于局域网/国内域名等直连解析兜底。",
    caution: "建议保持稳定、低延迟的本地可达 DNS。",
    recommendation: "使用直连+国内 DNS 解析服务器。",
  },
  bootstrap: {
    scene: "上游 DNS 目标是域名时的前置解析。",
    effect: "先把上游 DNS 域名解析成 IP（如将 dns.google 解析成 8.8.8.8）。",
    caution: "不能使用域名地址服务器（如 dns.google）。",
    recommendation: "使用国内 IP 地址 DNS 解析服务器。",
  },
};

const resolverPresetMap: Partial<Record<DNSResolverType, DNSResolverServerPreset[]>> = {
  udp: [
    { label: "Google DNS 8.8.8.8", address: "8.8.8.8", port: 53 },
    { label: "阿里云 DNS 223.5.5.5", address: "223.5.5.5", port: 53 },
    { label: "阿里云 DNS 223.6.6.6", address: "223.6.6.6", port: 53 },
    { label: "腾讯 DNS 119.29.29.29", address: "119.29.29.29", port: 53 },
    { label: "114DNS 114.114.114.114", address: "114.114.114.114", port: 53 },
    { label: "百度 DNS 180.76.76.76", address: "180.76.76.76", port: 53 },
    { label: "360 DNS 101.226.4.6", address: "101.226.4.6", port: 53 },
    { label: "Quad9 9.9.9.9", address: "9.9.9.9", port: 53 },
    { label: "AdGuard 94.140.14.14", address: "94.140.14.14", port: 53 },
    { label: "Cloudflare 1.1.1.1", address: "1.1.1.1", port: 53 },
    
  ],
  tcp: [
    { label: "Google DNS 8.8.8.8", address: "8.8.8.8", port: 53 },
    { label: "阿里云 DNS 223.5.5.5", address: "223.5.5.5", port: 53 },
    { label: "腾讯 DNS 119.29.29.29", address: "119.29.29.29", port: 53 },
    { label: "114DNS 114.114.114.114", address: "114.114.114.114", port: 53 },
    { label: "百度 DNS 180.76.76.76", address: "180.76.76.76", port: 53 },
    { label: "360 DNS 101.226.4.6", address: "101.226.4.6", port: 53 },
    { label: "Quad9 9.9.9.9", address: "9.9.9.9", port: 53 },
    { label: "AdGuard 94.140.14.14", address: "94.140.14.14", port: 53 },
    { label: "Cloudflare 1.1.1.1", address: "1.1.1.1", port: 53 },
    
  ],
  tls: [
    { label: "Google dns.google:853", address: "dns.google", port: 853 },
    { label: "阿里云 dns.alidns.com:853", address: "dns.alidns.com", port: 853 },
    { label: "Cloudflare 1.1.1.1:853", address: "1.1.1.1", port: 853 },
    
    { label: "Quad9 dns.quad9.net:853", address: "dns.quad9.net", port: 853 },
    { label: "Yandex common.dot.dns.yandex.net:853", address: "common.dot.dns.yandex.net", port: 853 },
    { label: "AdGuard dns.adguard-dns.com:853", address: "dns.adguard-dns.com", port: 853 },
  ],
  quic: [
    { label: "Google dns.google:853", address: "dns.google", port: 853 },
    { label: "Cloudflare 1.1.1.1:853", address: "1.1.1.1", port: 853 },
    
    { label: "AdGuard dns.adguard-dns.com:853", address: "dns.adguard-dns.com", port: 853 },
  ],
  https: [
    { label: "Google dns.google/dns-query", address: "dns.google", port: 443, path: "/dns-query" },
    { label: "阿里云 dns.alidns.com/dns-query", address: "dns.alidns.com", port: 443, path: "/dns-query" },
    { label: "Cloudflare cloudflare-dns.com/dns-query", address: "cloudflare-dns.com", port: 443, path: "/dns-query" },
   
    { label: "腾讯 doh.pub/dns-query", address: "doh.pub", port: 443, path: "/dns-query" },
    { label: "114DNS doh.114dns.com/dns-query", address: "doh.114dns.com", port: 443, path: "/dns-query" },
    { label: "百度 mirror2.pcloud.baidu.com/dns-query", address: "mirror2.pcloud.baidu.com", port: 443, path: "/dns-query" },
    { label: "360 doh.360.cn/dns-query", address: "doh.360.cn", port: 443, path: "/dns-query" },
    { label: "Quad9 dns.quad9.net/dns-query", address: "dns.quad9.net", port: 443, path: "/dns-query" },
    { label: "AdGuard dns.adguard.com/dns-query", address: "dns.adguard.com", port: 443, path: "/dns-query" },
    { label: "Yandex common.dot.dns.yandex.net/dns-query", address: "common.dot.dns.yandex.net", port: 443, path: "/dns-query" },
  ],
  h3: [
    { label: "Google dns.google/dns-query", address: "dns.google", port: 443, path: "/dns-query" },
    { label: "阿里云 dns.alidns.com/dns-query", address: "dns.alidns.com", port: 443, path: "/dns-query" },
    { label: "Cloudflare cloudflare-dns.com/dns-query", address: "cloudflare-dns.com", port: 443, path: "/dns-query" },
    
    { label: "AdGuard dns.adguard-dns.com/dns-query", address: "dns.adguard-dns.com", port: 443, path: "/dns-query" },
  ],
};

function isSystemResolverType(type: DNSResolverType): boolean {
  return type === "local" || type === "resolved" || type === "dhcp";
}

function isDoHResolverType(type: DNSResolverType): boolean {
  return type === "https" || type === "h3";
}

function normalizeResolverType(type: DNSResolverType): DNSResolverType {
  if (type === "h3") {
    return "https";
  }
  if (type === "quic") {
    return "tls";
  }
  if (type === "hosts") {
    return "local";
  }
  return type;
}

function normalizePresetPath(type: DNSResolverType, path?: string): string {
  if (!isDoHResolverType(type)) {
    return "";
  }
  const trimmed = path?.trim() ?? "";
  return trimmed === "" ? "/dns-query" : trimmed;
}

function encodeResolverPreset(type: DNSResolverType, preset: DNSResolverServerPreset): string {
  return JSON.stringify({
    address: preset.address.trim(),
    port: preset.port,
    path: normalizePresetPath(type, preset.path),
  });
}

function decodeResolverPreset(value: string): DNSResolverServerPreset | null {
  try {
    const parsed = JSON.parse(value) as {
      address?: string;
      port?: number;
      path?: string;
    };
    const address = parsed.address?.trim() ?? "";
    const port = Number(parsed.port ?? 0);
    if (address === "" || port <= 0) {
      return null;
    }
    return {
      label: "",
      address,
      port,
      path: parsed.path?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

function getResolverPresets(type: DNSResolverType): DNSResolverServerPreset[] {
  return resolverPresetMap[type] ?? [];
}

function getCurrentResolverPreset(
  endpoint: DNSResolverEndpoint,
  type: DNSResolverType,
): DNSResolverServerPreset | null {
  if (isSystemResolverType(type)) {
    return null;
  }
  const address = endpoint.address?.trim() ?? "";
  const port = Number(endpoint.port ?? 0);
  if (address === "" || port <= 0) {
    return null;
  }
  return {
    label: "",
    address,
    port,
    path: normalizePresetPath(type, endpoint.path),
  };
}

function formatResolverPresetLabel(type: DNSResolverType, preset: DNSResolverServerPreset): string {
  const path = normalizePresetPath(type, preset.path);
  if (isDoHResolverType(type)) {
    return `${preset.address}:${preset.port}${path}`;
  }
  return `${preset.address}:${preset.port}`;
}

function buildResolverPresetOptions(
  type: DNSResolverType,
  endpoint: DNSResolverEndpoint,
): Array<{ label: string; value: string }> {
  if (isSystemResolverType(type)) {
    return [];
  }
  const options = getResolverPresets(type).map((item) => ({
    label: item.label,
    value: encodeResolverPreset(type, item),
  }));
  const current = getCurrentResolverPreset(endpoint, type);
  if (!current) {
    return options;
  }
  const currentValue = encodeResolverPreset(type, current);
  if (!options.some((item) => item.value === currentValue)) {
    return [
      {
        label: `自定义 ${formatResolverPresetLabel(type, current)}`,
        value: currentValue,
      },
      ...options,
    ];
  }
  return options;
}

function cloneDNSConfig(config: DNSConfig): DNSConfig {
  return JSON.parse(JSON.stringify(config)) as DNSConfig;
}

function buildDefaultDNSConfig(): DNSConfig {
  return {
    version: 2,
    remote: { type: "https", address: "dns.google", port: 443, path: "/dns-query", detour: "proxy" },
    direct: { type: "https", address: "dns.alidns.com", port: 443, path: "/dns-query", detour: "direct" },
    bootstrap: { type: "udp", address: "114.114.114.114", port: 53, detour: "direct" },
    policy: { strategy: "prefer_ipv4", final: "remote" },
    cache: { independentCache: false, capacity: 16384, fileEnabled: false, storeRDRC: false },
    fakeip: { enabled: true, ipv4Range: defaultDNSFakeIPV4Range, ipv6Range: defaultDNSFakeIPV6Range },
    hosts: { useSystemHosts: false, useCustomHosts: false, customHosts: "" },
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
}

function isValidIPv4CIDR(value: string): boolean {
  const matched = value.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!matched) {
    return false;
  }
  const [ip, prefixRaw] = value.split("/");
  const octets = ip.split(".").map((item) => Number(item));
  if (octets.some((item) => Number.isNaN(item) || item < 0 || item > 255)) {
    return false;
  }
  const prefix = Number(prefixRaw);
  return prefix >= 0 && prefix <= 32;
}

function isValidIPv6CIDR(value: string): boolean {
  const matched = value.match(/^[0-9a-fA-F:]+\/(\d{1,3})$/);
  if (!matched) {
    return false;
  }
  const prefix = Number(matched[1]);
  return prefix >= 0 && prefix <= 128;
}

function isValidHostOrIP(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || /\s/.test(trimmed)) {
    return false;
  }
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(trimmed)) {
    const octets = trimmed.split(".").map((item) => Number(item));
    return octets.every((item) => item >= 0 && item <= 255);
  }
  const ipv6 = /^[0-9a-fA-F:]+$/;
  if (trimmed.includes(":") && ipv6.test(trimmed)) {
    return true;
  }
  const host = /^(?=.{1,253}$)(?!-)([a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9-]{1,63}$/;
  return host.test(trimmed);
}

function normalizeHostsText(value?: string): string {
  const normalized = (value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.trim();
}

function isValidIPAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(trimmed)) {
    const octets = trimmed.split(".").map((item) => Number(item));
    return octets.every((item) => item >= 0 && item <= 255);
  }
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return trimmed.includes(":") && ipv6.test(trimmed);
}

function validateCustomHostsText(raw: string): string[] {
  const issues: string[] = [];
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index]?.trim() ?? "";
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const commentIndex = line.indexOf("#");
    if (commentIndex >= 0) {
      line = line.slice(0, commentIndex).trim();
      if (line === "") {
        continue;
      }
    }
    const parts = line.split(/\s+/).filter((item) => item !== "");
    if (parts.length < 2) {
      issues.push(`自定义 hosts 第 ${lineNumber} 行格式错误，需为“IP 域名...”`);
      continue;
    }
    const ip = parts[0] ?? "";
    if (!isValidIPAddress(ip)) {
      issues.push(`自定义 hosts 第 ${lineNumber} 行 IP 非法: ${ip}`);
      continue;
    }
    for (let hostIndex = 1; hostIndex < parts.length; hostIndex += 1) {
      const host = (parts[hostIndex] ?? "").trim();
      if (host === "" || /\s|#/.test(host)) {
        issues.push(`自定义 hosts 第 ${lineNumber} 行主机名非法: ${host}`);
        break;
      }
    }
  }
  return issues;
}

function sanitizeEndpoint(endpoint: DNSResolverEndpoint): DNSResolverEndpoint {
  const normalizedType = normalizeResolverType(endpoint.type);
  const isSystemResolver = isSystemResolverType(normalizedType);
  return {
    ...endpoint,
    type: normalizedType,
    address: isSystemResolver ? "" : endpoint.address?.trim() ?? "",
    path: isSystemResolver ? "" : normalizePresetPath(normalizedType, endpoint.path),
    interface: endpoint.interface?.trim() ?? "",
    port: isSystemResolver ? 0 : endpoint.port ?? 0,
  };
}

function sanitizeConfig(input: DNSConfig): DNSConfig {
  const hosts = input.hosts ?? {
    useSystemHosts: true,
    useCustomHosts: false,
    customHosts: "",
  };
  return {
    ...input,
    version: Math.max(2, Number(input.version ?? 2)),
    remote: sanitizeEndpoint(input.remote),
    direct: sanitizeEndpoint(input.direct),
    bootstrap: sanitizeEndpoint(input.bootstrap),
    policy: {
      ...input.policy,
      clientSubnet: input.policy.clientSubnet?.trim() ?? "",
    },
    cache: {
      ...input.cache,
      capacity: Number(input.cache.capacity ?? 0),
      storeRDRC: input.cache.fileEnabled ? input.cache.storeRDRC : false,
    },
    fakeip: {
      ...input.fakeip,
      ipv4Range: input.fakeip.ipv4Range.trim(),
      ipv6Range: input.fakeip.ipv6Range.trim(),
    },
    hosts: {
      useSystemHosts: Boolean(hosts.useSystemHosts),
      useCustomHosts: Boolean(hosts.useCustomHosts),
      customHosts: normalizeHostsText(hosts.customHosts),
    },
    rules: input.rules.map((rule) => ({
      ...rule,
      id: rule.id.trim(),
      domain: rule.domain?.map((item) => item.trim()).filter((item) => item !== ""),
      domainSuffix: rule.domainSuffix?.map((item) => item.trim()).filter((item) => item !== ""),
      domainKeyword: rule.domainKeyword?.map((item) => item.trim()).filter((item) => item !== ""),
      domainRegex: rule.domainRegex?.map((item) => item.trim()).filter((item) => item !== ""),
      queryType: rule.queryType?.map((item) => item.trim()).filter((item) => item !== ""),
      outbound: rule.outbound?.map((item) => item.trim()).filter((item) => item !== ""),
      clientSubnet: rule.clientSubnet?.trim() ?? "",
    })),
  };
}

function validateEndpoint(role: DNSResolverRole, endpoint: DNSResolverEndpoint): string[] {
  const issues: string[] = [];
  const type = endpoint.type;
  if (type === "local" || type === "resolved" || type === "hosts" || type === "dhcp") {
    return issues;
  }
  const address = endpoint.address?.trim() ?? "";
  const port = endpoint.port ?? 0;
  if (!isValidHostOrIP(address)) {
    issues.push(`${role} DNS 地址格式不正确`);
  }
  if (port <= 0 || port > 65535) {
    issues.push(`${role} DNS 端口必须在 1-65535 之间`);
  }
  if ((type === "https" || type === "h3") && (endpoint.path?.trim() ?? "") !== "" && !(endpoint.path ?? "").startsWith("/")) {
    issues.push(`${role} DNS 的 DoH 路径必须以 "/" 开头`);
  }
  return issues;
}

function validateConfig(config: DNSConfig): string[] {
  const issues: string[] = [];
  issues.push(...validateEndpoint("remote", config.remote));
  issues.push(...validateEndpoint("direct", config.direct));
  issues.push(...validateEndpoint("bootstrap", config.bootstrap));
  if (config.hosts.useCustomHosts) {
    issues.push(...validateCustomHostsText(config.hosts.customHosts));
  }
  if (config.cache.capacity < 1024) {
    issues.push("DNS 缓存容量不能小于 1024");
  }
  if (config.fakeip.enabled) {
    if (!isValidIPv4CIDR(config.fakeip.ipv4Range)) {
      issues.push("FakeIP IPv4 范围不是合法 CIDR");
    }
    if (!isValidIPv6CIDR(config.fakeip.ipv6Range)) {
      issues.push("FakeIP IPv6 范围不是合法 CIDR");
    }
  }
  return issues;
}

function buildConflictHints(config: DNSConfig): string[] {
  const hints: string[] = [];
  if (config.policy.final === "remote" && config.remote.detour === "direct") {
    hints.push("默认 final=remote 但 remote.detour=direct，实际不会走代理链路。");
  }
  if (config.fakeip.enabled && config.policy.final === "direct") {
    hints.push("已启用 FakeIP 但 final=direct，可能导致分流行为与预期不一致。");
  }
  if (!config.cache.fileEnabled && config.cache.storeRDRC) {
    hints.push("已关闭缓存文件，storeRDRC 将不会生效。");
  }
  return hints;
}

function formatHealthReport(report: DNSHealthReport): string {
  const lines: string[] = [];
  lines.push(`检测域名: ${report.domain}`);
  lines.push(`检测超时: ${report.timeoutMs}ms`);
  lines.push(`总体状态: ${report.passed ? "通过" : "失败"}`);
  for (const item of report.results) {
    const ips = item.resolvedIp?.length ? item.resolvedIp.join(", ") : "-";
    lines.push(
      `[${item.target}] reachable=${item.reachable ? "yes" : "no"} latency=${item.latencyMs}ms ips=${ips}${item.error ? ` error=${item.error}` : ""}`,
    );
  }
  return lines.join("\n");
}

export function DnsPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const [dnsConfig, setDnsConfig] = useState<DNSConfig>(() => buildDefaultDNSConfig());
  const [dnsDirty, setDnsDirty] = useState(false);
  const [applyingDNS, setApplyingDNS] = useState(false);
  const [clearingDNSCache, setClearingDNSCache] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [healthDomain, setHealthDomain] = useState(defaultHealthDomain);
  const [healthTimeoutMS, setHealthTimeoutMS] = useState(defaultHealthTimeoutMS);
  const [healthReportText, setHealthReportText] = useState("");
  useDraftNavLock({
    lockClassName: "dns-draft-nav-lock",
    enabled: dnsDirty,
  });

  useEffect(() => {
    if (!snapshot?.dns || dnsDirty) {
      return;
    }
    setDnsConfig(sanitizeConfig(cloneDNSConfig(snapshot.dns)));
  }, [snapshot, dnsDirty]);

  const validationIssues = useMemo(() => validateConfig(sanitizeConfig(dnsConfig)), [dnsConfig]);
  const conflictHints = useMemo(() => buildConflictHints(sanitizeConfig(dnsConfig)), [dnsConfig]);
  const canSubmitDNSDraft = dnsDirty && validationIssues.length === 0 && !applyingDNS;
  const canRevertDNSDraft = dnsDirty && !applyingDNS;

  const updateEndpoint = (role: DNSResolverRole, patch: Partial<DNSResolverEndpoint>) => {
    setDnsConfig((current) => ({
      ...current,
      [role]: {
        ...current[role],
        ...patch,
      },
    }));
    setDnsDirty(true);
  };

  const updateEndpointResolverType = (role: DNSResolverRole, type: DNSResolverType) => {
    if (isSystemResolverType(type)) {
      updateEndpoint(role, {
        type,
        address: "",
        port: 0,
        path: "",
      });
      return;
    }
    const firstPreset = getResolverPresets(type)[0];
    updateEndpoint(role, {
      type,
      address: firstPreset?.address ?? "",
      port: firstPreset?.port ?? 0,
      path: normalizePresetPath(type, firstPreset?.path),
    });
  };

  const submitDNSDraft = async () => {
    const nextConfig = sanitizeConfig(dnsConfig);
    const issues = validateConfig(nextConfig);
    if (issues.length > 0) {
      notice.error(issues[0]);
      return;
    }
    setApplyingDNS(true);
    try {
      const nextSnapshot = await runAction(() =>
        daemonApi.setSettings({
          dns: nextConfig,
        }),
      );
      setDnsDirty(false);
      draftNotice.notifySaveSuccess("DNS 配置", nextSnapshot);
    } catch (error) {
      draftNotice.notifySaveFailed("DNS 配置", error);
    } finally {
      setApplyingDNS(false);
    }
  };

  const revertDNSDraft = () => {
    if (!snapshot || !dnsDirty) {
      return;
    }
    setDnsConfig(sanitizeConfig(cloneDNSConfig(snapshot.dns)));
    setDnsDirty(false);
    draftNotice.notifyDraftReverted("DNS");
  };

  const checkDNSHealth = async () => {
    const domain = healthDomain.trim();
    if (domain === "") {
      notice.warning("请填写检测域名");
      return;
    }
    const timeoutMs = Number(healthTimeoutMS);
    if (timeoutMs < 500 || timeoutMs > 20000) {
      notice.warning("检测超时必须在 500-20000ms 之间");
      return;
    }
    setCheckingHealth(true);
    try {
      const result = await daemonApi.checkDNSHealth({
        domain,
        timeoutMs,
      });
      await runAction(() => Promise.resolve(result.snapshot));
      setHealthReportText(formatHealthReport(result.report));
      if (result.error) {
        notice.warning(result.error);
      } else {
        notice.success("DNS 健康检查通过");
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "DNS 健康检查失败");
    } finally {
      setCheckingHealth(false);
    }
  };

  const clearDNSCache = async () => {
    setClearingDNSCache(true);
    try {
      await runAction(() => daemonApi.clearDNSCache());
      notice.success("DNS 缓存已清理");
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "清理 DNS 缓存失败");
    } finally {
      setClearingDNSCache(false);
    }
  };

  const renderEndpoint = (role: DNSResolverRole, title: string, endpoint: DNSResolverEndpoint) => {
    const isSystemResolver = isSystemResolverType(endpoint.type);
    const presetOptions = buildResolverPresetOptions(endpoint.type, endpoint);
    const currentPreset = getCurrentResolverPreset(endpoint, endpoint.type);
    const currentPresetValue =
      currentPreset == null ? undefined : encodeResolverPreset(endpoint.type, currentPreset);
    return (
      <Space
        direction="vertical"
        size={8}
        style={{ width: "100%" }}
      >
        <HelpLabel
          label={title}
          helpContent={resolverRoleHelpContent[role]}
        />
        <Space
          wrap
          size={8}
        >
          <Select<DNSResolverType>
            value={endpoint.type}
            options={resolverTypeOptions}
            style={{ width: 180 }}
            onChange={(value) => updateEndpointResolverType(role, value)}
          />
          <Select
            value={currentPresetValue}
            options={presetOptions}
            disabled={isSystemResolver || presetOptions.length === 0}
            style={{ width: 320 }}
            placeholder={isSystemResolver ? "系统解析类型无需上游服务器" : "请选择 DNS 服务器"}
            onChange={(value) => {
              const preset = decodeResolverPreset(value);
              if (!preset) {
                return;
              }
              updateEndpoint(role, {
                address: preset.address,
                port: preset.port,
                path: normalizePresetPath(endpoint.type, preset.path),
              });
            }}
          />
          <Select<"direct" | "proxy">
            value={(endpoint.detour as ResolverDetour) ?? "direct"}
            options={[
              { value: "direct", label: "直连" },
              { value: "proxy", label: "代理" },
            ]}
            style={{ width: 120 }}
            onChange={(value) => updateEndpoint(role, { detour: value })}
          />
        </Space>
      </Space>
    );
  };

  return (
    <Card loading={loading}>
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <Space
          align="center"
          style={{ width: "100%", justifyContent: "space-between" }}
        >
          <Typography.Text strong>DNS 配置</Typography.Text>
          <Button
            icon={<BiIcon name="trash3" />}
            loading={clearingDNSCache}
            disabled={loading || applyingDNS}
            onClick={() => {
              void clearDNSCache();
            }}
          >
            清理DNS缓存
          </Button>
        </Space>
        <DraftActionBar
          visible={dnsDirty}
          apply={{
            title: "保存修改",
            label: "保存",
            icon: <BiIcon name="check-lg" />,
            disabled: !canSubmitDNSDraft,
            loading: applyingDNS,
            onClick: () => {
              void submitDNSDraft();
            },
          }}
          discard={{
            title: "取消修改",
            label: "取消",
            icon: <BiIcon name="x-lg" />,
            disabled: !canRevertDNSDraft,
            onClick: () => {
              revertDNSDraft();
            },
          }}
        />

        {validationIssues.length > 0 ? (
          <Alert
            type="error"
            showIcon
            message={validationIssues[0]}
            description={validationIssues.slice(1).join("；")}
          />
        ) : null}
        {conflictHints.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message="检测到潜在配置冲突"
            description={conflictHints.join("；")}
          />
        ) : null}

        {renderEndpoint("remote", "远程 DNS", dnsConfig.remote)}
        {renderEndpoint("direct", "直连 DNS", dnsConfig.direct)}
        {renderEndpoint("bootstrap", "Bootstrap DNS", dnsConfig.bootstrap)}

        <HelpLabel
          label={<Typography.Text strong>Hosts 配置</Typography.Text>}
          helpContent={{
            scene: "在 DNS 网络查询前使用本地 hosts 覆盖。",
            effect: "命中 hosts 时直接返回映射，不再请求上游 DNS。",
            caution: "自定义 hosts 优先级高于系统 hosts。",
          }}
        />
        <Space
          wrap
          size={10}
        >
          <SwitchWithLabel
            checked={dnsConfig.hosts.useSystemHosts}
            onChange={(checked) => {
              setDnsConfig((current) => ({
                ...current,
                hosts: {
                  ...current.hosts,
                  useSystemHosts: checked,
                },
              }));
              setDnsDirty(true);
            }}
            label="使用系统 hosts 文件"
            helpContent={{
              effect: "DNS 查询前先匹配系统 hosts 记录（如 Windows/Linux 默认 hosts）。",
              recommendation: "适合保留系统层面的域名映射习惯；如需统一由客户端管理可关闭。",
            }}
          />
          <SwitchWithLabel
            checked={dnsConfig.hosts.useCustomHosts}
            onChange={(checked) => {
              setDnsConfig((current) => ({
                ...current,
                hosts: {
                  ...current.hosts,
                  useCustomHosts: checked,
                },
              }));
              setDnsDirty(true);
            }}
            label="使用自定义 hosts"
            helpContent={{
              effect: "DNS 查询前先匹配客户端自定义 hosts，优先级高于系统 hosts。",
              recommendation: "建议仅维护必要映射，避免与系统 hosts 或上游 DNS 规则冲突。",
            }}
          />
        </Space>
        {dnsConfig.hosts.useCustomHosts ? (
          <Space
            direction="vertical"
            size={8}
            style={{ width: "100%" }}
          >
            <HelpLabel
              label="自定义 hosts 记录"
              helpContent={{
                effect: "按系统 hosts 格式逐行覆盖域名解析（IP 域名 [别名...]）。",
                recommendation: "支持注释(#)；内容为空时可先参考下方示例模板。",
              }}
            />
            <Input.TextArea
              value={dnsConfig.hosts.customHosts}
              placeholder={defaultCustomHostsPlaceholder}
              autoSize={{ minRows: 6, maxRows: 16 }}
              onChange={(event) => {
                const value = event.target.value;
                setDnsConfig((current) => ({
                  ...current,
                  hosts: {
                    ...current.hosts,
                    customHosts: value,
                  },
                }));
                setDnsDirty(true);
              }}
            />
          </Space>
        ) : null}

        <HelpLabel
          label={<Typography.Text strong>解析策略</Typography.Text>}
          helpContent={{
            scene: "控制最终使用哪个 DNS 结果与地址偏好。",
            effect: "strategy 决定 IPv4/IPv6 取向，final 决定默认服务器。",
            caution: "final 与 detour 组合不当会导致解析不可达。",
          }}
        />
        <Space
          wrap
          size={8}
        >
          <HelpLabel
            label="地址策略"
            helpContent={{
              scene: "IPv4/IPv6 偏好控制。",
              effect: "影响返回记录类型与优先级。",
              caution: "若网络 IPv6 质量不佳，建议优先 IPv4。",
            }}
          />
          <Select<DNSStrategy>
            value={dnsConfig.policy.strategy}
            options={dnsStrategyOptions}
            style={{ width: 220 }}
            onChange={(value) => {
              setDnsConfig((current) => ({
                ...current,
                policy: {
                  ...current.policy,
                  strategy: value,
                },
              }));
              setDnsDirty(true);
            }}
          />
          <HelpLabel
            label="默认服务器"
            helpContent={{
              scene: "未命中 DNS 规则时的兜底服务器。",
              effect: "决定默认解析入口走 远程/直连/bootstrap。",
              caution: "建议结合 远程DNS+代理 关系验证可达性。",
            }}
          />
          <Select<DNSRuleServer>
            value={dnsConfig.policy.final}
            options={dnsFinalServerOptions}
            style={{ width: 220 }}
            onChange={(value) => {
              setDnsConfig((current) => ({
                ...current,
                policy: {
                  ...current.policy,
                  final: value,
                },
              }));
              setDnsDirty(true);
            }}
          />
        </Space>

        <HelpLabel
          label={<Typography.Text strong>高级设置</Typography.Text>}
          helpContent={{
            scene: "调优缓存与性能。",
            effect: "控制缓存隔离、容量与磁盘持久化。",
            caution: "容量过小会频繁回源，磁盘缓存开启后应关注磁盘占用。",
          }}
        />
        <Space
          wrap
          size={12}
        >
          <SwitchWithLabel
            checked={dnsConfig.cache.independentCache}
            onChange={(checked) => {
              setDnsConfig((current) => ({
                ...current,
                cache: { ...current.cache, independentCache: checked },
              }));
              setDnsDirty(true);
            }}
            label="独立缓存"
            helpContent={{
              scene: "希望不同链路使用独立缓存。",
              effect: "避免不同上游缓存互相污染。",
              caution: "开启后内存占用会增加。",
            }}
          />
          <HelpLabel
            label="缓存容量"
            helpContent={{
              scene: "控制 DNS 内存缓存上限。",
              effect: "容量越大，重复查询命中率越高。",
              caution: "建议 1024 以上，过大会增加内存占用。",
            }}
          />
          <InputNumber
            min={1024}
            max={65536}
            value={dnsConfig.cache.capacity}
            onChange={(value) => {
              setDnsConfig((current) => ({
                ...current,
                cache: { ...current.cache, capacity: Number(value ?? 1024) },
              }));
              setDnsDirty(true);
            }}
          />
          <SwitchWithLabel
            checked={dnsConfig.cache.fileEnabled}
            onChange={(checked) => {
              setDnsConfig((current) => ({
                ...current,
                cache: {
                  ...current.cache,
                  fileEnabled: checked,
                  storeRDRC: checked ? current.cache.storeRDRC : false,
                },
              }));
              setDnsDirty(true);
            }}
            label="缓存文件"
            helpContent={{
              scene: "希望重启后保留部分 DNS 缓存。",
              effect: "将缓存写入本地文件。",
              caution: "关闭时相关持久化项（如 RDRC）不会生效。",
            }}
          />
          <SwitchWithLabel
            checked={dnsConfig.cache.storeRDRC}
            disabled={!dnsConfig.cache.fileEnabled}
            onChange={(checked) => {
              setDnsConfig((current) => ({
                ...current,
                cache: { ...current.cache, storeRDRC: checked },
              }));
              setDnsDirty(true);
            }}
            label="Store RDRC"
            helpContent={{
              scene: "需要保存更多解析上下文信息。",
              effect: "增强重启后缓存恢复能力。",
              caution: "仅在“缓存文件”开启时生效。",
            }}
          />
        </Space>

        <Divider style={{ margin: 0 }} />

        <Space
          wrap
          size={8}
        >
          <SwitchWithLabel
            checked={dnsConfig.fakeip.enabled}
            onChange={(checked) => {
              setDnsConfig((current) => ({
                ...current,
                fakeip: { ...current.fakeip, enabled: checked },
              }));
              setDnsDirty(true);
            }}
            label="启用 FakeIP"
            helpContent={{
              scene: "需要增强基于域名的分流命中。",
              effect: "将 A/AAAA 查询映射到 FakeIP 段。",
              caution: "与某些局域网/特殊应用可能存在兼容性差异。",
            }}
          />
          <HelpLabel
            label="IPv4 CIDR"
            helpContent={{
              scene: "定义 FakeIP 的 IPv4 地址池。",
              effect: "用于分配虚拟地址承载域名映射。",
              caution: "必须为合法 CIDR，避免与现网地址段冲突。",
            }}
          />
          <Input
            value={dnsConfig.fakeip.ipv4Range}
            disabled={!dnsConfig.fakeip.enabled}
            style={{ width: 200 }}
            onChange={(event) => {
              setDnsConfig((current) => ({
                ...current,
                fakeip: { ...current.fakeip, ipv4Range: event.target.value },
              }));
              setDnsDirty(true);
            }}
          />
          <HelpLabel
            label="IPv6 CIDR"
            helpContent={{
              scene: "定义 FakeIP 的 IPv6 地址池。",
              effect: "为 IPv6 查询提供虚拟地址映射。",
              caution: "建议使用保留网段，避免和真实网络重叠。",
            }}
          />
          <Input
            value={dnsConfig.fakeip.ipv6Range}
            disabled={!dnsConfig.fakeip.enabled}
            style={{ width: 220 }}
            onChange={(event) => {
              setDnsConfig((current) => ({
                ...current,
                fakeip: { ...current.fakeip, ipv6Range: event.target.value },
              }));
              setDnsDirty(true);
            }}
          />
        </Space>

        <Divider style={{ margin: 0 }} />

        <HelpLabel
          label={<Typography.Text strong>DNS 健康检查</Typography.Text>}
          helpContent={{
            scene: "应用配置后快速验证可达性。",
            effect: "并行检测 remote/direct/bootstrap 三路解析结果与耗时。",
            caution: "若 remote detour=proxy，需先确认代理链路本身可用。",
          }}
        />
        <Space
          wrap
          size={8}
        >
          <HelpLabel
            label="检测域名"
            helpContent={{
              scene: "选择一个稳定域名做基准测试。",
              effect: "评估 DNS 请求是否可达且返回结果正常。",
              caution: "建议使用公共可达域名，如 www.gstatic.com。",
            }}
          />
          <Input
            value={healthDomain}
            style={{ width: 240 }}
            placeholder="检测域名"
            onChange={(event) => setHealthDomain(event.target.value)}
          />
          <HelpLabel
            label="检测超时(ms)"
            helpContent={{
              scene: "控制单次检测等待时间。",
              effect: "超时越小，失败判定越快。",
              caution: "建议 3000~8000ms，过小容易误判。",
            }}
          />
          <InputNumber
            min={500}
            max={20000}
            value={healthTimeoutMS}
            style={{ width: 140 }}
            onChange={(value) => setHealthTimeoutMS(Number(value ?? defaultHealthTimeoutMS))}
          />
          <Button
            loading={checkingHealth}
            onClick={() => void checkDNSHealth()}
          >
            一键健康检查
          </Button>
        </Space>
        {healthReportText !== "" ? (
          <Input.TextArea
            value={healthReportText}
            readOnly
            autoSize={{ minRows: 4, maxRows: 10 }}
          />
        ) : null}

      </Space>
    </Card>
  );
}
