import {
  Button,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  BaseRuleItem,
  ComposedRuleGroup,
  RuleActionMode,
  RuleBaseRuleKind,
  RuleMatchV2,
  RulePolicyGroup,
} from "../../../../../shared/daemon";
import { hasAnyMatcher } from "./ruleEditorUtils";

interface BaseRulesTableProps {
  value: BaseRuleItem[];
  policyGroups: RulePolicyGroup[];
  composedGroups: ComposedRuleGroup[];
  onChange: (next: BaseRuleItem[]) => Promise<boolean>;
  onSendToComposed: (groupID: string, baseRuleIDs: string[]) => Promise<boolean>;
}

type RuleType = "ip" | "domain" | "process";
type RuleMode = "proxy" | "direct" | "reject";

interface ContextMenuState {
  x: number;
  y: number;
  anchorRuleID: string | null;
}

interface BaseRuleDraft {
  id: string;
  name: string;
  type: RuleType;
  mode: RuleMode;
  disableReverse: boolean;
  poolIDs: string[];
  content: string;
}

function helpLabel(label: string, helpText: string, title = "配置说明"): ReactNode {
  return (
    <Space size={6}>
      <span>{label}</span>
      <Popover
        trigger="click"
        placement="rightTop"
        title={title}
        content={
          <div style={{ whiteSpace: "pre-line", maxWidth: 520, lineHeight: 1.5 }}>
            {helpText}
          </div>
        }
      >
        <QuestionCircleOutlined style={{ color: "#8c8c8c", cursor: "help" }} />
      </Popover>
    </Space>
  );
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

function normalizeInputLine(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return "";
  }
  // Support inline notes like: +.google.com #后缀匹配
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/g)
    .map(normalizeInputLine)
    .filter((item) => item.length > 0);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)));
}

function inferRuleType(item: BaseRuleItem): RuleType {
  const match = item.match ?? { domain: {}, process: {} };
  const hasProcess =
    (match.process.nameContains?.length ?? 0) > 0 ||
    (match.process.pathContains?.length ?? 0) > 0 ||
    (match.process.pathRegex?.length ?? 0) > 0;
  const hasDomain =
    (match.domain.exact?.length ?? 0) > 0 ||
    (match.domain.suffix?.length ?? 0) > 0 ||
    (match.domain.keyword?.length ?? 0) > 0 ||
    (match.domain.regex?.length ?? 0) > 0 ||
    (match.geosite?.length ?? 0) > 0;
  if (hasProcess) {
    return "process";
  }
  if (hasDomain) {
    return "domain";
  }
  return "ip";
}

function inferRuleMode(item: BaseRuleItem): { mode: RuleMode; disableReverse: boolean } {
  const actionMode = item.actionMode ?? "inherit";
  switch (actionMode) {
    case "reject":
      return { mode: "reject", disableReverse: true };
    case "direct":
      return { mode: "direct", disableReverse: true };
    case "inherit":
      return { mode: "proxy", disableReverse: false };
    default:
      return { mode: "proxy", disableReverse: true };
  }
}

function stringifyRuleContent(item: BaseRuleItem, type: RuleType): string {
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
  const match: RuleMatchV2 = {
    domain: {},
    process: {},
  };
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
      const regexValue = valueAfterPrefix(line, ["regex:", "path-regex:", "process-regex:"]);
      if (regexValue != null) {
        pathRegex.push(ensureCaseInsensitiveRegex(regexValue));
        continue;
      }
      const processValue = valueAfterPrefix(line, ["process:", "name:", "process-name:"]);
      if (processValue != null) {
        nameContains.push(processValue);
      } else {
        nameContains.push(line);
      }
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
        "domain-contains:",
        "kw:",
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
      const rulesetValue = valueAfterPrefix(line, ["ruleset:", "rule-set:", "rule_set:"]);
      if (rulesetValue != null) {
        ruleSetRefs.push(rulesetValue);
        continue;
      }
      const exactValue = valueAfterPrefix(line, [
        "domain:",
        "exact:",
        "domain-exact:",
        "domain-exact,",
      ]);
      if (exactValue != null) {
        exact.push(exactValue);
        continue;
      }
      exact.push(line);
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
    const cidrValue = valueAfterPrefix(line, ["ip-cidr,", "ip-cidr:", "cidr:", "ip:"]);
    if (cidrValue != null) {
      ipCidr.push(cidrValue);
      continue;
    }
    const rulesetValue = valueAfterPrefix(line, ["ruleset:", "rule-set:", "rule_set:"]);
    if (rulesetValue != null) {
      ruleSetRefs.push(rulesetValue);
      continue;
    }
    ipCidr.push(line);
  }
  match.ipCidr = unique(ipCidr);
  match.geoip = unique(geoip);
  match.ruleSetRefs = unique(ruleSetRefs);
  return match;
}

function summarizeRuleContent(item: BaseRuleItem): string {
  const type = inferRuleType(item);
  const content = stringifyRuleContent(item, type);
  const firstLine = splitLines(content)[0] ?? "";
  if (firstLine === "") {
    return "-";
  }
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}...` : firstLine;
}

function typeTagText(type: RuleType): string {
  switch (type) {
    case "process":
      return "进程";
    case "domain":
      return "域名";
    default:
      return "IP";
  }
}

function modeText(mode: RuleMode): string {
  switch (mode) {
    case "direct":
      return "直连";
    case "reject":
      return "屏蔽";
    default:
      return "代理";
  }
}

function placeholderByType(type: RuleType): string {
  switch (type) {
    case "process":
      return [
        "#不区分大小写",
        "chrome.exe #进程名包含",
        "path:C:\\Windows\\System32\\ #命中该目录及子目录所有进程(推荐)",
        "regex:(?i)^c:[\\\\/]+windows[\\\\/]+system32[\\\\/].*$ #严格匹配System32目录树",
        "path:C:\\Program Files\\WeChat\\WeChat.exe #进程路径包含",
        "regex:(?i).*telegram.* #进程路径/名称正则",
      ].join("\n");
    case "domain":
      return [
        "#不区分大小写",
        "google.com #域名精确匹配",
        "exact:accounts.google.com #域名精确匹配(等价写法)",
        "domain:mail.google.com #域名精确匹配(别名)",
        "keyword:google #只要域名包含 google 就命中",
        "contains:gmail #关键词匹配(别名)",
        "+.google.com #域名后缀匹配(包含子域)",
        "suffix:googlevideo.com #域名后缀匹配",
        "endswith:youtube.com #域名后缀匹配(别名)",
        "regex:^.*\\.googleusercontent\\.com$ #域名正则",
        "geosite:google #GeoSite规则集",
        "rule-set:custom-google #规则集标签(别名)",
      ].join("\n");
    default:
      return [
        "#不区分大小写",
        "1.1.1.1 #单IP地址",
        "8.8.8.8/32 #CIDR写法",
        "10.0.0.0/8 #网段",
        "geoip:cn #GeoIP国家",
        "geoip:private #私有地址",
      ].join("\n");
  }
}

function ruleGuideByType(type: RuleType): string {
  switch (type) {
    case "process":
      return [
        "写法说明:",
        "- 普通行(如 chrome.exe): 进程名包含匹配",
        "- name:/process:/process-name:: 进程名匹配",
        "- path:/dir:/process-path:: 进程路径包含匹配(目录可用)",
        "- regex:/path-regex:/process-regex:: 正则匹配",
        "",
        "System32 示例:",
        "- path:C:\\Windows\\System32\\  # 命中目录及子目录所有进程",
        "- regex:(?i)^c:[\\\\/]+windows[\\\\/]+system32[\\\\/].*$  # 严格匹配目录树",
        "",
        "匹配说明:",
        "- 默认不区分大小写",
        "",
        "注释说明:",
        "- 支持整行注释: #这是注释",
        "- 支持行尾注释: path:C:\\Windows\\System32\\ #目录匹配",
      ].join("\n");
    case "domain":
      return [
        "写法说明:",
        "- 普通行(如 google.com): 精确域名匹配",
        "- exact:/domain:/domain-exact:: 精确域名匹配",
        "- keyword:/contains:/domain-keyword:: 关键词匹配",
        "- +.example.com / suffix:/endswith:/domain-suffix:: 后缀匹配(含子域)",
        "- regex:/regexp:/domain-regex:: 域名正则匹配",
        "- geosite:/geosite,: GeoSite 规则集",
        "- ruleset:/rule-set:/rule_set:: 引用规则集",
        "",
        "匹配说明:",
        "- 默认不区分大小写",
        "",
        "注释说明:",
        "- 支持 # 注释(整行/行尾)",
      ].join("\n");
    default:
      return [
        "写法说明:",
        "- 普通行(如 1.1.1.1): 单 IP",
        "- ip:/cidr:/ip-cidr:: CIDR 网段",
        "- geoip:/geoip,: GeoIP 匹配",
        "- ruleset:/rule-set:/rule_set:: 引用规则集",
        "",
        "匹配说明:",
        "- 默认不区分大小写",
        "",
        "注释说明:",
        "- 支持 # 注释(整行/行尾)",
      ].join("\n");
  }
}

function buildDraftFromItem(item: BaseRuleItem): BaseRuleDraft {
  const type = inferRuleType(item);
  const mode = inferRuleMode(item);
  const pools = unique(item.targetPolicies ?? []);
  if (pools.length === 0 && (item.targetPolicy ?? "").trim() !== "") {
    pools.push(String(item.targetPolicy).trim());
  }
  return {
    id: item.id,
    name: item.name || item.id,
    type,
    mode: mode.mode,
    disableReverse: mode.disableReverse,
    poolIDs: pools,
    content: stringifyRuleContent(item, type),
  };
}

function buildDefaultDraft(index: number): BaseRuleDraft {
  return {
    id: `base-rule-${Date.now()}-${index}`,
    name: "",
    type: "domain",
    mode: "proxy",
    disableReverse: false,
    poolIDs: [],
    content: "",
  };
}

function buildBaseRuleItemFromDraft(draft: BaseRuleDraft): BaseRuleItem {
  const match = parseRuleContent(draft.content, draft.type);
  let actionMode: RuleActionMode = "inherit";
  let targetPolicy = "";
  const targetPolicies = unique(draft.poolIDs);
  if (draft.mode === "reject") {
    actionMode = "reject";
  } else if (draft.mode === "direct") {
    actionMode = "direct";
  } else if (draft.disableReverse) {
    if (targetPolicies.length > 0) {
      actionMode = "policy";
      targetPolicy = targetPolicies[0];
    } else {
      actionMode = "proxy";
    }
  } else if (targetPolicies.length > 0) {
    actionMode = "policy";
    targetPolicy = targetPolicies[0];
  } else {
    actionMode = "inherit";
  }
  const kind: RuleBaseRuleKind = draft.type === "process" ? "process" : draft.type === "domain" ? "domain" : "ip";
  return {
    id: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    kind,
    match,
    actionMode,
    targetPolicy,
    targetPolicies,
  };
}

function normalizeBaseRulesForCompare(rules: BaseRuleItem[]): string {
  const normalized = rules.map((item) => ({
    id: item.id.trim().toLowerCase(),
    name: item.name.trim(),
    kind: item.kind,
    actionMode: (item.actionMode ?? "").trim().toLowerCase(),
    targetPolicy: (item.targetPolicy ?? "").trim(),
    targetPolicies: (item.targetPolicies ?? []).map((entry) => entry.trim()),
    match: {
      domain: {
        exact: (item.match.domain.exact ?? []).map((entry) => entry.trim()),
        suffix: (item.match.domain.suffix ?? []).map((entry) => entry.trim()),
        keyword: (item.match.domain.keyword ?? []).map((entry) => entry.trim()),
        regex: (item.match.domain.regex ?? []).map((entry) => entry.trim()),
      },
      ipCidr: (item.match.ipCidr ?? []).map((entry) => entry.trim()),
      geoip: (item.match.geoip ?? []).map((entry) => entry.trim()),
      geosite: (item.match.geosite ?? []).map((entry) => entry.trim()),
      ruleSetRefs: (item.match.ruleSetRefs ?? []).map((entry) => entry.trim()),
      process: {
        nameContains: (item.match.process.nameContains ?? []).map((entry) => entry.trim()),
        pathContains: (item.match.process.pathContains ?? []).map((entry) => entry.trim()),
        pathRegex: (item.match.process.pathRegex ?? []).map((entry) => entry.trim()),
      },
    },
  }));
  return JSON.stringify(normalized);
}

function hasBaseRuleDraftChanges(source: BaseRuleItem[], draft: BaseRuleItem[]): boolean {
  return normalizeBaseRulesForCompare(source) !== normalizeBaseRulesForCompare(draft);
}

export function BaseRulesTable({
  value,
  policyGroups,
  composedGroups,
  onChange,
  onSendToComposed,
}: BaseRulesTableProps) {
  const snapshotRules = value;
  const [draftRules, setDraftRules] = useState<BaseRuleItem[]>(snapshotRules);
  const [draftTouched, setDraftTouched] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [hoveredRuleID, setHoveredRuleID] = useState<string>("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRuleID, setEditingRuleID] = useState("");
  const [draft, setDraft] = useState<BaseRuleDraft>(() => buildDefaultDraft(1));

  useEffect(() => {
    if (!draftTouched) {
      setDraftRules(snapshotRules);
      return;
    }
    if (!hasBaseRuleDraftChanges(snapshotRules, draftRules)) {
      setDraftRules(snapshotRules);
      setDraftTouched(false);
    }
  }, [snapshotRules, draftRules, draftTouched]);

  const hasDraftChanges = useMemo(
    () => hasBaseRuleDraftChanges(snapshotRules, draftRules),
    [snapshotRules, draftRules],
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const nodePoolOptions = useMemo(
    () =>
      policyGroups
        .filter((item) => item.type === "node_pool")
        .map((item) => ({
          value: item.id,
          label: `${item.name} (${item.id})`,
        })),
    [policyGroups],
  );

  const operationRuleIDs = useMemo(() => {
    if (selectedRowKeys.length > 0) {
      return selectedRowKeys;
    }
    if (contextMenu?.anchorRuleID) {
      return [contextMenu.anchorRuleID];
    }
    if (hoveredRuleID) {
      return [hoveredRuleID];
    }
    return [];
  }, [selectedRowKeys, contextMenu, hoveredRuleID]);

  const menuItems = useMemo<MenuProps["items"]>(() => {
    const sendItems = composedGroups.map((group) => ({
      key: `send:${group.id}`,
      label: `发送到合成规则：${group.name}`,
      disabled: operationRuleIDs.length === 0 || hasDraftChanges,
    }));
    return [
      {
        key: "edit",
        label: "编辑规则",
        disabled: operationRuleIDs.length !== 1,
      },
      {
        key: "delete",
        label: `删除规则 (${operationRuleIDs.length})`,
        danger: true,
        disabled: operationRuleIDs.length === 0,
      },
      {
        type: "divider",
      },
      ...sendItems,
    ];
  }, [composedGroups, operationRuleIDs.length, hasDraftChanges]);

  const columns: ColumnsType<BaseRuleItem> = [
    {
      title: "序号",
      key: "index",
      width: 68,
      render: (_value, _record, index) => index + 1,
    },
    {
      title: "类型",
      key: "type",
      width: 96,
      render: (_value, record) => <Tag>{typeTagText(inferRuleType(record))}</Tag>,
    },
    {
      title: "模式",
      key: "mode",
      width: 96,
      render: (_value, record) => {
        const info = inferRuleMode(record);
        return modeText(info.mode);
      },
    },
    {
      title: "禁止反转",
      key: "disableReverse",
      width: 106,
      render: (_value, record) => (inferRuleMode(record).disableReverse ? "是" : "否"),
    },
    {
      title: "节点池",
      key: "pools",
      width: 280,
      render: (_value, record) => {
        const pools = unique(record.targetPolicies ?? []);
        if (pools.length === 0 && (record.targetPolicy ?? "").trim() !== "") {
          pools.push(String(record.targetPolicy).trim());
        }
        if (pools.length === 0) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        return (
          <Space size={[4, 4]} wrap>
            {pools.slice(0, 4).map((poolID) => (
              <Tag key={`${record.id}-${poolID}`}>{poolID}</Tag>
            ))}
            {pools.length > 4 ? <Tag>+{pools.length - 4}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: "规则内容",
      key: "content",
      render: (_value, record) => (
        <Typography.Text title={stringifyRuleContent(record, inferRuleType(record))}>
          {summarizeRuleContent(record)}
        </Typography.Text>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 120,
      render: (_value, record) => (
        <Space size={4}>
          <Button
            type="link"
            onClick={() => {
              setEditingRuleID(record.id);
              setDraft(buildDraftFromItem(record));
              setModalOpen(true);
            }}
          >
            编辑
          </Button>
          <Button
            type="link"
            danger
            onClick={() => {
              setDraftRules((prev) => prev.filter((item) => item.id !== record.id));
              setSelectedRowKeys((prev) => prev.filter((id) => id !== record.id));
              setDraftTouched(true);
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const handleMenuClick: MenuProps["onClick"] = ({ key }) => {
    setContextMenu(null);
    if (key === "edit") {
      if (operationRuleIDs.length !== 1) {
        return;
      }
      const target = draftRules.find((item) => item.id === operationRuleIDs[0]);
      if (!target) {
        return;
      }
      setEditingRuleID(target.id);
      setDraft(buildDraftFromItem(target));
      setModalOpen(true);
      return;
    }
    if (key === "delete") {
      if (operationRuleIDs.length === 0) {
        return;
      }
      setDraftRules((prev) => prev.filter((item) => !operationRuleIDs.includes(item.id)));
      setSelectedRowKeys((prev) => prev.filter((id) => !operationRuleIDs.includes(id)));
      setDraftTouched(true);
      return;
    }
    if (String(key).startsWith("send:")) {
      if (hasDraftChanges) {
        message.warning("请先提交或取消基础规则草稿后，再发送到合成规则");
        return;
      }
      const groupID = String(key).slice("send:".length);
      if (!groupID || operationRuleIDs.length === 0) {
        return;
      }
      void onSendToComposed(groupID, operationRuleIDs).then((saved) => {
        if (!saved) {
          return;
        }
        message.success(`已发送 ${operationRuleIDs.length} 条规则到合成分组`);
      });
    }
  };

  const saveDraft = () => {
    const next = buildBaseRuleItemFromDraft(draft);
    if (!next.id || !next.name) {
      message.error("规则名称不能为空");
      return;
    }
    if (!hasAnyMatcher(next.match)) {
      message.error("规则内容不能为空，请至少输入一行");
      return;
    }
    if (draft.poolIDs.length > 1) {
      message.info("当前内核按策略组顺序使用，优先使用所选第一个节点池");
    }
    if (editingRuleID) {
      setDraftRules((prev) => prev.map((item) => (item.id === editingRuleID ? next : item)));
    } else {
      setDraftRules((prev) => [...prev, next]);
    }
    setDraftTouched(true);
    setModalOpen(false);
    setEditingRuleID("");
  };

  return (
    <Space
      direction="vertical"
      size={10}
      style={{ width: "100%" }}
    >
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Typography.Text strong>基础规则表</Typography.Text>
        <Button
          type="primary"
          onClick={() => {
            setEditingRuleID("");
            setDraft(buildDefaultDraft(draftRules.length + 1));
            setModalOpen(true);
          }}
        >
          添加基础规则
        </Button>
      </Space>
      {hasDraftChanges ? (
        <Space style={{ width: "100%", justifyContent: "center" }} size={10}>
          <Button
            type="primary"
            onClick={() => {
              void onChange(draftRules).then((saved) => {
                if (!saved) {
                  return;
                }
                setDraftTouched(false);
                message.success("基础规则修改已提交");
              });
            }}
          >
            提交修改
          </Button>
          <Button
            onClick={() => {
              setDraftRules(snapshotRules);
              setSelectedRowKeys([]);
              setHoveredRuleID("");
              setDraftTouched(false);
              message.info("已取消基础规则草稿修改");
            }}
          >
            取消修改
          </Button>
        </Space>
      ) : null}
      <div
        className="node-table-context-area"
        onContextMenu={(event) => {
          event.preventDefault();
          const target = event.target as HTMLElement;
          const row = target.closest("[data-row-key]") as HTMLElement | null;
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            anchorRuleID: row?.getAttribute("data-row-key") ?? null,
          });
        }}
      >
        <Table<BaseRuleItem>
          className="rules-base-table"
          rowKey="id"
          size="small"
          bordered
          pagination={false}
          columns={columns}
          dataSource={draftRules}
          rowSelection={{
            selectedRowKeys,
            columnWidth: 42,
            onChange: (keys) => {
              setSelectedRowKeys(keys.map((key) => String(key)));
            },
          }}
          onRow={(record) => ({
            onMouseEnter: () => {
              setHoveredRuleID(record.id);
            },
            onMouseLeave: () => {
              setHoveredRuleID((prev) => (prev === record.id ? "" : prev));
            },
          })}
        />
        {contextMenu ? (
          <Dropdown
            open
            trigger={[]}
            menu={{
              items: menuItems,
              onClick: handleMenuClick,
            }}
          >
            <div
              className="context-menu-anchor"
              style={{
                left: contextMenu.x,
                top: contextMenu.y,
              }}
            />
          </Dropdown>
        ) : null}
      </div>

      <Modal
        title={editingRuleID ? "编辑基础规则" : "添加基础规则"}
        open={modalOpen}
        width={760}
        okText="保存"
        cancelText="取消"
        onOk={saveDraft}
        onCancel={() => setModalOpen(false)}
      >
        <Form
          layout="vertical"
          requiredMark={false}
        >
          <Form.Item
            label={helpLabel(
              "规则名称",
              [
                "作用:",
                "- 用于在基础规则表、合成规则表中展示识别。",
                "",
                "关联来源:",
                "- 合成规则引用基础规则时，优先显示这里的名称。",
              ].join("\n"),
            )}
          >
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="例如：代理谷歌"
            />
          </Form.Item>
          <Form.Item
            label={helpLabel(
              "类型",
              [
                "作用:",
                "- 决定第三行“规则内容”按哪套语法解析。",
                "- IP / 域名 / 进程 三类互斥。",
                "",
                "关联来源:",
                "- 关联“规则内容（每行一条）”输入格式和内核匹配字段。",
              ].join("\n"),
            )}
          >
            <Radio.Group
              value={draft.type}
              options={[
                { value: "ip", label: "IP" },
                { value: "domain", label: "域名" },
                { value: "process", label: "进程" },
              ]}
              onChange={(event) => setDraft({ ...draft, type: event.target.value as RuleType })}
            />
          </Form.Item>
          <Space
            size={14}
            align="start"
            style={{ width: "100%" }}
          >
            <Form.Item
              label={helpLabel(
                "模式",
                [
                  "作用:",
                  "- 命中后倾向动作：直连 / 代理 / 屏蔽。",
                  "",
                  "关联来源:",
                  "- 与“禁止反转”以及合成规则分组模式联动。",
                ].join("\n"),
              )}
              style={{ flex: 1 }}
            >
              <Radio.Group
                value={draft.mode}
                options={[
                  { value: "direct", label: "直连" },
                  { value: "proxy", label: "代理" },
                  { value: "reject", label: "屏蔽" },
                ]}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value as RuleMode })}
              />
            </Form.Item>
            <Form.Item
              label={helpLabel(
                "禁止反转",
                [
                  "作用:",
                  "- 开启后，不受合成规则分组“代理模式/直连模式”反转影响。",
                  "",
                  "关联来源:",
                  "- 关联合成规则表的“分组模式”。",
                ].join("\n"),
              )}
              style={{ minWidth: 160 }}
            >
              <Switch
                checked={draft.disableReverse}
                onChange={(checked) => setDraft({ ...draft, disableReverse: checked })}
              />
            </Form.Item>
          </Space>
          <Form.Item
            label={helpLabel(
              "节点池（多选）",
              [
                "作用:",
                "- 为代理类规则指定目标节点池策略组。",
                "- 可多选，当前内核优先使用第一个。",
                "- 未指定节点池时，规则若最终执行为代理则走默认节点（当前激活节点）。",
                "",
                "关联来源:",
                "- 关联“节点池表”里的策略组ID。",
              ].join("\n"),
            )}
          >
            <Select
              mode="multiple"
              value={draft.poolIDs}
              options={nodePoolOptions}
              onChange={(values) => setDraft({ ...draft, poolIDs: values.map((item) => String(item)) })}
              placeholder="代理模式下可选择一个或多个节点池"
              allowClear
            />
          </Form.Item>
          <Form.Item
            label={helpLabel("规则内容（每行一条）", ruleGuideByType(draft.type), "规则说明")}
          >
            <Input.TextArea
              rows={8}
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              placeholder={placeholderByType(draft.type)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
