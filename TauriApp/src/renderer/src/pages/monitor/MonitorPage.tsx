import {
  AutoComplete,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Pagination,
  Radio,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TableRowSelection } from "antd/es/table/interface";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DaemonPageProps } from "../../app/types";
import { HelpLabel } from "../../components/form/HelpLabel";
import { SwitchWithLabel } from "../../components/form/SwitchWithLabel";
import { BiIcon } from "../../components/icons/BiIcon";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { daemonApi } from "../../services/daemonApi";
import type {
  CreateRequestMonitorSessionRequestPayload,
  RequestMonitorRecord as ApiRequestMonitorRecord,
  RequestMonitorScope,
  RequestMonitorSessionSummary as ApiRequestMonitorSessionSummary,
} from "../../../../shared/daemon";

type FilterJoinMode = "and" | "or";
type RulePreviewKind = "process" | "domain" | "ip";
type ProcessRuleContentMode = "name" | "path";
type DomainRuleContentMode = "exact" | "suffix" | "keyword" | "regex";
type IpRuleContentMode = "ip" | "cidr";
type DuplicateFilterMode = "off" | "latest";
type RequestMonitorRefreshOptions = {
  silent?: boolean;
  suppressError?: boolean;
};

interface RequestMonitorRecord {
  id: string;
  timestampMs: number;
  processName: string;
  processPath: string;
  pid: number;
  domain: string;
  destinationIp: string;
  destinationPort: number;
  network: string;
  protocol: string;
  inboundTag: string;
  recordScope: RequestMonitorScope;
  ruleMissed: boolean;
  matchedRule: string;
  outboundTag: string;
  suggestedRule: string;
  country: string;
  uploadBytes: number;
  downloadBytes: number;
  tags: string[];
}

interface RequestMonitorSession {
  id: string;
  fileName: string;
  fileBaseName: string;
  durationSec: number;
  recordScope: RequestMonitorScope;
  createdAtMs: number;
  completedAtMs: number;
  requestCount: number;
  running: boolean;
  lastError: string;
  records: RequestMonitorRecord[];
}

const monitorDurationOptions = [10, 30, 60, 120];
const monitorPageSize = 12;
const monitorTableMaxHeightPx = 470;
const filterKeyPresets = [
  "process:",
  "pid:",
  "domain:",
  "ip:",
  "port:",
  "protocol:",
  "inbound:",
  "scope:",
  "result:",
  "matched:",
  "outbound:",
  "rule:",
  "country:",
];

function normalizeInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function normalizeMonitorRecordScope(raw: string | undefined): RequestMonitorScope {
  return String(raw ?? "").trim().toLowerCase() === "miss_only" ? "miss_only" : "all";
}

function buildDefaultMonitorFileBaseName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") +
    "_" +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("-")
  );
}

function sanitizeMonitorFileBaseName(value: string): string {
  return value.replace(/\.json$/i, "").replace(/[\\/:*?"<>|]/g, "-").trim();
}

function deriveProcessNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (normalized === "") {
    return "";
  }
  const segments = normalized.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function formatRecordScopeLabel(scope: RequestMonitorScope): string {
  return scope === "miss_only" ? "仅漏网之鱼" : "全部请求";
}

function formatMonitorResultLabel(ruleMissed: boolean): string {
  return ruleMissed ? "漏网之鱼" : "规则命中";
}

function formatCompactTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatCountdownDuration(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function resolveMonitorSessionRemainingMs(session: RequestMonitorSession | null, nowMs: number): number | null {
  if (session == null || !session.running || session.createdAtMs <= 0 || session.durationSec <= 0) {
    return null;
  }
  const deadlineMs = session.createdAtMs + session.durationSec * 1000;
  return Math.max(0, deadlineMs - nowMs);
}

function formatBytes(value: number): string {
  const normalized = Math.max(0, normalizeInt(value));
  if (normalized >= 1024 * 1024) {
    return `${(normalized / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (normalized >= 1024) {
    return `${(normalized / 1024).toFixed(1)} KB`;
  }
  return `${normalized} B`;
}

function normalizeProcessPathForRule(path: string): string {
  return path.replace(/\//g, "\\");
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveSuffixDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized === "") {
    return "";
  }
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }
  const compoundSecondLevelDomains = new Set([
    "co.uk",
    "org.uk",
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "edu.cn",
    "com.hk",
    "com.tw",
    "co.jp",
  ]);
  const lastTwo = parts.slice(-2).join(".");
  if (compoundSecondLevelDomains.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

function deriveDomainKeyword(domain: string): string {
  const suffixDomain = deriveSuffixDomain(domain);
  if (suffixDomain === "") {
    return "";
  }
  return suffixDomain.split(".")[0] ?? suffixDomain;
}

function buildDomainRegexRule(domain: string): string {
  const suffixDomain = deriveSuffixDomain(domain);
  if (suffixDomain === "") {
    return "";
  }
  const escaped = suffixDomain
    .split(".")
    .map((part) => escapeRegexLiteral(part))
    .join("\\.");
  return `regex:(?i)^([a-z0-9-]+\\.)*${escaped}$`;
}

function buildRecordSearchText(record: RequestMonitorRecord): string {
  return [
    record.processName,
    record.processPath,
    String(record.pid),
    record.domain,
    record.destinationIp,
    String(record.destinationPort),
    record.network,
    record.protocol,
    record.inboundTag,
    record.recordScope,
    formatRecordScopeLabel(record.recordScope),
    formatMonitorResultLabel(record.ruleMissed),
    record.matchedRule,
    record.outboundTag,
    record.suggestedRule,
    record.country,
  ]
    .join(" ")
    .toLowerCase();
}

function buildDuplicateRecordKey(record: RequestMonitorRecord): string {
  return [
    record.processName.trim().toLowerCase(),
    record.processPath.trim().toLowerCase(),
    String(record.pid),
    record.domain.trim().toLowerCase(),
    record.destinationIp.trim().toLowerCase(),
    String(record.destinationPort),
    record.network.trim().toLowerCase(),
    record.protocol.trim().toLowerCase(),
    record.inboundTag.trim().toLowerCase(),
    record.country.trim().toLowerCase(),
  ].join("|");
}

function buildRequestMonitorRecordJSON(record: RequestMonitorRecord): string {
  return JSON.stringify(
    {
      timestamp_ms: record.timestampMs,
      process: {
        pid: record.pid,
        name: record.processName || undefined,
        path: record.processPath || undefined,
      },
      request: {
        domain: record.domain || undefined,
        destination_ip: record.destinationIp || undefined,
        destination_port: record.destinationPort > 0 ? record.destinationPort : undefined,
        network: record.network !== "-" ? record.network : undefined,
        protocol: record.protocol !== "-" ? record.protocol : undefined,
        inbound_tag: record.inboundTag || undefined,
        country: record.country || undefined,
      },
      monitor: {
        record_scope: record.recordScope,
        rule_missed: record.ruleMissed,
        matched_rule: record.matchedRule || undefined,
        outbound_tag: record.outboundTag || undefined,
        suggested_rule: record.suggestedRule || undefined,
        upload_bytes: record.uploadBytes > 0 ? record.uploadBytes : undefined,
        download_bytes: record.downloadBytes > 0 ? record.downloadBytes : undefined,
      },
      tags: record.tags.length > 0 ? record.tags : undefined,
    },
    null,
    2,
  );
}

function keepLatestDuplicateRecords(records: RequestMonitorRecord[]): RequestMonitorRecord[] {
  if (records.length <= 1) {
    return records;
  }
  const seen = new Set<string>();
  const deduped: RequestMonitorRecord[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const key = buildDuplicateRecordKey(record);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(record);
  }
  deduped.reverse();
  return deduped;
}

function matchesPositiveFilterToken(record: RequestMonitorRecord, token: string): boolean {
  const normalizedToken = token.trim().toLowerCase();
  if (normalizedToken === "") {
    return true;
  }
  const dividerIndex = normalizedToken.indexOf(":");
  if (dividerIndex <= 0) {
    return buildRecordSearchText(record).includes(normalizedToken);
  }
  const key = normalizedToken.slice(0, dividerIndex).trim();
  const value = normalizedToken.slice(dividerIndex + 1).trim();
  if (value === "") {
    return true;
  }
  switch (key) {
    case "process":
      return `${record.processName} ${record.processPath}`.toLowerCase().includes(value);
    case "pid":
      return String(record.pid).includes(value);
    case "domain":
      return record.domain.toLowerCase().includes(value);
    case "ip":
      return record.destinationIp.toLowerCase().includes(value);
    case "port":
      return String(record.destinationPort).includes(value);
    case "protocol":
      return record.protocol.toLowerCase().includes(value);
    case "inbound":
      return record.inboundTag.toLowerCase().includes(value);
    case "scope":
      return (
        record.recordScope.toLowerCase().includes(value) ||
        formatRecordScopeLabel(record.recordScope).toLowerCase().includes(value)
      );
    case "result":
      return formatMonitorResultLabel(record.ruleMissed).toLowerCase().includes(value);
    case "matched":
      return record.matchedRule.toLowerCase().includes(value);
    case "outbound":
      return record.outboundTag.toLowerCase().includes(value);
    case "rule":
      return record.suggestedRule.toLowerCase().includes(value);
    case "country":
      return record.country.toLowerCase().includes(value);
    default:
      return buildRecordSearchText(record).includes(value);
  }
}

function matchesFilterToken(record: RequestMonitorRecord, token: string): boolean {
  const normalizedToken = token.trim();
  if (normalizedToken === "") {
    return true;
  }
  const negated = normalizedToken.startsWith("!");
  const positiveToken = negated ? normalizedToken.slice(1).trim() : normalizedToken;
  if (positiveToken === "" || positiveToken.endsWith(":")) {
    return true;
  }
  const matched = matchesPositiveFilterToken(record, positiveToken);
  return negated ? !matched : matched;
}

function appendFilterTokenOption(
  seen: Set<string>,
  options: Array<{ label: string; value: string }>,
  value: string,
) {
  const normalized = value.trim();
  if (normalized === "" || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  options.push({
    label: normalized,
    value: normalized,
  });
}

function buildFilterTokenOptions(records: RequestMonitorRecord[]): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  const options: Array<{ label: string; value: string }> = [];
  for (const token of filterKeyPresets) {
    appendFilterTokenOption(seen, options, token);
  }
  for (const record of records) {
    appendFilterTokenOption(seen, options, record.processName ? `process:${record.processName}` : "");
    appendFilterTokenOption(seen, options, record.pid > 0 ? `pid:${record.pid}` : "");
    appendFilterTokenOption(seen, options, record.domain ? `domain:${record.domain}` : "");
    appendFilterTokenOption(seen, options, record.destinationIp ? `ip:${record.destinationIp}` : "");
    appendFilterTokenOption(
      seen,
      options,
      record.destinationPort > 0 ? `port:${record.destinationPort}` : "",
    );
    appendFilterTokenOption(seen, options, record.protocol ? `protocol:${record.protocol}` : "");
    appendFilterTokenOption(seen, options, record.inboundTag ? `inbound:${record.inboundTag}` : "");
    appendFilterTokenOption(seen, options, `scope:${record.recordScope}`);
    appendFilterTokenOption(seen, options, `result:${record.ruleMissed ? "missed" : "matched"}`);
    appendFilterTokenOption(seen, options, record.matchedRule ? `matched:${record.matchedRule}` : "");
    appendFilterTokenOption(seen, options, record.outboundTag ? `outbound:${record.outboundTag}` : "");
    appendFilterTokenOption(seen, options, record.suggestedRule ? `rule:${record.suggestedRule}` : "");
    appendFilterTokenOption(seen, options, record.country ? `country:${record.country}` : "");
    if (options.length >= 120) {
      break;
    }
  }
  return options;
}

function mapApiRecordToPageRecord(
  record: ApiRequestMonitorRecord,
  fallbackId: string,
): RequestMonitorRecord {
  const process = record.process ?? {};
  const request = record.request ?? {};
  const monitor = record.monitor ?? {};
  const normalizedID = String(record.id ?? "").trim() || fallbackId;
  const processPath = String(process.path ?? "").trim();
  const processName = String(process.name ?? "").trim() || deriveProcessNameFromPath(processPath);
  return {
    id: normalizedID,
    timestampMs: Math.max(0, normalizeInt(record.timestampMs, Date.now())),
    processName,
    processPath,
    pid: Math.max(0, normalizeInt(process.pid)),
    domain: String(request.domain ?? "").trim(),
    destinationIp: String(request.destinationIp ?? "").trim(),
    destinationPort: Math.max(0, normalizeInt(request.destinationPort)),
    network: String(request.network ?? "").trim().toLowerCase() || "-",
    protocol: String(request.protocol ?? "").trim().toLowerCase() || "-",
    inboundTag: String(request.inboundTag ?? "").trim(),
    recordScope: normalizeMonitorRecordScope(String(monitor.recordScope ?? "")),
    ruleMissed: Boolean(monitor.ruleMissed),
    matchedRule: String(monitor.matchedRule ?? "").trim(),
    outboundTag: String(monitor.outboundTag ?? "").trim(),
    suggestedRule: String(monitor.suggestedRule ?? "").trim(),
    country: String(request.country ?? "").trim(),
    uploadBytes: Math.max(0, normalizeInt(monitor.uploadBytes)),
    downloadBytes: Math.max(0, normalizeInt(monitor.downloadBytes)),
    tags: Array.isArray(record.tags)
      ? record.tags.map((item) => String(item).trim()).filter((item) => item !== "")
      : [],
  };
}

function mapSessionSummaryToPageSession(
  summary: ApiRequestMonitorSessionSummary,
  previous?: RequestMonitorSession,
): RequestMonitorSession {
  const id = String(summary.id ?? "").trim() || previous?.id || "";
  const fileName = String(summary.fileName ?? "").trim() || previous?.fileName || id;
  const fileBaseName =
    String(summary.fileBaseName ?? "").trim() || previous?.fileBaseName || fileName;
  const requestCount = Math.max(
    0,
    normalizeInt(summary.requestCount, previous?.records.length ?? previous?.requestCount ?? 0),
  );
  return {
    id,
    fileName,
    fileBaseName,
    durationSec: Math.max(0, normalizeInt(summary.durationSec, previous?.durationSec ?? 0)),
    recordScope: normalizeMonitorRecordScope(String(summary.recordScope ?? previous?.recordScope ?? "all")),
    createdAtMs: Math.max(0, normalizeInt(summary.createdAtMs, previous?.createdAtMs ?? 0)),
    completedAtMs: Math.max(0, normalizeInt(summary.completedAtMs, previous?.completedAtMs ?? 0)),
    requestCount,
    running: Boolean(summary.running),
    lastError: String(summary.lastError ?? "").trim(),
    records: previous?.records ?? [],
  };
}

function buildRecordScopeDescription(recordMissOnly: boolean): string {
  return recordMissOnly
    ? "监控启动后，只保留未命中规则、走漏网之鱼线路的请求。"
    : "监控启动后，当前代理服务看到的请求都会被记录。";
}

function buildRulePreviewTitle(kind: RulePreviewKind): string {
  if (kind === "process") {
    return "进程规则草案";
  }
  if (kind === "domain") {
    return "域名规则草案";
  }
  return "IP 规则草案";
}

function buildRulePreviewHelpContent(kind: RulePreviewKind) {
  if (kind === "process") {
    return {
      scene: "把监控到的进程快速转成规则匹配内容。",
      effect: "支持“进程名称 / 包含路径”两种写法，便于直接粘贴到规则页面。",
      recommendation: "推荐先用“进程名称”，仅在有同名冲突时切到“包含路径”。",
    };
  }
  if (kind === "domain") {
    return {
      scene: "把请求域名批量转为可维护的域名规则。",
      effect: "支持 exact / suffix / keyword / regex 四种域名匹配方式。",
      recommendation: "默认建议 suffix；仅在精确控制或复杂场景下使用 exact / regex。",
    };
  }
  return {
    scene: "将目标 IP 批量整理为规则匹配内容。",
    effect: "支持“单 IP”与“CIDR 网段”两种形式。",
    recommendation: "默认单 IP；需要覆盖网段时改为 CIDR。",
  };
}

export function MonitorPage({ loading, runAction, snapshot }: DaemonPageProps) {
  const notice = useAppNotice();
  const previousRunningSessionIdsRef = useRef<string[]>([]);
  const countdownSyncSessionIdRef = useRef("");

  const [sessions, setSessions] = useState<RequestMonitorSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [countdownNowMs, setCountdownNowMs] = useState(() => Date.now());

  const [sessionListLoading, setSessionListLoading] = useState(false);
  const [sessionContentLoading, setSessionContentLoading] = useState(false);
  const [sessionActionLoading, setSessionActionLoading] = useState(false);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [durationDraft, setDurationDraft] = useState<string>("30");
  const [fileBaseNameDraft, setFileBaseNameDraft] = useState<string>(() =>
    buildDefaultMonitorFileBaseName(),
  );
  const [recordMissOnlyDraft, setRecordMissOnlyDraft] = useState(false);
  const [pendingMonitorSessionId, setPendingMonitorSessionId] = useState("");
  const [pendingMonitorOperationId, setPendingMonitorOperationId] = useState("");

  const [filterTokens, setFilterTokens] = useState<string[]>([]);
  const [filterJoinMode, setFilterJoinMode] = useState<FilterJoinMode>("and");
  const [duplicateFilterMode, setDuplicateFilterMode] = useState<DuplicateFilterMode>("off");
  const [selectedRecordKeys, setSelectedRecordKeys] = useState<string[]>([]);
  const [expandedRecordKeys, setExpandedRecordKeys] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);

  const [rulePreviewOpen, setRulePreviewOpen] = useState(false);
  const [rulePreviewKind, setRulePreviewKind] = useState<RulePreviewKind>("process");
  const [processRuleContentMode, setProcessRuleContentMode] =
    useState<ProcessRuleContentMode>("name");
  const [domainRuleContentMode, setDomainRuleContentMode] =
    useState<DomainRuleContentMode>("suffix");
  const [ipRuleContentMode, setIpRuleContentMode] = useState<IpRuleContentMode>("ip");
  const [rulePreviewContent, setRulePreviewContent] = useState("");

  const syncSessions = useCallback(async (options: RequestMonitorRefreshOptions = {}) => {
    if (!options.silent) {
      setSessionListLoading(true);
    }
    try {
      const summaries = await daemonApi.listRequestMonitorSessions();
      setSessions((current) => {
        const currentByID = new Map(current.map((item) => [item.id, item]));
        return summaries
          .map((summary) => {
            const id = String(summary.id ?? "").trim();
            if (id === "") {
              return null;
            }
            return mapSessionSummaryToPageSession(summary, currentByID.get(id));
          })
          .filter((item): item is RequestMonitorSession => item != null);
      });
    } catch (error) {
      if (!options.suppressError) {
        notice.error(error instanceof Error ? error.message : "加载监控记录列表失败");
      }
    } finally {
      if (!options.silent) {
        setSessionListLoading(false);
      }
    }
  }, [notice]);

  const loadSessionContent = useCallback(
    async (sessionID: string, options: RequestMonitorRefreshOptions = {}) => {
      const normalizedSessionID = sessionID.trim();
      if (normalizedSessionID === "") {
        return;
      }
      if (!options.silent) {
        setSessionContentLoading(true);
      }
      try {
        const content = await daemonApi.getRequestMonitorSessionContent(normalizedSessionID);
        const records = (content.records ?? []).map((item, index) =>
          mapApiRecordToPageRecord(item, `${normalizedSessionID}-${index + 1}`),
        );
        setSessions((current) =>
          current.map((session) =>
            session.id === normalizedSessionID
              ? {
                  ...mapSessionSummaryToPageSession(content.session, session),
                  requestCount: Math.max(0, normalizeInt(content.session?.requestCount, records.length)),
                  records,
                }
              : session,
          ),
        );
      } catch (error) {
        if (!options.suppressError) {
          notice.error(error instanceof Error ? error.message : "加载监控记录内容失败");
        }
      } finally {
        if (!options.silent) {
          setSessionContentLoading(false);
        }
      }
    },
    [notice],
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const runningSession = useMemo(
    () => sessions.find((session) => session.running) ?? null,
    [sessions],
  );
  const runningSessionRemainingMs = useMemo(
    () => resolveMonitorSessionRemainingMs(runningSession, countdownNowMs),
    [countdownNowMs, runningSession],
  );
  const runningSessionCountdownText = useMemo(
    () => (runningSessionRemainingMs == null ? "" : formatCountdownDuration(runningSessionRemainingMs)),
    [runningSessionRemainingMs],
  );

  useEffect(() => {
    void syncSessions();
  }, [syncSessions]);

  useEffect(() => {
    if (createModalOpen) {
      return;
    }
    setDurationDraft("30");
    setRecordMissOnlyDraft(false);
    setFileBaseNameDraft(buildDefaultMonitorFileBaseName());
  }, [createModalOpen]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== "") {
        setSelectedSessionId("");
      }
      return;
    }
    if (selectedSessionId.trim() !== "" && sessions.some((item) => item.id === selectedSessionId)) {
      return;
    }
    setSelectedSessionId(sessions[0]?.id ?? "");
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (selectedSessionId.trim() === "") {
      return;
    }
    void loadSessionContent(selectedSessionId);
  }, [loadSessionContent, selectedSessionId]);

  useEffect(() => {
    if (!runningSession) {
      countdownSyncSessionIdRef.current = "";
      return;
    }
    setCountdownNowMs(Date.now());
    const timer = window.setInterval(() => {
      setCountdownNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [runningSession]);

  useEffect(() => {
    const hasRunningSession = sessions.some((item) => item.running);
    if (!hasRunningSession) {
      return;
    }
    const timer = window.setInterval(() => {
      void syncSessions({ silent: true, suppressError: true });
      if (selectedSessionId.trim() !== "") {
        void loadSessionContent(selectedSessionId, { silent: true, suppressError: true });
      }
    }, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadSessionContent, selectedSessionId, sessions, syncSessions]);

  useEffect(() => {
    if (!runningSession || runningSessionRemainingMs == null || runningSessionRemainingMs > 0) {
      return;
    }
    if (countdownSyncSessionIdRef.current === runningSession.id) {
      return;
    }
    countdownSyncSessionIdRef.current = runningSession.id;
    void syncSessions({ silent: true, suppressError: true });
    void loadSessionContent(runningSession.id, { silent: true, suppressError: true });
  }, [loadSessionContent, runningSession, runningSessionRemainingMs, syncSessions]);

  useEffect(() => {
    const currentRunningIds = sessions.filter((item) => item.running).map((item) => item.id);
    const currentById = new Map(sessions.map((item) => [item.id, item]));
    const endedSession = previousRunningSessionIdsRef.current
      .map((id) => currentById.get(id) ?? null)
      .find((item) => item != null && !item.running && item.completedAtMs > 0);
    previousRunningSessionIdsRef.current = currentRunningIds;
    if (!endedSession) {
      return;
    }
    void loadSessionContent(endedSession.id, { silent: true, suppressError: true });
    notice.success("监控结束");
  }, [loadSessionContent, notice, sessions]);

  useEffect(() => {
    const pendingSessionID = pendingMonitorSessionId.trim();
    if (pendingSessionID === "") {
      return;
    }
    const timer = window.setInterval(() => {
      void syncSessions({ silent: true, suppressError: true });
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pendingMonitorSessionId, syncSessions]);

  useEffect(() => {
    const pendingSessionID = pendingMonitorSessionId.trim();
    if (pendingSessionID === "") {
      return;
    }
    const pendingSession = sessions.find((item) => item.id === pendingSessionID);
    if (pendingSession?.running) {
      setSelectedSessionId(pendingSessionID);
      setPendingMonitorSessionId("");
      setPendingMonitorOperationId("");
      notice.success("监控代理已启动，已开始计时");
      return;
    }
    const pendingOperation =
      pendingMonitorOperationId.trim() === ""
        ? undefined
        : (snapshot?.operations ?? []).find((item) => item.id === pendingMonitorOperationId);
    if (pendingOperation?.status === "failed") {
      setPendingMonitorSessionId("");
      setPendingMonitorOperationId("");
      notice.error(pendingOperation.errorMessage?.trim() || "监控启动失败");
    }
  }, [notice, pendingMonitorOperationId, pendingMonitorSessionId, sessions, snapshot?.operations]);

  useEffect(() => {
    setCurrentPage(1);
    setSelectedRecordKeys([]);
    setExpandedRecordKeys([]);
  }, [duplicateFilterMode, filterJoinMode, filterTokens, selectedSessionId]);

  const filteredRecords = useMemo(() => {
    if (!selectedSession) {
      return [];
    }
    const nextRecords =
      filterTokens.length === 0
        ? selectedSession.records
        : selectedSession.records.filter((record) => {
            const checker = (token: string) => matchesFilterToken(record, token);
            if (filterJoinMode === "or") {
              return filterTokens.some(checker);
            }
            return filterTokens.every(checker);
          });
    return duplicateFilterMode === "latest" ? keepLatestDuplicateRecords(nextRecords) : nextRecords;
  }, [duplicateFilterMode, filterJoinMode, filterTokens, selectedSession]);

  useEffect(() => {
    const visibleKeySet = new Set(filteredRecords.map((record) => record.id));
    setSelectedRecordKeys((current) => current.filter((key) => visibleKeySet.has(key)));
    setExpandedRecordKeys((current) => current.filter((key) => visibleKeySet.has(key)));
  }, [filteredRecords]);

  const selectedRecords = useMemo(() => {
    if (!selectedSession || selectedRecordKeys.length === 0) {
      return [];
    }
    const recordMap = new Map(selectedSession.records.map((record) => [record.id, record]));
    return selectedRecordKeys
      .map((key) => recordMap.get(key))
      .filter((record): record is RequestMonitorRecord => record != null);
  }, [selectedRecordKeys, selectedSession]);

  const rulePreviewLines = useMemo(() => {
    const lines = selectedRecords
      .map((record) => {
        switch (rulePreviewKind) {
          case "process":
            if (processRuleContentMode === "path") {
              const processPath = record.processPath.trim();
              return processPath === "" ? "" : `path:${normalizeProcessPathForRule(processPath)}`;
            }
            return record.processName.trim() === "" ? "" : `name:${record.processName.trim()}`;
          case "domain":
            switch (domainRuleContentMode) {
              case "exact":
                return record.domain.trim() === "" ? "" : `exact:${record.domain.trim().toLowerCase()}`;
              case "keyword": {
                const keyword = deriveDomainKeyword(record.domain);
                return keyword === "" ? "" : `keyword:${keyword}`;
              }
              case "regex":
                return buildDomainRegexRule(record.domain);
              case "suffix":
              default: {
                const suffixDomain = deriveSuffixDomain(record.domain);
                return suffixDomain === "" ? "" : `suffix:${suffixDomain}`;
              }
            }
          case "ip":
            if (record.destinationIp.trim() === "") {
              return "";
            }
            if (ipRuleContentMode === "cidr") {
              const suffix = record.destinationIp.includes(":") ? "/128" : "/32";
              return `cidr:${record.destinationIp}${suffix}`;
            }
            return `ip:${record.destinationIp}`;
          default:
            return "";
        }
      })
      .filter(Boolean);
    return Array.from(new Set(lines));
  }, [
    domainRuleContentMode,
    ipRuleContentMode,
    processRuleContentMode,
    rulePreviewKind,
    selectedRecords,
  ]);

  useEffect(() => {
    if (!rulePreviewOpen) {
      return;
    }
    setRulePreviewContent(rulePreviewLines.join("\n"));
  }, [rulePreviewLines, rulePreviewOpen]);

  const totalRecords = filteredRecords.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / monitorPageSize));
  const currentPageSafe = Math.max(1, Math.min(currentPage, totalPages));
  const pagedRecords = filteredRecords.slice(
    (currentPageSafe - 1) * monitorPageSize,
    currentPageSafe * monitorPageSize,
  );

  const rowSelection = useMemo<TableRowSelection<RequestMonitorRecord>>(
    () => ({
      selectedRowKeys: selectedRecordKeys,
      onChange: (keys) => setSelectedRecordKeys(keys.map((item) => String(item))),
    }),
    [selectedRecordKeys],
  );

  const filterTokenOptions = useMemo(
    () => buildFilterTokenOptions(selectedSession?.records ?? []),
    [selectedSession],
  );

  const openRulePreviewModal = (kind: RulePreviewKind) => {
    if (selectedRecords.length === 0) {
      notice.warning("请先在表格中勾选至少一条请求记录");
      return;
    }
    setRulePreviewKind(kind);
    if (kind === "process") {
      setProcessRuleContentMode("name");
    } else if (kind === "domain") {
      setDomainRuleContentMode("suffix");
    } else {
      setIpRuleContentMode("ip");
    }
    setRulePreviewOpen(true);
  };

  const handleCreateSession = useCallback(async () => {
    const normalizedDuration = Math.max(1, normalizeInt(durationDraft, 30));
    const normalizedFileBase = sanitizeMonitorFileBaseName(fileBaseNameDraft);
    const fileBase = normalizedFileBase === "" ? buildDefaultMonitorFileBaseName() : normalizedFileBase;
    const nextSessionId = `${fileBase}.json`;
    const payload: CreateRequestMonitorSessionRequestPayload = {
      durationSec: normalizedDuration,
      fileBaseName: fileBase,
      recordScope: recordMissOnlyDraft ? "miss_only" : "all",
    };
    setSessionActionLoading(true);
    try {
      const nextSnapshot = await runAction(() => daemonApi.createRequestMonitorSession(payload));
      const nextOperation = (nextSnapshot.operations ?? []).find(
        (item) => item.type === "request_monitor" && item.scopeKey === "request_monitor:active",
      );
      setPendingMonitorSessionId(nextSessionId);
      setPendingMonitorOperationId(String(nextOperation?.id ?? "").trim());
      await syncSessions({ silent: true, suppressError: true });
      setCreateModalOpen(false);
      notice.info("正在启动当前代理服务并临时提升日志等级，通过验证后开始计时");
    } catch (error) {
      setPendingMonitorSessionId("");
      setPendingMonitorOperationId("");
      notice.error(error instanceof Error ? error.message : "创建监控任务失败");
    } finally {
      setSessionActionLoading(false);
    }
  }, [
    durationDraft,
    fileBaseNameDraft,
    notice,
    recordMissOnlyDraft,
    runAction,
    syncSessions,
  ]);

  const handleDeleteCurrentSession = useCallback(async () => {
    const recordID = selectedSessionId.trim();
    if (recordID === "") {
      return;
    }
    setSessionActionLoading(true);
    try {
      await runAction(() => daemonApi.deleteRequestMonitorSession(recordID));
      await syncSessions();
      setSelectedRecordKeys([]);
      setCurrentPage(1);
      notice.success("监控记录已删除");
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "删除监控记录失败");
    } finally {
      setSessionActionLoading(false);
    }
  }, [notice, runAction, selectedSessionId, syncSessions]);

  const handleRefresh = useCallback(async () => {
    await syncSessions();
    if (selectedSessionId.trim() !== "") {
      await loadSessionContent(selectedSessionId);
    }
  }, [loadSessionContent, selectedSessionId, syncSessions]);

  const handleCopyRulePreview = useCallback(async () => {
    const text = rulePreviewContent.trim();
    if (text === "") {
      notice.warning("没有可复制的规则内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notice.success("规则内容已复制");
    } catch {
      notice.error("复制失败，请手动选择并复制");
    }
  }, [notice, rulePreviewContent]);

  const columns = useMemo<ColumnsType<RequestMonitorRecord>>(
    () => [
      {
        title: "进程",
        key: "process",
        width: 180,
        ellipsis: true,
        render: (_unused, record) => (
          <Typography.Text strong ellipsis={{ tooltip: record.processPath || record.processName || "未知进程" }}>
            {record.processName || "未知进程"}
          </Typography.Text>
        ),
      },
      {
        title: "域名",
        key: "domain",
        width: 260,
        ellipsis: true,
        render: (_unused, record) =>
          record.domain.trim() === "" ? (
            ""
          ) : (
            <Typography.Text ellipsis={{ tooltip: record.domain }}>{record.domain}</Typography.Text>
          ),
      },
      {
        title: "IP",
        key: "destinationIp",
        width: 180,
        ellipsis: true,
        render: (_unused, record) =>
          record.destinationIp.trim() === "" ? (
            ""
          ) : (
            <Typography.Text ellipsis={{ tooltip: record.destinationIp }}>
              {record.destinationIp}
            </Typography.Text>
          ),
      },
      {
        title: "规则建议",
        dataIndex: "suggestedRule",
        key: "suggestedRule",
        width: 260,
        ellipsis: true,
        render: (value: string) =>
          value.trim() === "" ? (
            <Typography.Text type="secondary">-</Typography.Text>
          ) : (
            <Tooltip title={value}>
              <Typography.Text code>{value}</Typography.Text>
            </Tooltip>
          ),
      },
      {
        title: "时间",
        dataIndex: "timestampMs",
        key: "timestampMs",
        width: 100,
        align: "right",
        render: (value: number) => (
          <Typography.Text type="secondary">{formatCompactTimestamp(value)}</Typography.Text>
        ),
      },
    ],
    [],
  );

  const expandedRowRender = useCallback(
    (record: RequestMonitorRecord) => (
      <Input.TextArea
        readOnly
        value={buildRequestMonitorRecordJSON(record)}
        autoSize={{ minRows: 8, maxRows: 16 }}
        spellCheck={false}
        styles={{ textarea: { fontFamily: "Consolas, Monaco, monospace", fontSize: 12 } }}
      />
    ),
    [],
  );

  const sessionOptions = useMemo(
    () =>
      sessions.map((session) => ({
        value: session.id,
        label: `${session.fileBaseName} (${session.requestCount})${session.running ? " · 运行中" : ""}`,
      })),
    [sessions],
  );

  const rulePreviewTitle = buildRulePreviewTitle(rulePreviewKind);
  const tableLoading = loading || sessionListLoading || sessionContentLoading || sessionActionLoading;

  return (
    <Card
      bodyStyle={{ padding: 16 }}
    >
      <Space direction="vertical" size={14} style={{ width: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
          }}
        >
          <div style={{ flex: "0 1 70%", minWidth: 0 }}>
            <Space wrap size={8}>
              <Select
                value={selectedSessionId || undefined}
                placeholder={sessions.length === 0 ? "暂无监控记录" : "选择监控记录"}
                options={sessionOptions}
                onChange={(value) => setSelectedSessionId(String(value))}
                style={{ width: 320 }}
                showSearch
                optionFilterProp="label"
                allowClear={sessions.length > 0}
                onClear={() => setSelectedSessionId("")}
                loading={sessionListLoading}
              />
              <Button
                icon={<BiIcon name="arrow-clockwise" />}
                onClick={() => void handleRefresh()}
                loading={tableLoading}
              >
                刷新
              </Button>
              <Button icon={<BiIcon name="plus-lg" />} type="primary" onClick={() => setCreateModalOpen(true)}>
                新增监控
              </Button>
              <Button
                danger
                icon={<BiIcon name="trash3" />}
                onClick={() => void handleDeleteCurrentSession()}
                disabled={selectedSession == null}
                loading={sessionActionLoading}
              >
                删除当前
              </Button>
            </Space>
          </div>
          <div
            style={{
              flex: "0 0 30%",
              minWidth: 0,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            {runningSession && runningSessionCountdownText !== "" ? (
              <Typography.Text
                type="secondary"
                style={{
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                监控中 · 剩余 {runningSessionCountdownText}
              </Typography.Text>
            ) : null}
          </div>
        </div>

        {selectedSession == null ? (
          <Typography.Text type="secondary">先创建一条监控记录，再查看请求明细。</Typography.Text>
        ) : null}

        <Space wrap align="start" size={10} style={{ width: "100%" }}>
          <Select
            mode="tags"
            value={filterTokens}
            options={filterTokenOptions}
            placeholder="过滤：支持 key:value / !key:value，示例 process:chrome !process:chrome domain:github.com"
            onChange={(values) =>
              setFilterTokens(
                Array.from(
                  new Set(
                    values
                      .map((value) => String(value).trim())
                      .filter((value) => value !== ""),
                  ),
                ),
              )
            }
            tokenSeparators={[" ", ",", "，", ";", "；"]}
            style={{ flex: 1, minWidth: 480 }}
            maxTagCount="responsive"
          />
          <Radio.Group
            value={filterJoinMode}
            onChange={(event) => setFilterJoinMode(event.target.value as FilterJoinMode)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="and">全部满足</Radio.Button>
            <Radio.Button value="or">任一满足</Radio.Button>
          </Radio.Group>
          <Select
            value={duplicateFilterMode}
            onChange={(value) => setDuplicateFilterMode(value as DuplicateFilterMode)}
            style={{ width: 168 }}
            options={[
              { value: "off", label: "过滤重复：关闭" },
              { value: "latest", label: "过滤重复：仅最后一条" },
            ]}
          />
        </Space>

        {selectedSession == null ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无监控数据"
            style={{ margin: "36px 0 20px" }}
          />
        ) : (
          <>
            <Table<RequestMonitorRecord>
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={pagedRecords}
              expandable={{
                expandedRowRender,
                expandedRowKeys: expandedRecordKeys,
                showExpandColumn: false,
                onExpandedRowsChange: (keys) => setExpandedRecordKeys(keys.map((item) => String(item))),
              }}
              onRow={(record) => ({
                onDoubleClick: () =>
                  setExpandedRecordKeys((current) =>
                    current.includes(record.id) ? current.filter((key) => key !== record.id) : [record.id],
                  ),
              })}
              rowSelection={rowSelection}
              pagination={false}
              loading={tableLoading}
              locale={{ emptyText: "当前筛选条件下没有记录" }}
              scroll={{ x: 980, y: monitorTableMaxHeightPx }}
            />

            <Space
              wrap
              align="center"
              size={10}
              style={{ width: "100%", justifyContent: "space-between" }}
            >
              <Space size={8}>
                <Button
                  icon={<BiIcon name="magic" />}
                  onClick={() => openRulePreviewModal("process")}
                  disabled={selectedRecords.length === 0}
                >
                  批量生成进程规则
                </Button>
                <Button
                  icon={<BiIcon name="magic" />}
                  onClick={() => openRulePreviewModal("domain")}
                  disabled={selectedRecords.length === 0}
                >
                  批量生成域名规则
                </Button>
                <Button
                  icon={<BiIcon name="magic" />}
                  onClick={() => openRulePreviewModal("ip")}
                  disabled={selectedRecords.length === 0}
                >
                  批量生成 IP 规则
                </Button>
                <Typography.Text type="secondary">
                  已选 {selectedRecords.length} / 当前筛选 {filteredRecords.length}
                </Typography.Text>
              </Space>
              <Pagination
                current={currentPageSafe}
                total={totalRecords}
                pageSize={monitorPageSize}
                showSizeChanger={false}
                onChange={(page) => setCurrentPage(page)}
              />
            </Space>
          </>
        )}
      </Space>

      <Modal
        title={rulePreviewTitle}
        open={rulePreviewOpen}
        onCancel={() => setRulePreviewOpen(false)}
        width={760}
        footer={[
          <Button key="cancel" onClick={() => setRulePreviewOpen(false)}>
            关闭
          </Button>,
          <Button key="copy" type="primary" icon={<BiIcon name="clipboard" />} onClick={() => void handleCopyRulePreview()}>
            复制内容
          </Button>,
        ]}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <HelpLabel
            label={<Typography.Text strong>规则内容方式</Typography.Text>}
            helpTitle="规则草案说明"
            helpContent={buildRulePreviewHelpContent(rulePreviewKind)}
          />

          <Radio.Group
            value={rulePreviewKind}
            onChange={(event) => setRulePreviewKind(event.target.value as RulePreviewKind)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="process">进程</Radio.Button>
            <Radio.Button value="domain">域名</Radio.Button>
            <Radio.Button value="ip">IP</Radio.Button>
          </Radio.Group>

          {rulePreviewKind === "process" ? (
            <Radio.Group
              value={processRuleContentMode}
              onChange={(event) => setProcessRuleContentMode(event.target.value as ProcessRuleContentMode)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="name">进程名称</Radio.Button>
              <Radio.Button value="path">包含路径</Radio.Button>
            </Radio.Group>
          ) : null}

          {rulePreviewKind === "domain" ? (
            <Radio.Group
              value={domainRuleContentMode}
              onChange={(event) => setDomainRuleContentMode(event.target.value as DomainRuleContentMode)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="exact">Exact</Radio.Button>
              <Radio.Button value="suffix">Suffix</Radio.Button>
              <Radio.Button value="keyword">Keyword</Radio.Button>
              <Radio.Button value="regex">Regex</Radio.Button>
            </Radio.Group>
          ) : null}

          {rulePreviewKind === "ip" ? (
            <Radio.Group
              value={ipRuleContentMode}
              onChange={(event) => setIpRuleContentMode(event.target.value as IpRuleContentMode)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="ip">单 IP</Radio.Button>
              <Radio.Button value="cidr">CIDR</Radio.Button>
            </Radio.Group>
          ) : null}

          <Input.TextArea
            rows={14}
            value={rulePreviewContent}
            onChange={(event) => setRulePreviewContent(event.target.value)}
            placeholder="规则内容会按行生成，可直接复制粘贴到规则添加页的“规则匹配”输入框。"
          />
          <Typography.Text type="secondary">
            每行一条匹配内容，复制后可直接用于规则页。
          </Typography.Text>
        </Space>
      </Modal>

      <Modal
        title="新增监控记录"
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onOk={() => void handleCreateSession()}
        okText="确认"
        cancelText="取消"
        confirmLoading={sessionActionLoading}
      >
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            <HelpLabel
              label={<Typography.Text strong>监控时长</Typography.Text>}
              helpTitle="监控时长说明"
              helpContent={{
                scene: "希望在固定时间窗口内临时采样请求。",
                effect: "到时后会自动结束本次监控任务。",
                recommendation: "常用预设为 10 / 30 / 60 / 120 秒。",
              }}
            />
            <AutoComplete
              options={monitorDurationOptions.map((value) => ({
                value: String(value),
                label: `${value} 秒`,
              }))}
              value={durationDraft}
              onChange={(value) => setDurationDraft(String(value))}
            >
              <Input addonAfter="秒" placeholder="默认 30 秒" />
            </AutoComplete>
          </Space>

          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            <HelpLabel
              label={<Typography.Text strong>监控记录文件名称</Typography.Text>}
              helpTitle="监控记录文件名称说明"
              helpContent={{
                scene: "准备创建一份可回看、可筛选的监控日志。",
                effect: "将生成 requestlogs/<文件名>.json，后缀会自动补齐。",
                recommendation: "默认使用当前日期-时间，便于回溯。",
              }}
            />
            <Input
              value={fileBaseNameDraft}
              addonAfter=".json"
              placeholder="默认使用当前日期-时间"
              onChange={(event) => setFileBaseNameDraft(event.target.value)}
            />
          </Space>

          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            <SwitchWithLabel
              checked={recordMissOnlyDraft}
              onChange={(checked) => setRecordMissOnlyDraft(checked)}
              label={<Typography.Text strong>仅记录漏网之鱼请求</Typography.Text>}
              helpTitle="监控记录范围说明"
              helpContent={{
                scene: "监控会直接复用当前正常代理服务，并临时把代理日志等级提升到 info。",
                effect: buildRecordScopeDescription(recordMissOnlyDraft),
                caution: "监控结束后会恢复监控前的日志等级；若监控前代理未启动，则结束后会自动停止代理。",
              }}
            />
          </Space>
        </Space>
      </Modal>
    </Card>
  );
}
