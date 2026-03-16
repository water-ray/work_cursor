import {
  Button,
  Collapse,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { BiIcon } from "../../../components/icons/BiIcon";
import { DraftActionBar } from "../../../components/draft/DraftActionBar";
import { HelpLabel } from "../../../components/form/HelpLabel";
import { SwitchWithLabel } from "../../../components/form/SwitchWithLabel";
import { useAppNotice } from "../../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../../hooks/useDraftNotice";
import { isMobileRuntime } from "../../../platform/runtimeStore";
import {
  dispatchRulesUiState,
  listenRulesUiAction,
} from "../../../services/rulesUiEvents";
import { MobileSwipeActionCard } from "../../subscriptions/MobileSwipeActionCard";

import type {
  RuleGroup,
  RuleItemV2,
  RuleMatchV2,
  RuleMissMode,
  RulePolicyGroup,
} from "../../../../../shared/daemon";
import { hasAnyMatcher, summarizeRuleMatch } from "./ruleEditorUtils";

interface ComposedRulesTabsProps {
  groups: RuleGroup[];
  activeGroupId: string;
  policyGroups: RulePolicyGroup[];
  onChange: (
    nextGroups: RuleGroup[],
    nextActiveGroupId: string,
  ) => Promise<boolean>;
}

type RuleType = "ip" | "domain" | "process";
type ActionMode = "proxy" | "direct" | "reject" | "policy";

interface RuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  type: RuleType;
  content: string;
  actionMode: ActionMode;
  policyID: string;
}

function unique(values: string[]): string[] {
  return Array.from(
    new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)),
  );
}

function normalizeInputLine(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return "";
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/g)
    .map(normalizeInputLine)
    .filter((item) => item.length > 0);
}

function valueAfterPrefix(line: string, prefixes: string[]): string | null {
  const lower = line.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function ensureCaseInsensitiveRegex(rawPattern: string): string {
  const pattern = rawPattern.trim();
  if (pattern === "") {
    return "";
  }
  if (pattern.toLowerCase().startsWith("(?i)")) {
    return pattern;
  }
  return `(?i)${pattern}`;
}

function inferRuleType(item: RuleItemV2): RuleType {
  const match = item.match ?? { domain: {}, process: {} };
  const hasProcess =
    (match.process.nameContains?.length ?? 0) > 0 ||
    (match.process.pathContains?.length ?? 0) > 0 ||
    (match.process.pathRegex?.length ?? 0) > 0;
  if (hasProcess) {
    return "process";
  }
  const hasDomain =
    (match.domain.exact?.length ?? 0) > 0 ||
    (match.domain.suffix?.length ?? 0) > 0 ||
    (match.domain.keyword?.length ?? 0) > 0 ||
    (match.domain.regex?.length ?? 0) > 0 ||
    (match.geosite?.length ?? 0);
  return hasDomain ? "domain" : "ip";
}

function stringifyRuleContent(item: RuleItemV2, type: RuleType): string {
  const lines: string[] = [];
  const match = item.match ?? { domain: {}, process: {} };
  if (type === "process") {
    lines.push(...(match.process.nameContains ?? []));
    lines.push(...(match.process.pathContains ?? []).map((entry) => `path:${entry}`));
    lines.push(...(match.process.pathRegex ?? []).map((entry) => `regex:${entry}`));
    return lines.join("\n");
  }
  if (type === "domain") {
    lines.push(...(match.domain.exact ?? []));
    lines.push(...(match.domain.suffix ?? []).map((entry) => `suffix:${entry}`));
    lines.push(...(match.domain.keyword ?? []).map((entry) => `keyword:${entry}`));
    lines.push(...(match.domain.regex ?? []).map((entry) => `regex:${entry}`));
    lines.push(...(match.geosite ?? []).map((entry) => `geosite:${entry}`));
    lines.push(...(match.ruleSetRefs ?? []).map((entry) => `ruleset:${entry}`));
    return lines.join("\n");
  }
  lines.push(...(match.ipCidr ?? []));
  lines.push(...(match.geoip ?? []).map((entry) => `geoip:${entry}`));
  lines.push(...(match.ruleSetRefs ?? []).map((entry) => `ruleset:${entry}`));
  return lines.join("\n");
}

function parseRuleContent(content: string, type: RuleType): RuleMatchV2 {
  const lines = splitLines(content);
  const match: RuleMatchV2 = { domain: {}, process: {} };

  if (type === "process") {
    const nameContains: string[] = [];
    const pathContains: string[] = [];
    const pathRegex: string[] = [];
    for (const line of lines) {
      const pathValue = valueAfterPrefix(line, ["path:", "dir:", "process-path:"]);
      if (pathValue != null) {
        pathContains.push(pathValue);
        continue;
      }
      const regexValue = valueAfterPrefix(line, [
        "regex:",
        "path-regex:",
        "process-regex:",
      ]);
      if (regexValue != null) {
        pathRegex.push(ensureCaseInsensitiveRegex(regexValue));
        continue;
      }
      const processValue = valueAfterPrefix(line, [
        "process:",
        "name:",
        "process-name:",
      ]);
      nameContains.push(processValue ?? line);
    }
    match.process = {
      nameContains: unique(nameContains),
      pathContains: unique(pathContains),
      pathRegex: unique(pathRegex),
    };
    return match;
  }

  if (type === "domain") {
    const exact: string[] = [];
    const suffix: string[] = [];
    const keyword: string[] = [];
    const regex: string[] = [];
    const geosite: string[] = [];
    const ruleSetRefs: string[] = [];
    for (const line of lines) {
      if (line.startsWith("+.")) {
        suffix.push(line.slice(2).trim());
        continue;
      }
      const suffixValue = valueAfterPrefix(line, [
        "domain-suffix,",
        "domain-suffix:",
        "suffix:",
        "endswith:",
        "end-with:",
      ]);
      if (suffixValue != null) {
        suffix.push(suffixValue);
        continue;
      }
      const keywordValue = valueAfterPrefix(line, [
        "domain-keyword,",
        "domain-keyword:",
        "keyword:",
        "contains:",
      ]);
      if (keywordValue != null) {
        keyword.push(keywordValue);
        continue;
      }
      const regexValue = valueAfterPrefix(line, [
        "domain-regex,",
        "domain-regex:",
        "regex:",
        "regexp:",
      ]);
      if (regexValue != null) {
        regex.push(ensureCaseInsensitiveRegex(regexValue));
        continue;
      }
      const geositeValue = valueAfterPrefix(line, ["geosite:", "geosite,"]);
      if (geositeValue != null) {
        geosite.push(geositeValue);
        continue;
      }
      const rulesetValue = valueAfterPrefix(line, [
        "ruleset:",
        "rule-set:",
        "rule_set:",
      ]);
      if (rulesetValue != null) {
        ruleSetRefs.push(rulesetValue);
        continue;
      }
      exact.push(valueAfterPrefix(line, ["domain:", "exact:"]) ?? line);
    }
    match.domain = {
      exact: unique(exact),
      suffix: unique(suffix),
      keyword: unique(keyword),
      regex: unique(regex),
    };
    match.geosite = unique(geosite);
    match.ruleSetRefs = unique(ruleSetRefs);
    return match;
  }

  const ipCidr: string[] = [];
  const geoip: string[] = [];
  const ruleSetRefs: string[] = [];
  for (const line of lines) {
    const geoipValue = valueAfterPrefix(line, ["geoip:", "geoip,"]);
    if (geoipValue != null) {
      geoip.push(geoipValue);
      continue;
    }
    const rulesetValue = valueAfterPrefix(line, ["ruleset:", "rule-set:", "rule_set:"]);
    if (rulesetValue != null) {
      ruleSetRefs.push(rulesetValue);
      continue;
    }
    ipCidr.push(valueAfterPrefix(line, ["ip:", "cidr:", "ip-cidr:"]) ?? line);
  }
  match.ipCidr = unique(ipCidr);
  match.geoip = unique(geoip);
  match.ruleSetRefs = unique(ruleSetRefs);
  return match;
}

function inferActionMode(item: RuleItemV2): ActionMode {
  if (String(item.action?.type ?? "route").toLowerCase() === "reject") {
    return "reject";
  }
  const target = String(item.action?.targetPolicy ?? "").toLowerCase().trim();
  if (target === "direct") {
    return "direct";
  }
  if (target === "" || target === "proxy") {
    return "proxy";
  }
  return "policy";
}

function actionTagColor(mode: ActionMode): string {
  switch (mode) {
    case "direct":
      return "green";
    case "reject":
      return "red";
    case "policy":
      return "purple";
    default:
      return "blue";
  }
}

function actionLabel(mode: ActionMode, policyID: string, policyName?: string): string {
  switch (mode) {
    case "direct":
      return "直连";
    case "reject":
      return "拦截";
    case "policy":
      return `节点池(${(policyName ?? "").trim() || policyID || "-"})`;
    default:
      return "代理";
  }
}

function ruleContentHelpText(type: RuleType): string {
  switch (type) {
    case "domain":
      return [
        "使用场景:",
        "- 适合按域名、域名后缀、关键词、正则、GeoSite 或规则集匹配网站流量。",
        "",
        "作用:",
        "- 逐行填写一个域名匹配条件，命中后执行当前规则的命中动作。",
        "",
        "格式说明与示例:",
        "- 支持: exact / suffix / keyword / regex / geosite / ruleset。",
        "- 直接写域名也支持，默认按 exact 处理。",
        "- 示例:",
        "  google.com",
        "  exact:accounts.google.com",
        "  suffix:google.com",
        "  keyword:google",
        "  regex:(?i)^([a-z0-9-]+\\.)?google\\.com$",
        "  geosite:google",
        "  ruleset:google",
        "",
        "注意点:",
        "- 支持 # 注释（整行和行尾）。",
        "- 切换规则类型后，请同步检查现有内容是否仍符合当前格式。",
        "- 空内容不会通过保存校验。",
      ].join("\n");
    case "ip":
      return [
        "使用场景:",
        "- 适合按单个 IP、CIDR 网段、GeoIP 或规则集匹配网络目标。",
        "",
        "作用:",
        "- 逐行填写一个 IP 匹配条件，命中后执行当前规则的命中动作。",
        "",
        "格式说明与示例:",
        "- 支持: ip / cidr / geoip / ruleset。",
        "- 直接写 IP 或 CIDR 也支持。",
        "- 示例:",
        "  8.8.8.8",
        "  cidr:8.8.8.0/24",
        "  ip:8.8.4.4",
        "  geoip:us",
        "  ruleset:google",
        "",
        "注意点:",
        "- 支持 # 注释（整行和行尾）。",
        "- `8.8.8.8` 和 `8.8.8.0/24` 这类简写会自动按 IP/CIDR 解析。",
        "- 空内容不会通过保存校验。",
      ].join("\n");
    default:
      return [
        "使用场景:",
        "- 适合按进程名称、进程路径或路径正则匹配桌面应用流量。",
        "",
        "作用:",
        "- 逐行填写一个进程匹配条件，命中后执行当前规则的命中动作。",
        "",
        "格式说明与示例:",
        "- 支持: name / path / regex。",
        "- 直接写进程名也支持，默认按 name 处理。",
        "- `dir:` 也支持，等价于 `path:`。",
        "- `path:` / `dir:` 按“路径包含”匹配，不要求写完整绝对路径。",
        "- 示例:",
        "  # 例如目标进程路径:",
        "  # C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "  chrome.exe",
        "  name:chrome.exe",
        "  path:\\Chrome\\Application\\",
        "  dir:\\Chrome\\Application\\",
        "  path:Google\\Chrome\\Application\\chrome.exe",
        "  regex:(?i).*\\\\Google\\\\Chrome\\\\Application\\\\chrome\\.exe$",
        "",
        "注意点:",
        "- 支持 # 注释（整行和行尾）。",
        "- `chrome.exe` 这类简写会自动按进程名称包含匹配处理。",
        "- `path:\\Chrome\\Application\\` 会匹配所有路径中包含该目录片段的进程。",
        "- 空内容不会通过保存校验。",
      ].join("\n");
  }
}

function ruleContentPlaceholder(type: RuleType): string {
  switch (type) {
    case "domain":
      return [
        "google.com",
        "exact:accounts.google.com",
        "suffix:google.com",
        "keyword:google",
        "regex:(?i)^([a-z0-9-]+\\.)?google\\.com$",
        "geosite:google",
        "ruleset:google",
      ].join("\n");
    case "ip":
      return [
        "8.8.8.8",
        "cidr:8.8.8.0/24",
        "ip:8.8.4.4",
        "geoip:us",
        "ruleset:google",
      ].join("\n");
    default:
      return [
        "# 例如目标进程路径:",
        "# C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "chrome.exe",
        "name:chrome.exe",
        "path:\\Chrome\\Application\\",
        "dir:\\Chrome\\Application\\",
        "path:Google\\Chrome\\Application\\chrome.exe",
        "regex:(?i).*\\\\Google\\\\Chrome\\\\Application\\\\chrome\\.exe$",
      ].join("\n");
  }
}

function buildRuleDraft(item?: RuleItemV2): RuleDraft {
  if (!item) {
    return {
      id: "",
      name: "",
      enabled: true,
      type: "domain",
      content: "",
      actionMode: "proxy",
      policyID: "",
    };
  }
  const type = inferRuleType(item);
  const actionMode = inferActionMode(item);
  return {
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    type,
    content: stringifyRuleContent(item, type),
    actionMode,
    policyID: actionMode === "policy" ? String(item.action.targetPolicy ?? "") : "",
  };
}

function buildRuleFromDraft(draft: RuleDraft): RuleItemV2 {
  const action =
    draft.actionMode === "reject"
      ? { type: "reject" as const, targetPolicy: "reject" }
      : {
          type: "route" as const,
          targetPolicy:
            draft.actionMode === "direct"
              ? "direct"
              : draft.actionMode === "policy"
                ? draft.policyID.trim()
                : "proxy",
        };
  return {
    id: draft.id.trim(),
    name: (draft.name || draft.id).trim(),
    enabled: draft.enabled,
    match: parseRuleContent(draft.content, draft.type),
    action,
  };
}

function normalizeGroupOnMissMode(raw?: string): RuleMissMode {
  return raw === "proxy" ? "proxy" : "direct";
}

function normalizeGroups(groups: RuleGroup[]): RuleGroup[] {
  if (groups.length > 0) {
    return groups.map((group) => ({
      id: group.id,
      name: group.name || group.id,
      onMissMode: normalizeGroupOnMissMode(group.onMissMode),
      locked: Boolean(group.locked),
      rules: group.rules ?? [],
    }));
  }
  return [
    {
      id: "default",
      name: "默认分组",
      onMissMode: "direct" as RuleMissMode,
      locked: false,
      rules: [],
    },
  ];
}

function buildGroupID(existing: RuleGroup[]): string {
  let index = existing.length + 1;
  const used = new Set(existing.map((item) => item.id.toLowerCase()));
  let candidate = `group-${index}`;
  while (used.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `group-${index}`;
  }
  return candidate;
}

function buildRandomRuleID(existingRules: RuleItemV2[]): string {
  const used = new Set(existingRules.map((item) => item.id.toLowerCase()));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `rule-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  let index = existingRules.length + 1;
  let fallback = `rule-${index}`;
  while (used.has(fallback.toLowerCase())) {
    index += 1;
    fallback = `rule-${index}`;
  }
  return fallback;
}

function cloneRuleItem(source: RuleItemV2): RuleItemV2 {
  return {
    ...source,
    match: {
      domain: {
        exact: [...(source.match.domain.exact ?? [])],
        suffix: [...(source.match.domain.suffix ?? [])],
        keyword: [...(source.match.domain.keyword ?? [])],
        regex: [...(source.match.domain.regex ?? [])],
      },
      ipCidr: [...(source.match.ipCidr ?? [])],
      geoip: [...(source.match.geoip ?? [])],
      geosite: [...(source.match.geosite ?? [])],
      ruleSetRefs: [...(source.match.ruleSetRefs ?? [])],
      process: {
        nameContains: [...(source.match.process.nameContains ?? [])],
        pathContains: [...(source.match.process.pathContains ?? [])],
        pathRegex: [...(source.match.process.pathRegex ?? [])],
      },
    },
    action: {
      ...source.action,
    },
  };
}

function buildCopiedRuleID(sourceID: string, usedIDs: Set<string>): string {
  const base = sourceID.trim() || `rule-${Date.now().toString(36)}`;
  let dedupe = 1;
  let candidate = `${base}-copy`;
  while (usedIDs.has(candidate.toLowerCase())) {
    dedupe += 1;
    candidate = `${base}-copy-${dedupe}`;
  }
  usedIDs.add(candidate.toLowerCase());
  return candidate;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

const ADD_GROUP_TAB_ID = "__add-rule-group__";

function serializeRuleGroupsForCompare(groups: RuleGroup[]): string {
  return JSON.stringify(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      onMissMode: normalizeGroupOnMissMode(group.onMissMode),
      locked: Boolean(group.locked),
      rules: (group.rules ?? []).map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled !== false,
        actionType: rule.action?.type ?? "route",
        actionTarget: rule.action?.targetPolicy ?? "",
        match: rule.match,
      })),
    })),
  );
}

function reorderListByMove(
  source: string[],
  movingIDs: string[],
  targetID: string,
  placeAfter: boolean,
): string[] {
  const movingSet = new Set(movingIDs);
  const moving = source.filter((id) => movingSet.has(id));
  if (moving.length === 0) {
    return source;
  }
  const remain = source.filter((id) => !movingSet.has(id));
  const targetIndex = remain.findIndex((id) => id === targetID);
  if (targetIndex < 0) {
    return source;
  }
  const insertIndex = placeAfter ? targetIndex + 1 : targetIndex;
  const next = [...remain];
  next.splice(insertIndex, 0, ...moving);
  return next;
}

export function ComposedRulesTabs({
  groups,
  activeGroupId,
  policyGroups,
  onChange,
}: ComposedRulesTabsProps) {
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const isMobileView = isMobileRuntime();
  const sourceGroups = useMemo(() => normalizeGroups(groups), [groups]);
  const sourceActiveGroupID = useMemo(() => {
    if (sourceGroups.some((group) => group.id === activeGroupId)) {
      return activeGroupId;
    }
    return sourceGroups[0]?.id ?? "default";
  }, [activeGroupId, sourceGroups]);

  const [draftGroups, setDraftGroups] = useState<RuleGroup[]>(sourceGroups);
  const [draftActiveGroupID, setDraftActiveGroupID] = useState<string>(sourceActiveGroupID);
  const [draftTouched, setDraftTouched] = useState(false);
  const [openedGroupID, setOpenedGroupID] = useState<string>(() =>
    isMobileView ? "" : sourceActiveGroupID,
  );
  const hasUserSwitchedTabRef = useRef(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [copiedRules, setCopiedRules] = useState<RuleItemV2[]>([]);
  const [mobileSortMode, setMobileSortMode] = useState(false);
  const draggingRuleIDsRef = useRef<string[]>([]);
  const draggingGroupIDRef = useRef<string>("");
  const [rulePointerSortingActive, setRulePointerSortingActive] = useState(false);
  const [ruleSortPreview, setRuleSortPreview] = useState<{
    groupId: string;
    ruleId: string;
    position: "before" | "after";
  } | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<"add" | "edit">("add");
  const [editingGroupID, setEditingGroupID] = useState("");
  const [groupNameForm] = Form.useForm<{ groupName: string }>();
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRuleID, setEditingRuleID] = useState("");
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(() => buildRuleDraft());
  const normalizedGroups = draftGroups;

  const policyOptions = useMemo(
    () =>
      (policyGroups ?? [])
        .filter(
          (item) =>
            item.type === "node_pool" &&
            item.nodePool?.enabled !== false,
        )
        .map((item) => ({ label: item.name || item.id, value: item.id })),
    [policyGroups],
  );
  const policyNameByID = useMemo(
    () =>
      new Map(
        (policyGroups ?? []).map((item) => [
          String(item.id ?? "").trim(),
          String(item.name ?? "").trim() || String(item.id ?? "").trim(),
        ]),
      ),
    [policyGroups],
  );

  const sourceGroupsSignature = useMemo(
    () => serializeRuleGroupsForCompare(sourceGroups),
    [sourceGroups],
  );
  const draftGroupsSignature = useMemo(
    () => serializeRuleGroupsForCompare(normalizedGroups),
    [normalizedGroups],
  );
  const hasDraftChanges = useMemo(
    () =>
      draftGroupsSignature !== sourceGroupsSignature || draftActiveGroupID !== sourceActiveGroupID,
    [draftGroupsSignature, sourceGroupsSignature, draftActiveGroupID, sourceActiveGroupID],
  );
  const hasVisibleDraftChanges = draftTouched && hasDraftChanges;

  useEffect(() => {
    if (hasVisibleDraftChanges) {
      return;
    }
    setDraftGroups(sourceGroups);
    setDraftActiveGroupID(sourceActiveGroupID);
    setOpenedGroupID((previous) => {
      if (isMobileView && previous === "") {
        return "";
      }
      if (sourceGroups.some((group) => group.id === previous)) {
        return previous;
      }
      if (isMobileView) {
        return "";
      }
      return sourceActiveGroupID;
    });
  }, [hasVisibleDraftChanges, isMobileView, sourceGroups, sourceActiveGroupID]);

  useEffect(() => {
    if (!hasDraftChanges && draftTouched) {
      setDraftTouched(false);
    }
  }, [hasDraftChanges, draftTouched]);

  useEffect(() => {
    setOpenedGroupID((previous) => {
      if (isMobileView) {
        if (previous !== "" && normalizedGroups.some((group) => group.id === previous)) {
          return previous;
        }
        return "";
      }
      if (
        !hasUserSwitchedTabRef.current &&
        normalizedGroups.some((group) => group.id === draftActiveGroupID)
      ) {
        return draftActiveGroupID;
      }
      if (normalizedGroups.some((group) => group.id === previous)) {
        return previous;
      }
      if (normalizedGroups.some((group) => group.id === draftActiveGroupID)) {
        return draftActiveGroupID;
      }
      return normalizedGroups[0]?.id ?? "default";
    });
  }, [draftActiveGroupID, isMobileView, normalizedGroups]);

  const clearRulePointerSorting = () => {
    draggingRuleIDsRef.current = [];
    draggingGroupIDRef.current = "";
    setRulePointerSortingActive(false);
    setRuleSortPreview(null);
  };

  useEffect(() => {
    setSelectedRowKeys([]);
    clearRulePointerSorting();
  }, [openedGroupID]);

  useEffect(() => {
    if (!rulePointerSortingActive) {
      return;
    }
    const clearRulePointerSortingLater = () => {
      window.setTimeout(() => {
        clearRulePointerSorting();
      }, 0);
    };
    window.addEventListener("mouseup", clearRulePointerSortingLater);
    window.addEventListener("blur", clearRulePointerSorting);
    return () => {
      window.removeEventListener("mouseup", clearRulePointerSortingLater);
      window.removeEventListener("blur", clearRulePointerSorting);
    };
  }, [rulePointerSortingActive]);

  useDraftNavLock({
    lockClassName: "rules-draft-nav-lock",
    enabled: hasVisibleDraftChanges,
  });

  const currentGroup = useMemo(
    () =>
      normalizedGroups.find((group) => group.id === openedGroupID) ??
      normalizedGroups[0] ??
      {
        id: "default",
        name: "默认分组",
        onMissMode: "direct" as RuleMissMode,
        locked: false,
        rules: [],
      },
    [normalizedGroups, openedGroupID],
  );
  const currentGroupLocked = Boolean(currentGroup.locked);
  const isRuleModalReadonly = currentGroupLocked && Boolean(editingRuleID);

  const resolvedActiveGroupID = useMemo(() => {
    if (normalizedGroups.some((group) => group.id === draftActiveGroupID)) {
      return draftActiveGroupID;
    }
    return normalizedGroups[0]?.id ?? "default";
  }, [draftActiveGroupID, normalizedGroups]);
  const resolvedActiveGroup = useMemo(
    () =>
      normalizedGroups.find((group) => group.id === resolvedActiveGroupID) ??
      normalizedGroups[0] ??
      null,
    [normalizedGroups, resolvedActiveGroupID],
  );
  const resolvedActiveGroupName = String(
    resolvedActiveGroup?.name ?? resolvedActiveGroup?.id ?? "未设置",
  ).trim() || "未设置";

  useEffect(() => {
    if (!isMobileView) {
      dispatchRulesUiState({});
      return;
    }
    dispatchRulesUiState({
      activeGroupId: resolvedActiveGroupID,
      activeGroupName: resolvedActiveGroupName,
    });
  }, [isMobileView, resolvedActiveGroupID, resolvedActiveGroupName]);

  useEffect(() => {
    return () => {
      dispatchRulesUiState({});
    };
  }, []);

  const commitGroups = async (nextGroups: RuleGroup[], nextActiveGroupID: string) => {
    const normalized = normalizeGroups(nextGroups);
    const resolvedActive = normalized.some((group) => group.id === nextActiveGroupID)
      ? nextActiveGroupID
      : (normalized[0]?.id ?? "default");
    setDraftTouched(true);
    setDraftGroups(normalized);
    setDraftActiveGroupID(resolvedActive);
    setOpenedGroupID((previous) => {
      if (isMobileView && previous === "") {
        return "";
      }
      if (normalized.some((group) => group.id === previous)) {
        return previous;
      }
      if (isMobileView) {
        return "";
      }
      return resolvedActive;
    });
    return true;
  };

  const exitMobileSortMode = () => {
    setMobileSortMode(false);
  };

  const enterMobileSortMode = () => {
    if (currentGroupLocked) {
      notice.warning("当前分组已锁定，无法调整规则顺序");
      return;
    }
    if ((currentGroup.rules?.length ?? 0) < 2) {
      notice.warning("没有规则或规则少于 2 条时，无法进入排序模式");
      return;
    }
    setMobileSortMode(true);
    notice.info("已进入排序模式，点击卡片左侧上下箭头即可移动规则", {
      title: "排序模式",
      durationMs: 1800,
      placement: "top-center",
    });
  };

  const copySingleRule = (rule: RuleItemV2) => {
    setCopiedRules([cloneRuleItem(rule)]);
    notice.success(`已复制规则：${rule.name || rule.id}`);
  };

  const removeSingleRule = (rule: RuleItemV2) => {
    if (currentGroupLocked) {
      notice.warning("当前分组已锁定，无法删除规则");
      return;
    }
    const nextGroups = normalizedGroups.map((group) =>
      group.id === currentGroup.id
        ? {
            ...group,
            rules: (group.rules ?? []).filter((item) => item.id !== rule.id),
          }
        : group,
    );
    void commitGroups(nextGroups, resolvedActiveGroupID);
    setSelectedRowKeys((current) => current.filter((selectedID) => selectedID !== rule.id));
  };

  const moveCurrentGroupRule = (ruleID: string, direction: "up" | "down") => {
    const sourceRules = currentGroup.rules ?? [];
    const sourceOrder = sourceRules.map((item) => item.id);
    const currentIndex = sourceOrder.indexOf(ruleID);
    if (currentIndex < 0) {
      return;
    }
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= sourceOrder.length) {
      return;
    }
    const targetRuleID = sourceOrder[targetIndex] ?? "";
    if (targetRuleID === "") {
      return;
    }
    const nextOrder = reorderListByMove(sourceOrder, [ruleID], targetRuleID, direction === "down");
    if (sameStringArray(sourceOrder, nextOrder)) {
      return;
    }
    const ruleByID = new Map(sourceRules.map((item) => [item.id, item]));
    const nextRules = nextOrder
      .map((ruleID) => ruleByID.get(ruleID))
      .filter((item): item is RuleItemV2 => Boolean(item));
    const nextGroups = normalizedGroups.map((group) =>
      group.id === currentGroup.id
        ? {
            ...group,
            rules: nextRules,
          }
        : group,
    );
    void commitGroups(nextGroups, resolvedActiveGroupID);
  };

  useEffect(() => {
    setMobileSortMode(false);
  }, [openedGroupID, isMobileView]);

  const activateRuleGroup = (groupID: string): void => {
    if (groupID === resolvedActiveGroupID) {
      return;
    }
    void commitGroups(normalizedGroups, groupID);
  };

  const openAddGroupModal = () => {
    setGroupModalMode("add");
    setEditingGroupID("");
    groupNameForm.setFieldsValue({ groupName: "" });
    setGroupModalOpen(true);
  };

  useEffect(() => {
    if (!isMobileView) {
      return;
    }
    return listenRulesUiAction((detail) => {
      if (detail.action !== "open_add_group") {
        return;
      }
      openAddGroupModal();
    });
  }, [isMobileView]);

  const openEditGroupModal = (group: RuleGroup) => {
    setGroupModalMode("edit");
    setEditingGroupID(group.id);
    groupNameForm.setFieldsValue({ groupName: group.name || group.id });
    setGroupModalOpen(true);
  };

  const confirmRemoveGroup = (group: RuleGroup) => {
    if (normalizedGroups.length <= 1) {
      notice.warning("至少保留一个规则分组");
      return;
    }
    Modal.confirm({
      title: "删除分组",
      content: (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div>{`是否删除分组 ${group.name || group.id} ?`}</div>
          <Typography.Text type="secondary">分组内的规则也会一并删除</Typography.Text>
        </div>
      ),
      okText: "确定",
      cancelText: "取消",
      onOk: async () => {
        const nextGroups = normalizedGroups.filter((item) => item.id !== group.id);
        const nextActiveGroupID = nextGroups.some((item) => item.id === resolvedActiveGroupID)
          ? resolvedActiveGroupID
          : (nextGroups[0]?.id ?? "default");
        await commitGroups(nextGroups, nextActiveGroupID);
        if (openedGroupID === group.id) {
          hasUserSwitchedTabRef.current = false;
        }
        setSelectedRowKeys((current) =>
          current.filter(
            (selectedID) => !(group.rules ?? []).some((rule) => rule.id === selectedID),
          ),
        );
      },
    });
  };

  const submitRuleDraftChanges = async () => {
    if (savingDraft || !hasVisibleDraftChanges) {
      return;
    }
    setSavingDraft(true);
    try {
      const committed = await onChange(normalizedGroups, resolvedActiveGroupID);
      if (!committed) {
        return;
      }
      setDraftTouched(false);
    } catch (error) {
      draftNotice.notifySaveFailed("规则草稿", error);
    } finally {
      setSavingDraft(false);
    }
  };

  const discardRuleDraftChanges = () => {
    setDraftTouched(false);
    setDraftGroups(sourceGroups);
    setDraftActiveGroupID(sourceActiveGroupID);
    setOpenedGroupID((previous) => {
      if (isMobileView && previous === "") {
        return "";
      }
      if (sourceGroups.some((group) => group.id === previous)) {
        return previous;
      }
      if (isMobileView) {
        return "";
      }
      return sourceActiveGroupID;
    });
    setSelectedRowKeys([]);
    clearRulePointerSorting();
    draftNotice.notifyDraftReverted("规则");
  };

  const handleRuleSortStart =
    (group: RuleGroup, record: RuleItemV2) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0 || group.locked) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const groupRules = group.rules ?? [];
      const candidateIDs = selectedRowKeys.includes(record.id) ? selectedRowKeys : [record.id];
      const nextDraggingIDs = candidateIDs.filter((id) => groupRules.some((item) => item.id === id));
      const draggingIDs = nextDraggingIDs.length > 0 ? nextDraggingIDs : [record.id];
      draggingRuleIDsRef.current = draggingIDs;
      draggingGroupIDRef.current = group.id;
      setRulePointerSortingActive(true);
      notice.info(`上下拖拽排序(共${draggingIDs.length}行)`, {
        title: "拖拽排序",
        durationMs: 1800,
        placement: "top-center",
      });
    };

  const handleRuleSortPreview =
    (group: RuleGroup, record: RuleItemV2) => (event: ReactMouseEvent<HTMLTableRowElement>) => {
      const draggingRuleIDs = draggingRuleIDsRef.current;
      const draggingGroupID = draggingGroupIDRef.current;
      if (
        group.locked ||
        draggingRuleIDs.length === 0 ||
        draggingGroupID !== group.id ||
        draggingRuleIDs.includes(record.id)
      ) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const position = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
      setRuleSortPreview((previous) =>
        previous?.groupId === group.id &&
        previous.ruleId === record.id &&
        previous.position === position
          ? previous
          : {
              groupId: group.id,
              ruleId: record.id,
              position,
            },
      );
    };

  const handleRuleSortLeave = (group: RuleGroup, record: RuleItemV2) => () => {
    setRuleSortPreview((previous) =>
      previous?.groupId === group.id && previous.ruleId === record.id ? null : previous,
    );
  };

  const handleRuleSortCommit =
    (group: RuleGroup, record: RuleItemV2) => (event: ReactMouseEvent<HTMLTableRowElement>) => {
      if (event.button !== 0 || group.locked) {
        return;
      }
      const draggingRuleIDs = draggingRuleIDsRef.current;
      const draggingGroupID = draggingGroupIDRef.current;
      if (
        draggingRuleIDs.length === 0 ||
        draggingGroupID !== group.id ||
        draggingRuleIDs.includes(record.id)
      ) {
        clearRulePointerSorting();
        return;
      }
      event.preventDefault();
      const sourceRules = group.rules ?? [];
      const source = sourceRules.map((item) => item.id);
      const rect = event.currentTarget.getBoundingClientRect();
      const placeAfter = event.clientY > rect.top + rect.height / 2;
      const reordered = reorderListByMove(source, draggingRuleIDs, record.id, placeAfter);
      if (sameStringArray(source, reordered)) {
        clearRulePointerSorting();
        return;
      }
      const byID = new Map(sourceRules.map((item) => [item.id, item]));
      const nextRules = reordered
        .map((id) => byID.get(id))
        .filter((item): item is RuleItemV2 => Boolean(item));
      const nextGroups = normalizedGroups.map((targetGroup) =>
        targetGroup.id === group.id
          ? {
              ...targetGroup,
              rules: nextRules,
            }
          : targetGroup,
      );
      void commitGroups(nextGroups, resolvedActiveGroupID);
      clearRulePointerSorting();
    };

  const columns: ColumnsType<RuleItemV2> = [
    {
      title: "",
      key: "drag",
      width: 40,
      align: "center",
      render: (_value, record) => (
        <span
          style={{
            color: currentGroupLocked ? "#d9d9d9" : "#bfbfbf",
            cursor: currentGroupLocked ? "not-allowed" : "grab",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: currentGroupLocked ? 0.72 : 1,
          }}
          onMouseDown={handleRuleSortStart(currentGroup, record)}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <BiIcon name="grip-vertical" />
        </span>
      ),
    },
    {
      title: "序号",
      key: "index",
      className: "table-index-column",
      width: 74,
      onHeaderCell: () => ({
        className: "table-index-column",
        style: {
          width: 74,
          minWidth: 74,
          maxWidth: 74,
        },
      }),
      onCell: () => ({
        className: "table-index-column",
        style: {
          width: 74,
          minWidth: 74,
          maxWidth: 74,
        },
      }),
      render: (_value, _record, index) => index + 1,
    },
    {
      title: "规则名称",
      dataIndex: "name",
      key: "name",
      render: (_value, record) => <Typography.Text strong>{record.name || record.id}</Typography.Text>,
    },
    {
      title: "匹配概览",
      key: "summary",
      render: (_value, record) => (
        <Typography.Text type="secondary">{summarizeRuleMatch(record.match)}</Typography.Text>
      ),
    },
    {
      title: "动作",
      key: "action",
      width: 180,
      render: (_value, record) => {
        const mode = inferActionMode(record);
        const policyID = String(record.action?.targetPolicy ?? "").trim();
        const policyName = policyNameByID.get(policyID) ?? "";
        return <Tag color={actionTagColor(mode)}>{actionLabel(mode, policyID, policyName)}</Tag>;
      },
    },
    {
      title: "启用",
      dataIndex: "enabled",
      width: 120,
      render: (_value, record) => (
        <div className="table-switch-only-cell">
          <Switch
            checked={record.enabled}
            disabled={currentGroupLocked}
            onChange={(checked) => {
              if (currentGroupLocked) {
                notice.warning("当前分组已锁定，无法修改规则");
                return;
              }
              const nextGroups = normalizedGroups.map((group) =>
                group.id === currentGroup.id
                  ? {
                      ...group,
                      rules: (group.rules ?? []).map((item) =>
                        item.id === record.id ? { ...item, enabled: checked } : item,
                      ),
                    }
                  : group,
              );
              void commitGroups(nextGroups, resolvedActiveGroupID);
            }}
          />
        </div>
      ),
    },
    {
      title: "操作",
      key: "operation",
      width: 180,
      render: (_value, record) => (
        <Space size={8}>
          <Button
            size="small"
            onClick={() => {
              setEditingRuleID(record.id);
              setRuleDraft(buildRuleDraft(record));
              setRuleModalOpen(true);
            }}
          >
            {currentGroupLocked ? "查看" : "编辑"}
          </Button>
          <Button
            size="small"
            danger
            disabled={currentGroupLocked}
            onClick={() => {
              if (currentGroupLocked) {
                notice.warning("当前分组已锁定，无法删除规则");
                return;
              }
              const nextGroups = normalizedGroups.map((group) =>
                group.id === currentGroup.id
                  ? {
                      ...group,
                      rules: (group.rules ?? []).filter((item) => item.id !== record.id),
                    }
                  : group,
              );
              void commitGroups(nextGroups, resolvedActiveGroupID);
              setSelectedRowKeys((current) =>
                current.filter((selectedID) => selectedID !== record.id),
              );
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const currentGroupRules = currentGroup.rules ?? [];

  const renderMobileCollapsedGroupHeaderActions = (group: RuleGroup) => (
    <div className="subscriptions-mobile-group-header-actions">
      {group.id !== resolvedActiveGroupID ? (
        <Tooltip title="激活规则分组">
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="check-circle" />}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              activateRuleGroup(group.id);
            }}
          />
        </Tooltip>
      ) : null}
      <Tooltip title="编辑分组">
        <Button
          type="text"
          size="small"
          icon={<BiIcon name="pencil-square" />}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openEditGroupModal(group);
          }}
        />
      </Tooltip>
      <Tooltip title="删除分组">
        <Button
          type="text"
          size="small"
          danger
          icon={<BiIcon name="trash" />}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            confirmRemoveGroup(group);
          }}
        />
      </Tooltip>
    </div>
  );

  const renderMobileExpandedGroupHeaderActions = (group: RuleGroup) => (
    <div className="subscriptions-mobile-group-header-actions is-expanded">
      {group.id !== resolvedActiveGroupID ? (
        <Tooltip title="激活规则分组">
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="check-circle-fill" />}
            onClick={() => {
              activateRuleGroup(group.id);
            }}
          />
        </Tooltip>
      ) : null}
      <Tooltip title="编辑分组">
        <Button
          type="text"
          size="small"
          icon={<BiIcon name="pencil-square" />}
          onClick={() => {
            openEditGroupModal(group);
          }}
        />
      </Tooltip>
      <Tooltip title="删除分组">
        <Button
          type="text"
          size="small"
          danger
          icon={<BiIcon name="trash" />}
          onClick={() => {
            confirmRemoveGroup(group);
          }}
        />
      </Tooltip>
    </div>
  );

  const renderMobileExpandedGroupToolbar = (group: RuleGroup) => {
    const missMode = normalizeGroupOnMissMode(group.onMissMode);
    return (
      <div className="rules-mobile-group-toolbar">
        <div className="rules-mobile-group-toolbar-actions">
          <Tooltip title="添加规则">
            <Button
              type="text"
              size="small"
              icon={<BiIcon name="plus-lg" />}
              disabled={Boolean(group.locked)}
              onClick={() => {
                setEditingRuleID("");
                setRuleDraft(buildRuleDraft());
                setRuleModalOpen(true);
              }}
            />
          </Tooltip>
          <Tooltip title={copiedRules.length > 0 ? `粘贴 ${copiedRules.length} 条规则` : "当前没有可粘贴规则"}>
            <Button
              type="text"
              size="small"
              icon={<BiIcon name="file-earmark-text" />}
              disabled={copiedRules.length === 0 || Boolean(group.locked)}
              onClick={() => {
                if (group.locked) {
                  notice.warning("当前分组已锁定，无法粘贴规则");
                  return;
                }
                if (copiedRules.length === 0) {
                  notice.warning("当前没有可粘贴的规则");
                  return;
                }
                const targetRules = group.rules ?? [];
                const usedIDs = new Set(targetRules.map((item) => item.id.toLowerCase()));
                const pastedRules = copiedRules.map((item) => {
                  const copied = cloneRuleItem(item);
                  copied.id = buildCopiedRuleID(copied.id, usedIDs);
                  return copied;
                });
                const nextGroups = normalizedGroups.map((targetGroup) =>
                  targetGroup.id === group.id
                    ? {
                        ...targetGroup,
                        rules: [...(targetGroup.rules ?? []), ...pastedRules],
                      }
                    : targetGroup,
                );
                void commitGroups(nextGroups, resolvedActiveGroupID).then((committed) => {
                  if (!committed) {
                    return;
                  }
                  notice.success(`已粘贴 ${pastedRules.length} 条规则到分组：${group.name || group.id}`);
                });
              }}
            />
          </Tooltip>
          <Tooltip title={mobileSortMode ? "退出排序模式" : "进入排序模式"}>
            <Button
              type="text"
              size="small"
              icon={<BiIcon name={mobileSortMode ? "x-lg" : "arrow-up-down"} />}
              disabled={Boolean(group.locked) || (!mobileSortMode && currentGroupRules.length < 2)}
              onClick={() => {
                if (mobileSortMode) {
                  exitMobileSortMode();
                  return;
                }
                enterMobileSortMode();
              }}
            />
          </Tooltip>
          <Tooltip title={group.locked ? "解锁分组" : "锁定分组"}>
            <Button
              type="text"
              size="small"
              icon={<BiIcon name={group.locked ? "lock-fill" : "unlock-fill"} />}
              onClick={() => {
                const nextGroups = normalizedGroups.map((targetGroup) =>
                  targetGroup.id === group.id
                    ? { ...targetGroup, locked: !Boolean(targetGroup.locked) }
                    : targetGroup,
                );
                void commitGroups(nextGroups, resolvedActiveGroupID).then((committed) => {
                  if (!committed) {
                    return;
                  }
                  notice.success(`${group.name || group.id} 已${group.locked ? "解除锁定" : "锁定"}`);
                });
              }}
            />
          </Tooltip>
          <div
            className={`rules-mobile-group-toolbar-miss ${missMode === "proxy" ? "is-proxy" : "is-direct"}`}
          >
            <HelpLabel
              label={
                <Typography.Text type="secondary" className="rules-mobile-group-toolbar-label">
                  漏网之鱼
                </Typography.Text>
              }
              helpTitle="漏网之鱼"
              helpMaxWidth={320}
              helpContent={{
                effect: "当前分组内没有任何规则命中时，会按这里选择的方式继续处理连接。",
                caution:
                  "只有未命中规则才会触发。选择“直连”会直接放行，选择“代理”会交给代理链路。",
              }}
            />
            {missMode === "direct" ? (
              <span className="rules-mobile-miss-mode-text is-direct">直连</span>
            ) : null}
            <button
              type="button"
              className={`rules-mobile-miss-mode-switch ${missMode === "proxy" ? "is-proxy" : "is-direct"}`}
              disabled={Boolean(group.locked)}
              aria-label="切换漏网之鱼处理方式"
              aria-pressed={missMode === "proxy"}
              onClick={() => {
                const nextMode: RuleMissMode = missMode === "proxy" ? "direct" : "proxy";
                const nextGroups = normalizedGroups.map((targetGroup) =>
                  targetGroup.id === group.id
                    ? {
                        ...targetGroup,
                        onMissMode: nextMode,
                      }
                    : targetGroup,
                );
                void commitGroups(nextGroups, resolvedActiveGroupID);
              }}
            >
              <span className="rules-mobile-miss-mode-switch-thumb" />
            </button>
            {missMode === "proxy" ? (
              <span className="rules-mobile-miss-mode-text is-proxy">代理</span>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderMobileRuleCard = (rule: RuleItemV2, index: number) => {
    const mode = inferActionMode(rule);
    const policyID = String(rule.action?.targetPolicy ?? "").trim();
    const policyName = policyNameByID.get(policyID) ?? "";
    const canMoveUp = index > 0;
    const canMoveDown = index < currentGroupRules.length - 1;
    return (
      <MobileSwipeActionCard
        leadingActions={
          mobileSortMode
            ? []
            : [
                {
                  key: "sort",
                  label: "排序",
                  icon: <BiIcon name="arrow-up-down" />,
                  autoTriggerOnOpen: true,
                  disabled: currentGroupLocked || currentGroupRules.length < 2,
                  onClick: () => {
                    enterMobileSortMode();
                  },
                },
              ]
        }
        trailingActions={
          mobileSortMode
            ? []
            : [
                {
                  key: "copy",
                  label: "复制",
                  icon: <BiIcon name="copy" />,
                  onClick: () => {
                    copySingleRule(rule);
                  },
                },
                {
                  key: "edit",
                  label: currentGroupLocked ? "查看" : "编辑",
                  icon: <BiIcon name="pencil-square" />,
                  onClick: () => {
                    setEditingRuleID(rule.id);
                    setRuleDraft(buildRuleDraft(rule));
                    setRuleModalOpen(true);
                  },
                },
                {
                  key: "delete",
                  label: "删除",
                  icon: <BiIcon name="trash" />,
                  danger: true,
                  disabled: currentGroupLocked,
                  onClick: () => {
                    removeSingleRule(rule);
                  },
                },
              ]
        }
      >
        <div
          data-mobile-rule-id={rule.id}
          className={`rules-mobile-rule-card${rule.enabled ? "" : " is-disabled"}`}
        >
          {mobileSortMode ? (
            <div className="rules-mobile-rule-card-sort-controls">
              <button
                type="button"
                className="rules-mobile-rule-card-sort-btn"
                disabled={!canMoveUp}
                onClick={() => {
                  moveCurrentGroupRule(rule.id, "up");
                }}
              >
                <BiIcon name="chevron-up" />
              </button>
              <button
                type="button"
                className="rules-mobile-rule-card-sort-btn"
                disabled={!canMoveDown}
                onClick={() => {
                  moveCurrentGroupRule(rule.id, "down");
                }}
              >
                <BiIcon name="chevron-down" />
              </button>
            </div>
          ) : null}
          <div className="rules-mobile-rule-card-body">
            <div className="rules-mobile-rule-card-header">
              <div className="rules-mobile-rule-card-title-wrap">
                <Typography.Text strong className="rules-mobile-rule-card-title">
                  {rule.name || rule.id}
                </Typography.Text>
                <Tag color={actionTagColor(mode)} className="rules-mobile-rule-card-action-tag">
                  {actionLabel(mode, policyID, policyName)}
                </Tag>
              </div>
              <div className="rules-mobile-rule-card-meta">
                <Typography.Text type="secondary">#{index + 1}</Typography.Text>
                <Switch
                  size="small"
                  checked={rule.enabled}
                  disabled={currentGroupLocked}
                  onChange={(checked) => {
                    if (currentGroupLocked) {
                      notice.warning("当前分组已锁定，无法修改规则");
                      return;
                    }
                    const nextGroups = normalizedGroups.map((group) =>
                      group.id === currentGroup.id
                        ? {
                            ...group,
                            rules: (group.rules ?? []).map((item) =>
                              item.id === rule.id ? { ...item, enabled: checked } : item,
                            ),
                          }
                        : group,
                    );
                    void commitGroups(nextGroups, resolvedActiveGroupID);
                  }}
                />
              </div>
            </div>
            <Typography.Text type="secondary" className="rules-mobile-rule-card-summary">
              {summarizeRuleMatch(rule.match)}
            </Typography.Text>
          </div>
        </div>
      </MobileSwipeActionCard>
    );
  };

  return (
    <Space
      direction="vertical"
      size={12}
      style={{ width: "100%" }}
    >
      <DraftActionBar
        visible={hasVisibleDraftChanges}
        apply={{
          title: "保存规则草稿",
          label: "保存",
          icon: <BiIcon name="check-lg" />,
          loading: savingDraft,
          onClick: () => {
            void submitRuleDraftChanges();
          },
        }}
        discard={{
          title: "取消规则草稿",
          label: "取消",
          icon: <BiIcon name="x-lg" />,
          disabled: savingDraft,
          onClick: discardRuleDraftChanges,
        }}
      />
      {isMobileView ? (
        <Space
          direction="vertical"
          size={12}
          style={{ width: "100%" }}
        >
          {openedGroupID ? (
            <div className="subscriptions-mobile-sticky-active-group">
              <div className="subscriptions-mobile-active-group-panel rules-mobile-active-group-panel">
                <div className="subscriptions-mobile-group-header is-sticky">
                  <button
                    type="button"
                    className="subscriptions-mobile-group-header-main subscriptions-mobile-group-header-toggle"
                    onClick={() => {
                      exitMobileSortMode();
                      hasUserSwitchedTabRef.current = true;
                      setOpenedGroupID("");
                    }}
                  >
                    <span className="subscriptions-mobile-group-collapse-icon">
                      <BiIcon name="chevron-up" />
                    </span>
                    <div className="subscriptions-mobile-group-header-text">
                      <span className="subscriptions-mobile-group-header-name-row">
                        <Typography.Text strong className="subscriptions-mobile-group-header-name">
                          {currentGroup.name || currentGroup.id}
                        </Typography.Text>
                        {currentGroup.id === resolvedActiveGroupID ? <span className="active-group-dot" /> : null}
                      </span>
                      <Typography.Text
                        type="secondary"
                        className="subscriptions-mobile-group-header-meta"
                      >
                        {currentGroup.id === resolvedActiveGroupID ? "当前活动规则分组" : "规则分组"} ·{" "}
                        {currentGroupRules.length} 条规则
                      </Typography.Text>
                    </div>
                  </button>
                  {renderMobileExpandedGroupHeaderActions(currentGroup)}
                </div>
                {renderMobileExpandedGroupToolbar(currentGroup)}
                <div className="rules-mobile-active-group-list-scroll">
                  <div className="rules-mobile-rule-list">
                    {currentGroupRules.length === 0 ? (
                      <div className="subscriptions-mobile-empty-state is-panel-empty">
                        <Typography.Text type="secondary">当前分组暂无规则。</Typography.Text>
                      </div>
                    ) : (
                      currentGroupRules.map((rule, index) => (
                        <div key={rule.id}>
                          {renderMobileRuleCard(rule, index)}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <Collapse
            accordion
            className="subscriptions-mobile-group-collapse rules-mobile-group-collapse"
            activeKey={openedGroupID ? [openedGroupID] : []}
            onChange={(key) => {
              const nextKey = Array.isArray(key)
                ? (key[0] ? String(key[0]) : "")
                : key
                  ? String(key)
                  : "";
              exitMobileSortMode();
              hasUserSwitchedTabRef.current = true;
              setOpenedGroupID(nextKey);
            }}
            items={normalizedGroups
              .filter((group) => group.id !== openedGroupID)
              .map((group) => ({
              key: group.id,
              label: (
                <div className="subscriptions-mobile-group-header">
                  <div className="subscriptions-mobile-group-header-main">
                    <div className="subscriptions-mobile-group-header-text">
                      <span className="subscriptions-mobile-group-header-name-row">
                        <Typography.Text strong className="subscriptions-mobile-group-header-name">
                          {group.name || group.id}
                        </Typography.Text>
                        {group.id === resolvedActiveGroupID ? <span className="active-group-dot" /> : null}
                      </span>
                      <Typography.Text
                        type="secondary"
                        className="subscriptions-mobile-group-header-meta"
                      >
                        {group.id === resolvedActiveGroupID ? "当前活动规则分组" : "规则分组"} ·{" "}
                        {(group.rules ?? []).length} 条规则
                      </Typography.Text>
                    </div>
                  </div>
                  {group.id === openedGroupID ? null : renderMobileCollapsedGroupHeaderActions(group)}
                </div>
              ),
              children: null,
            }))}
          />
        </Space>
      ) : (
        <>
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Space
          size={8}
          align="center"
          wrap
        >
          <HelpLabel
            label={
              <Typography.Text strong style={{ fontSize: 15, color: "#1f2430" }}>
                规则管理
              </Typography.Text>
            }
            helpContent={{
              scene: "用于管理规则分组、切换激活分组，以及维护分组内的规则内容、顺序和默认漏网策略。",
              effect:
                "当前激活分组决定运行时实际使用的规则集合；标题旁绿色圆点表示当前已激活分组，也可通过工具栏或 TAB 悬停按钮切换激活分组。",
              caution:
                "规则修改后需要先保存草稿；规则必须激活且重启服务后才会生效；锁定分组后不可再编辑、排序或删除分组内规则。",
            }}
          />
        </Space>
      </Space>

      <Tabs
        className="rules-composed-tabs"
        activeKey={currentGroup.id}
        onChange={(key) => {
          if (key === ADD_GROUP_TAB_ID) {
            openAddGroupModal();
            return;
          }
          hasUserSwitchedTabRef.current = true;
          setOpenedGroupID(key);
        }}
        items={[
          ...normalizedGroups.map((group) => ({
            key: group.id,
            label: (
              <span
                className="group-tab-label rules-group-tab-label"
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openEditGroupModal(group);
                }}
              >
                {group.id === resolvedActiveGroupID ? (
                  <span className="active-group-dot" />
                ) : null}
                <span className="group-tab-name">{group.name || group.id}</span>
                {group.id !== resolvedActiveGroupID ? (
                  <Button
                    size="small"
                    type="primary"
                    className="group-tab-activate-popover"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      activateRuleGroup(group.id);
                    }}
                  >
                    激活
                  </Button>
                ) : null}
                <Button
                  size="small"
                  type="text"
                  className="group-tab-close-btn rules-group-tab-close-btn"
                  icon={<BiIcon name="x-lg" />}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    confirmRemoveGroup(group);
                  }}
                />
              </span>
            ),
            children: (
              <Space
                direction="vertical"
                size={10}
                style={{ width: "100%" }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <Space size={8} wrap>
                    <Button
                      type="primary"
                      size="small"
                      icon={<BiIcon name="plus-lg" />}
                      disabled={Boolean(group.locked)}
                      onClick={() => {
                        setEditingRuleID("");
                        setRuleDraft(buildRuleDraft());
                        setRuleModalOpen(true);
                      }}
                    >
                      添加规则
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      disabled={group.id === resolvedActiveGroupID}
                      onClick={() => {
                        activateRuleGroup(group.id);
                      }}
                    >
                      激活规则
                    </Button>
                    <Button
                      size="small"
                      icon={<BiIcon name="copy" />}
                      disabled={selectedRowKeys.length === 0}
                      onClick={() => {
                        const sourceRules = group.rules ?? [];
                        const selectedSet = new Set(selectedRowKeys);
                        const rulesToCopy = sourceRules.filter((item) => selectedSet.has(item.id));
                        if (rulesToCopy.length === 0) {
                          notice.warning("请先选择要复制的规则");
                          return;
                        }
                        setCopiedRules(rulesToCopy.map((item) => cloneRuleItem(item)));
                        notice.success(`已复制 ${rulesToCopy.length} 条规则`);
                      }}
                    >
                      复制
                    </Button>
                    <Button
                      size="small"
                      icon={<BiIcon name="file-earmark-text" />}
                      disabled={copiedRules.length === 0 || Boolean(group.locked)}
                      onClick={() => {
                        if (group.locked) {
                          notice.warning("当前分组已锁定，无法粘贴规则");
                          return;
                        }
                        if (copiedRules.length === 0) {
                          notice.warning("当前没有可粘贴的规则");
                          return;
                        }
                        const targetRules = group.rules ?? [];
                        const usedIDs = new Set(targetRules.map((item) => item.id.toLowerCase()));
                        const pastedRules = copiedRules.map((item) => {
                          const copied = cloneRuleItem(item);
                          copied.id = buildCopiedRuleID(copied.id, usedIDs);
                          return copied;
                        });
                        const nextGroups = normalizedGroups.map((targetGroup) =>
                          targetGroup.id === group.id
                            ? {
                                ...targetGroup,
                                rules: [...(targetGroup.rules ?? []), ...pastedRules],
                              }
                            : targetGroup,
                        );
                        void commitGroups(nextGroups, resolvedActiveGroupID).then((committed) => {
                          if (!committed) {
                            return;
                          }
                          setSelectedRowKeys(pastedRules.map((item) => item.id));
                          notice.success(
                            `已粘贴 ${pastedRules.length} 条规则到分组：${group.name || group.id}`,
                          );
                        });
                      }}
                    >
                      粘贴{copiedRules.length > 0 ? ` (${copiedRules.length})` : ""}
                    </Button>
                  </Space>
                  <Space size={8} align="center" wrap>
                    <HelpLabel
                      label="漏网之鱼"
                      helpContent={[
                        "使用场景:",
                        "- 当前规则分组中，未命中任何规则时的默认走向。",
                        "",
                        "作用:",
                        "- 对应当前分组未命中流量的最终路由：走代理或走直连。",
                        "",
                        "注意点:",
                        "- 命中动作优先于漏网之鱼。",
                        "- 分组锁定后不可修改该配置。",
                      ].join("\n")}
                    />
                    <Radio.Group
                      size="small"
                      value={normalizeGroupOnMissMode(group.onMissMode)}
                      disabled={Boolean(group.locked)}
                      onChange={(event) => {
                        const nextMode: RuleMissMode =
                          event.target.value === "proxy" ? "proxy" : "direct";
                        const nextGroups = normalizedGroups.map((targetGroup) =>
                          targetGroup.id === group.id
                            ? {
                                ...targetGroup,
                                onMissMode: nextMode,
                              }
                            : targetGroup,
                        );
                        void commitGroups(nextGroups, resolvedActiveGroupID);
                      }}
                    >
                      <Radio value="proxy">走代理</Radio>
                      <Radio value="direct">走直连</Radio>
                    </Radio.Group>
                    <Tooltip
                      title={
                        group.locked
                          ? "分组已锁定（禁止保存修改/排序/删除），点击解锁"
                          : "分组未锁定（允许编辑），点击锁定"
                      }
                    >
                      <Button
                        size="small"
                        type="text"
                        aria-label={group.locked ? "解锁分组" : "锁定分组"}
                        icon={<BiIcon name={group.locked ? "lock-fill" : "unlock-fill"} />}
                        onClick={() => {
                          const nextGroups = normalizedGroups.map((targetGroup) =>
                            targetGroup.id === group.id
                              ? { ...targetGroup, locked: !Boolean(targetGroup.locked) }
                              : targetGroup,
                          );
                          void commitGroups(nextGroups, resolvedActiveGroupID).then((committed) => {
                            if (!committed) {
                              return;
                            }
                            notice.success(
                              `${group.name || group.id} 已${group.locked ? "解除锁定" : "锁定"}`,
                            );
                          });
                        }}
                      />
                    </Tooltip>
                  </Space>
                </div>
                {rulePointerSortingActive && draggingGroupIDRef.current === group.id ? (
                  <div className="table-sort-hint">
                    <Typography.Text type="secondary">
                      正在调整 {draggingRuleIDsRef.current.length} 条规则顺序，移动到目标行上半区或下半区后松开左键即可。
                    </Typography.Text>
                  </div>
                ) : null}
                <Table<RuleItemV2>
                  className="rules-composed-table table-fixed-leading-columns"
                  rowKey="id"
                  size="small"
                  pagination={false}
                  columns={columns}
                  dataSource={group.rules ?? []}
                  rowClassName={(record) => {
                    const classNames: string[] = [];
                    if (draggingRuleIDsRef.current.includes(record.id)) {
                      classNames.push("table-row-sort-dragging");
                    }
                    if (
                      ruleSortPreview?.groupId === group.id &&
                      ruleSortPreview.ruleId === record.id
                    ) {
                      classNames.push(
                        ruleSortPreview.position === "before"
                          ? "table-row-sort-target-before"
                          : "table-row-sort-target-after",
                      );
                    }
                    return classNames.join(" ");
                  }}
                  rowSelection={{
                    selectedRowKeys,
                    columnWidth: 56,
                    onChange: (keys) =>
                      setSelectedRowKeys(keys.map((item) => String(item))),
                  }}
                  onRow={(record) => ({
                    onMouseMove: handleRuleSortPreview(group, record),
                    onMouseLeave: handleRuleSortLeave(group, record),
                    onMouseUp: handleRuleSortCommit(group, record),
                  })}
                />
              </Space>
            ),
          })),
          {
            key: ADD_GROUP_TAB_ID,
            label: (
              <Tooltip title="添加规则分组">
                <Button
                  type="text"
                  size="small"
                  className="rules-add-group-tab-btn"
                  icon={
                    <BiIcon
                      name="plus-circle-fill"
                      className="rules-add-group-tab-icon"
                    />
                  }
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openAddGroupModal();
                  }}
                />
              </Tooltip>
            ),
          },
        ]}
      />
        </>
      )}

      <Modal
        title={groupModalMode === "add" ? "新增分组" : "编辑分组"}
        open={groupModalOpen}
        onOk={() => {
          void (async () => {
            try {
              const values = await groupNameForm.validateFields();
              const name = String(values.groupName || "").trim();
              if (!name) {
                notice.warning("分组名称不能为空");
                return;
              }
              if (groupModalMode === "add") {
                const nextGroupID = buildGroupID(normalizedGroups);
                const nextGroups = [
                  ...normalizedGroups,
                  {
                    id: nextGroupID,
                    name,
                    onMissMode: "direct" as RuleMissMode,
                    locked: false,
                    rules: [],
                  },
                ];
                const nextActiveGroupID = nextGroups.some((group) => group.id === resolvedActiveGroupID)
                  ? resolvedActiveGroupID
                  : (nextGroups[0]?.id ?? "default");
                const committed = await commitGroups(nextGroups, nextActiveGroupID);
                if (committed) {
                  hasUserSwitchedTabRef.current = true;
                  setOpenedGroupID(nextGroupID);
                  setGroupModalOpen(false);
                }
                return;
              }
              const nextGroups = normalizedGroups.map((group) =>
                group.id === editingGroupID ? { ...group, name } : group,
              );
              const nextActiveGroupID = nextGroups.some((group) => group.id === resolvedActiveGroupID)
                ? resolvedActiveGroupID
                : (nextGroups[0]?.id ?? "default");
              const committed = await commitGroups(nextGroups, nextActiveGroupID);
              if (committed) {
                setGroupModalOpen(false);
              }
            } catch {
              // keep form validation state.
            }
          })();
        }}
        onCancel={() => {
          setGroupModalOpen(false);
          setEditingGroupID("");
          groupNameForm.resetFields();
        }}
        okText="确定"
        cancelText="取消"
      >
        <Form form={groupNameForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="groupName"
            label="分组名称"
            rules={[{ required: true, message: "请输入分组名称" }]}
          >
            <Input placeholder="请输入分组名称" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingRuleID ? "编辑规则" : "新增规则"}
        open={ruleModalOpen}
        onOk={() => {
          void (async () => {
            if (isRuleModalReadonly) {
              setRuleModalOpen(false);
              setEditingRuleID("");
              return;
            }
            if (currentGroupLocked) {
              notice.warning("当前分组已锁定，无法保存规则");
              return;
            }
            const trimmedName = ruleDraft.name.trim();
            if (trimmedName === "") {
              notice.warning("规则名称不能为空");
              return;
            }
            if (ruleDraft.actionMode === "policy" && ruleDraft.policyID.trim() === "") {
              notice.warning("选择“节点池”动作时，必须指定节点池");
              return;
            }
            const currentRules = currentGroup.rules ?? [];
            const nextRuleID = editingRuleID || buildRandomRuleID(currentRules);
            const nextRule = buildRuleFromDraft({
              ...ruleDraft,
              id: nextRuleID,
              name: trimmedName,
              policyID: ruleDraft.policyID.trim(),
            });
            if (!hasAnyMatcher(nextRule.match)) {
              notice.warning("规则匹配内容不能为空");
              return;
            }
            const nextRules = editingRuleID
              ? currentRules.map((item) => (item.id === editingRuleID ? nextRule : item))
              : [...currentRules, nextRule];
            const nextGroups = normalizedGroups.map((group) =>
              group.id === currentGroup.id ? { ...group, rules: nextRules } : group,
            );
            const nextActiveGroupID = nextGroups.some((group) => group.id === resolvedActiveGroupID)
              ? resolvedActiveGroupID
              : (nextGroups[0]?.id ?? "default");
            const committed = await commitGroups(nextGroups, nextActiveGroupID);
            if (committed) {
              setRuleModalOpen(false);
              setEditingRuleID("");
            }
          })();
        }}
        onCancel={() => {
          setRuleModalOpen(false);
          setEditingRuleID("");
        }}
        width={isMobileView ? "calc(100vw - 16px)" : 980}
        okText={isRuleModalReadonly ? "关闭" : "保存"}
        cancelText="取消"
        styles={{
          body: {
            padding: isMobileView ? 12 : undefined,
          },
        }}
      >
        <Form layout="vertical" requiredMark={false} size={isMobileView ? "small" : "middle"}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobileView ? "minmax(0, 1fr)" : "320px minmax(0, 1fr)",
              gap: isMobileView ? 12 : 16,
              alignItems: "start",
            }}
          >
            <div>
              <Form.Item
                label={
                  <HelpLabel
                    label="规则名称"
                    helpContent={[
                      "使用场景:",
                      "- 用于界面展示和人工识别规则用途。",
                      "",
                      "作用:",
                      "- 帮助快速理解该规则负责的目标流量。",
                      "",
                      "注意点:",
                      "- 不能为空。",
                      "- 可重复，建议按业务语义命名（如“谷歌域名走代理”）。",
                    ].join("\n")}
                  />
                }
                style={{ marginBottom: 16 }}
              >
                <Input
                  value={ruleDraft.name}
                  disabled={isRuleModalReadonly}
                  onChange={(event) =>
                    setRuleDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="例如：谷歌域名走代理"
                />
              </Form.Item>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobileView ? "minmax(0, 1fr)" : "minmax(0, 1fr) 110px",
                  gap: isMobileView ? 10 : 12,
                  alignItems: "start",
                }}
              >
                <Form.Item
                  label={
                    <HelpLabel
                      label="规则类型"
                      helpContent={[
                        "使用场景:",
                        "- 按目标特征选择匹配方式：域名 / IP / 进程。",
                        "",
                        "作用:",
                        "- 决定“匹配内容”每行如何被解析并编译到内核规则。",
                        "",
                        "注意点:",
                        "- 切换类型后，请同步检查“匹配内容”是否仍符合该类型格式。",
                      ].join("\n")}
                    />
                  }
                  style={{ marginBottom: 16 }}
                >
                  <Select<RuleType>
                    value={ruleDraft.type}
                    disabled={isRuleModalReadonly}
                    options={[
                      { label: "域名规则", value: "domain" },
                      { label: "IP规则", value: "ip" },
                      { label: "进程规则", value: "process" },
                    ]}
                    onChange={(value) =>
                      setRuleDraft((current) => ({ ...current, type: value }))
                    }
                  />
                </Form.Item>

                <Form.Item style={{ marginBottom: 16 }}>
                  <SwitchWithLabel
                    checked={ruleDraft.enabled}
                    disabled={isRuleModalReadonly}
                    label="启用"
                    helpContent={[
                      "使用场景:",
                      "- 临时开关某条规则而不删除规则内容。",
                      "",
                      "作用:",
                      "- 关闭后该规则不参与匹配；开启后恢复生效。",
                      "",
                      "注意点:",
                      "- 禁用仅影响当前规则，不影响同分组其他规则。",
                    ].join("\n")}
                    onChange={(checked) =>
                      setRuleDraft((current) => ({ ...current, enabled: checked }))
                    }
                  />
                </Form.Item>
              </div>

              <Form.Item
                label={
                  <HelpLabel
                    label="命中动作"
                    helpContent={[
                      "使用场景:",
                      "- 请求命中当前规则后，决定走代理、直连、拦截或节点池。",
                      "",
                      "作用:",
                      "- 定义命中流量的最终路由行为。",
                      "",
                      "注意点:",
                      "- 选“节点池”时必须指定节点池。",
                      "- 命中动作优先于“当前分组漏网之鱼”配置。",
                    ].join("\n")}
                  />
                }
                style={{ marginBottom: 16 }}
              >
                <Select<ActionMode>
                  value={ruleDraft.actionMode}
                  disabled={isRuleModalReadonly}
                  options={[
                    { label: "代理（默认节点）", value: "proxy" },
                    { label: "直连", value: "direct" },
                    { label: "拦截", value: "reject" },
                    { label: "节点池", value: "policy" },
                  ]}
                  onChange={(value) =>
                    setRuleDraft((current) => ({ ...current, actionMode: value }))
                  }
                />
              </Form.Item>

              {ruleDraft.actionMode === "policy" ? (
                <Form.Item
                  label={
                    <HelpLabel
                      label="选择节点池"
                      helpContent={[
                        "使用场景:",
                        "- 当命中动作为“节点池”时，选择一个候选节点集合。",
                        "",
                        "作用:",
                        "- 让该规则命中的流量从指定节点池中选路。",
                        "",
                        "注意点:",
                        "- 需要先在“节点池管理”里配置可用节点池。",
                        "- 未选择节点池时不能保存。",
                      ].join("\n")}
                    />
                  }
                  style={{ marginBottom: 0 }}
                >
                  <Select
                    value={ruleDraft.policyID || undefined}
                    disabled={isRuleModalReadonly}
                    options={policyOptions}
                    onChange={(value) =>
                      setRuleDraft((current) => ({
                        ...current,
                        policyID: String(value || ""),
                      }))
                    }
                    placeholder="请选择节点池"
                  />
                </Form.Item>
              ) : null}
            </div>

            <div>
              <Form.Item
                label={
                  <HelpLabel
                    label="匹配内容"
                    helpContent={ruleContentHelpText(ruleDraft.type)}
                  />
                }
                style={{ marginBottom: 0 }}
              >
                <Input.TextArea
                  value={ruleDraft.content}
                  disabled={isRuleModalReadonly}
                  rows={isMobileView ? 10 : 13}
                  onChange={(event) =>
                    setRuleDraft((current) => ({ ...current, content: event.target.value }))
                  }
                  placeholder={ruleContentPlaceholder(ruleDraft.type)}
                />
              </Form.Item>
            </div>
          </div>
        </Form>
      </Modal>
    </Space>
  );
}
