import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DraftActionBar } from "../../../components/draft/DraftActionBar";
import { CountryFlag } from "../../../components/flag/CountryFlag";
import { HelpLabel } from "../../../components/form/HelpLabel";
import { BiIcon } from "../../../components/icons/BiIcon";
import { useAppNotice } from "../../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../../hooks/useDraftNotice";
import {
  buildCountrySearchText,
  countryMetadataList,
  normalizeCountryCode,
  resolveCountryMetadata,
} from "../../../app/data/countryMetadata";

import type {
  RuleNodePoolFallbackMode,
  RulePolicyGroup,
  VpnNode,
} from "../../../../../shared/daemon";

interface NodePoolTableProps {
  value: RulePolicyGroup[];
  activeNodes: VpnNode[];
  onProbeActiveGroupRealConnect?: () => Promise<VpnNode[]>;
  onChange: (next: RulePolicyGroup[]) => Promise<boolean>;
}

type NodeRefType = "country" | "name";

interface NodePoolDraft {
  id: string;
  name: string;
  enabled: boolean;
  fallbackMode: RuleNodePoolFallbackMode;
  refType: NodeRefType;
  nodesText: string;
}

const strictRefTypeOptions: Array<{ value: NodeRefType; label: string }> = [
  { value: "country", label: "国家" },
  { value: "name", label: "名称" },
];

interface CountryQuickSelectOption {
  value: string;
  label: ReactNode;
  searchText: string;
  sortLabel: string;
}

const countryQuickSelectOptions: CountryQuickSelectOption[] = [...countryMetadataList]
  .map((item) => ({
    value: item.code,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <CountryFlag code={item.code} ariaLabel={item.chineseName} />
        <span>{item.chineseName}</span>
      </span>
    ),
    searchText: item.searchText,
    sortLabel: item.chineseName,
  }))
  .sort((left, right) => left.sortLabel.localeCompare(right.sortLabel, "zh-CN"));

function normalizeRefType(rawType: string): NodeRefType {
  const normalized = rawType.trim().toLowerCase();
  switch (normalized) {
    case "country":
    case "国家":
      return "country";
    case "name":
    case "名称":
      return "name";
    default:
      // 兼容历史配置中的 id/index 类型，统一按名称匹配处理。
      return "name";
  }
}

function inferDraftRefType(nodes: Array<{ type: string; node: string }>): NodeRefType {
  if (nodes.length === 0) {
    return "country";
  }
  return normalizeRefType(nodes[0]?.type ?? "country");
}

function splitNodeLines(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw.split(/\r?\n/g)) {
    const value = item.trim();
    if (value === "") {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function randomLowerAlphaNum(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const random = Math.floor(Math.random() * alphabet.length);
    result += alphabet[random];
  }
  return result;
}

function buildRandomPoolID(usedIDs: Set<string>): string {
  let candidate = `pool-${randomLowerAlphaNum(8)}`;
  while (usedIDs.has(candidate.toLowerCase())) {
    candidate = `pool-${randomLowerAlphaNum(8)}`;
  }
  return candidate;
}

function normalizeNodePoolsForCompare(pools: RulePolicyGroup[]): string {
  const normalized = pools.map((item) => ({
    id: item.id.trim().toLowerCase(),
    name: item.name.trim(),
    enabled: item.nodePool?.enabled !== false,
    fallbackMode:
      item.nodePool?.fallbackMode === "active_node"
        ? "active_node"
        : "reject",
    availableNodeIds: normalizeNodeIDList(item.nodePool?.availableNodeIds),
    nodes: (item.nodePool?.nodes ?? []).map((node) => ({
      type: node.type.trim().toLowerCase(),
      node: node.node.trim(),
    })),
  }));
  return JSON.stringify(normalized);
}

function hasNodePoolDraftChanges(source: RulePolicyGroup[], draft: RulePolicyGroup[]): boolean {
  return normalizeNodePoolsForCompare(source) !== normalizeNodePoolsForCompare(draft);
}

function buildEmptyDraft(): NodePoolDraft {
  return {
    id: "",
    name: "",
    enabled: true,
    fallbackMode: "reject",
    refType: "country",
    nodesText: "",
  };
}

function toDraft(item: RulePolicyGroup): NodePoolDraft {
  const refs = item.nodePool?.nodes ?? [];
  const refType = inferDraftRefType(refs);
  return {
    id: item.id,
    name: item.name,
    enabled: item.nodePool?.enabled !== false,
    fallbackMode:
      item.nodePool?.fallbackMode === "active_node"
        ? "active_node"
        : "reject",
    refType,
    nodesText: refs
      .map((ref) => normalizeDraftNodeValue(refType, ref.node))
      .filter((node) => node.length > 0)
      .join("\n"),
  };
}

function mergeNodePoolsIntoGroups(
  groups: RulePolicyGroup[],
  nodePools: RulePolicyGroup[],
): RulePolicyGroup[] {
  const nextByID = new Map(nodePools.map((item) => [item.id, item]));
  const used = new Set<string>();
  const merged: RulePolicyGroup[] = [];
  for (const group of groups) {
    if (group.type !== "node_pool") {
      merged.push(group);
      continue;
    }
    const replaced = nextByID.get(group.id);
    if (replaced) {
      merged.push(replaced);
      used.add(group.id);
    }
  }
  for (const pool of nodePools) {
    if (used.has(pool.id)) {
      continue;
    }
    merged.push(pool);
  }
  return merged;
}

function normalizeNodeIDList(values?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values ?? []) {
    const value = String(rawValue ?? "").trim();
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeCountryToken(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeDraftNodeValue(refType: NodeRefType, rawValue: string): string {
  const value = rawValue.trim();
  if (value === "") {
    return "";
  }
  if (refType === "country") {
    return normalizeCountryCode(value) || normalizeCountryToken(value);
  }
  return value;
}

function parseCountryCodesFromText(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  splitNodeLines(raw).forEach((item) => {
    const value = normalizeDraftNodeValue("country", item);
    if (value === "") {
      return;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(value);
  });
  return result;
}

function renderPoolConditionLabel(ref: { type: string; node: string }) {
  const refType = normalizeRefType(ref.type);
  if (refType === "country") {
    const countryCode = normalizeCountryCode(ref.node) || normalizeCountryToken(ref.node);
    const metadata = resolveCountryMetadata(countryCode);
    if (metadata) {
      return (
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          title={`${metadata.chineseName} · ${metadata.code} · ${metadata.englishName}`}
        >
          <CountryFlag code={metadata.code} ariaLabel={metadata.chineseName} />
          <span>{metadata.chineseName}</span>
        </span>
      );
    }
    return countryCode || ref.node.trim();
  }
  return ref.node.trim();
}

function resolvePoolCandidateNodeIDs(
  refs: Array<{ type: string; node: string }>,
  nodes: VpnNode[],
): string[] {
  if (nodes.length === 0) {
    return [];
  }
  const appendOrder: string[] = [];
  const seen = new Set<string>();
  const appendNodeID = (nodeID: string) => {
    const value = nodeID.trim();
    if (!value) {
      return;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    appendOrder.push(value);
  };
  if (refs.length === 0) {
    nodes.forEach((node) => appendNodeID(node.id));
    return appendOrder;
  }
  const normalizedRefs = refs
    .map((ref) => ({
      type: normalizeRefType(String(ref.type ?? "")),
      node: String(ref.node ?? "").trim(),
    }))
    .filter((ref) => ref.node.length > 0);
  if (normalizedRefs.length === 0) {
    nodes.forEach((node) => appendNodeID(node.id));
    return appendOrder;
  }
  const refTypes = new Set(normalizedRefs.map((ref) => ref.type));
  if (refTypes.size === 1 && normalizedRefs[0]?.type === "country") {
    const countrySet = new Set(
      normalizedRefs
        .map((ref) => normalizeCountryToken(ref.node))
        .filter((value) => value.length > 0),
    );
    if (countrySet.size === 0) {
      nodes.forEach((node) => appendNodeID(node.id));
      return appendOrder;
    }
    nodes.forEach((node) => {
      const country = normalizeCountryToken(node.country || node.region || "");
      if (country && countrySet.has(country)) {
        appendNodeID(node.id);
      }
    });
    return appendOrder;
  }
  if (refTypes.size === 1 && normalizedRefs[0]?.type === "name") {
    const nameTokens = Array.from(
      new Set(
        normalizedRefs
          .map((ref) => ref.node.toLowerCase())
          .filter((value) => value.length > 0),
      ),
    );
    if (nameTokens.length === 0) {
      nodes.forEach((node) => appendNodeID(node.id));
      return appendOrder;
    }
    nodes.forEach((node) => {
      const name = (node.name || "").toLowerCase();
      if (nameTokens.some((token) => name.includes(token))) {
        appendNodeID(node.id);
      }
    });
    return appendOrder;
  }
  normalizedRefs.forEach((ref) => {
    if (ref.type === "country") {
      const query = normalizeCountryToken(ref.node);
      if (!query) {
        return;
      }
      nodes.forEach((node) => {
        const country = normalizeCountryToken(node.country || node.region || "");
        if (country && country === query) {
          appendNodeID(node.id);
        }
      });
      return;
    }
    const query = ref.node.toLowerCase();
    if (!query) {
      return;
    }
    nodes.forEach((node) => {
      if ((node.name || "").toLowerCase().includes(query)) {
        appendNodeID(node.id);
      }
    });
  });
  return appendOrder;
}

function isNodeProbeAvailable(node: VpnNode): boolean {
  const score = Number(node.probeScore ?? 0);
  return (node.latencyMs ?? -1) > 0 && (node.probeRealConnectMs ?? -1) > 0 && score > 0;
}

function buildTopAvailableNodeIDs(pool: RulePolicyGroup, nodes: VpnNode[]): string[] {
  const refs = pool.nodePool?.nodes ?? [];
  const candidateIDs = resolvePoolCandidateNodeIDs(refs, nodes);
  if (candidateIDs.length === 0) {
    return [];
  }
  const byID = new Map(nodes.map((node) => [node.id, node]));
  const candidates: VpnNode[] = [];
  candidateIDs.forEach((id) => {
    const node = byID.get(id);
    if (!node || !isNodeProbeAvailable(node)) {
      return;
    }
    candidates.push(node);
  });
  candidates.sort((left, right) => {
    const scoreDiff = (right.probeScore ?? 0) - (left.probeScore ?? 0);
    if (Math.abs(scoreDiff) > 0.0001) {
      return scoreDiff;
    }
    const realConnectDiff = (left.probeRealConnectMs ?? 0) - (right.probeRealConnectMs ?? 0);
    if (realConnectDiff !== 0) {
      return realConnectDiff;
    }
    return (left.latencyMs ?? 0) - (right.latencyMs ?? 0);
  });
  return normalizeNodeIDList(candidates.slice(0, 5).map((node) => node.id));
}

function valueHelpTextByType(refType: NodeRefType): string {
  if (refType === "country") {
    return [
      "通用说明:",
      "- 若“节点数组”留空，将默认使用当前激活订阅分组的全部节点。",
      "- 若候选节点全部不可用，命中该节点池的请求会按回退方案执行。",
      "",
      "国家类型说明:",
      "- 可通过上方“快速选择国家”多选下拉框自动回填。",
      "- 每行一个国家代码。",
      "- 取值来源: 订阅/节点表格的“国家”列。",
      "- 示例: HK / JP / CN",
      "- 推荐填写大写国家缩写。",
    ].join("\n");
  }
  return [
    "通用说明:",
    "- 若“节点数组”留空，将默认使用当前激活订阅分组的全部节点。",
    "- 若候选节点全部不可用，命中该节点池的请求会按回退方案执行。",
    "",
    "名称类型说明:",
    "- 每行一个名称关键词，按“名称包含”匹配。",
    "- 取值来源: 订阅/节点表格的“名称”列。",
    "- 示例: 高级节点01 / 测试节点 / abc节点",
  ].join("\n");
}

function valuePlaceholderByType(refType: NodeRefType): string {
  if (refType === "country") {
    return "HK\nJP\nCN";
  }
  return "高级节点01\n测试节点\nabc节点";
}

function refTypeLabel(refType: NodeRefType): string {
  if (refType === "country") {
    return "国家";
  }
  return "名称";
}

function resolvePoolTypeLabel(record: RulePolicyGroup): string {
  const refs = record.nodePool?.nodes ?? [];
  if (refs.length === 0) {
    return "全部节点";
  }
  const normalizedTypes = Array.from(
    new Set(refs.map((ref) => normalizeRefType(ref.type))),
  );
  if (normalizedTypes.length === 1) {
    return refTypeLabel(normalizedTypes[0]!);
  }
  return "混合";
}

export function NodePoolTable({
  value,
  activeNodes,
  onProbeActiveGroupRealConnect,
  onChange,
}: NodePoolTableProps) {
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingID, setEditingID] = useState<string>("");
  const [draft, setDraft] = useState<NodePoolDraft>(() => buildEmptyDraft());
  const [filteringNodePools, setFilteringNodePools] = useState(false);
  const [applyingDraftChanges, setApplyingDraftChanges] = useState(false);

  const snapshotNodePools = useMemo(
    () => value.filter((item) => item.type === "node_pool"),
    [value],
  );
  const [draftNodePools, setDraftNodePools] = useState<RulePolicyGroup[]>(snapshotNodePools);
  const [draftTouched, setDraftTouched] = useState(false);

  useEffect(() => {
    if (!draftTouched) {
      setDraftNodePools(snapshotNodePools);
      return;
    }
    if (!hasNodePoolDraftChanges(snapshotNodePools, draftNodePools)) {
      setDraftNodePools(snapshotNodePools);
      setDraftTouched(false);
    }
  }, [snapshotNodePools, draftNodePools, draftTouched]);

  const hasDraftChanges = useMemo(
    () => hasNodePoolDraftChanges(snapshotNodePools, draftNodePools),
    [snapshotNodePools, draftNodePools],
  );
  const hasVisibleDraftChanges = draftTouched && hasDraftChanges;

  useDraftNavLock({
    lockClassName: "rules-node-pool-draft-nav-lock",
    enabled: hasVisibleDraftChanges,
  });

  const replacePools = (nextPools: RulePolicyGroup[]): Promise<boolean> => {
    return onChange(mergeNodePoolsIntoGroups(value, nextPools));
  };

  const applyDraftChanges = async () => {
    if (applyingDraftChanges || !hasVisibleDraftChanges) {
      return;
    }
    setApplyingDraftChanges(true);
    try {
      const saved = await replacePools(draftNodePools);
      if (!saved) {
        return;
      }
      setDraftTouched(false);
    } finally {
      setApplyingDraftChanges(false);
    }
  };

  const discardDraftChanges = () => {
    if (applyingDraftChanges) {
      return;
    }
    setDraftNodePools(snapshotNodePools);
    setDraftTouched(false);
    draftNotice.notifyDraftReverted("节点池");
  };

  const activeNodeByID = useMemo(
    () => new Map(activeNodes.map((node) => [node.id, node])),
    [activeNodes],
  );
  const selectedCountryCodes = useMemo(
    () => (draft.refType === "country" ? parseCountryCodesFromText(draft.nodesText) : []),
    [draft.nodesText, draft.refType],
  );

  const columns: ColumnsType<RulePolicyGroup> = useMemo(() => {
    return [
      {
        title: "名称",
        dataIndex: "name",
        key: "name",
        width: 180,
      },
      {
        title: "类型",
        key: "type",
        width: 96,
        render: (_value, record) => resolvePoolTypeLabel(record),
      },
      {
        title: "优选条件",
        key: "refs",
        render: (_value, record) => {
          const refs = record.nodePool?.nodes ?? [];
          if (refs.length === 0) {
            return (
              <Typography.Text type="secondary">
                未配置（默认活动分组全部节点）
              </Typography.Text>
            );
          }
          return (
            <Space size={[4, 4]} wrap>
              {refs.slice(0, 6).map((ref, index) => (
                <Tag key={`${record.id}-${index}`}>{renderPoolConditionLabel(ref)}</Tag>
              ))}
              {refs.length > 6 ? <Tag>+{refs.length - 6}</Tag> : null}
            </Space>
          );
        },
      },
      {
        title: "启用",
        key: "enabled",
        width: 110,
        render: (_value, record) => (
          <div className="table-switch-only-cell">
            <Switch
              checked={record.nodePool?.enabled !== false}
              onChange={(checked) => {
                setDraftNodePools((prev) =>
                  prev.map((item) =>
                    item.id === record.id
                      ? {
                          ...item,
                          nodePool: {
                            enabled: checked,
                            nodes: item.nodePool?.nodes ?? [],
                            nodeSelectStrategy:
                              item.nodePool?.nodeSelectStrategy === "first"
                                ? "first"
                                : "fastest",
                            fallbackMode:
                              item.nodePool?.fallbackMode === "active_node"
                                ? "active_node"
                                : "reject",
                            availableNodeIds: normalizeNodeIDList(
                              item.nodePool?.availableNodeIds,
                            ),
                          },
                        }
                      : item,
                  ),
                );
                setDraftTouched(true);
              }}
            />
          </div>
        ),
      },
      {
        title: "优选结果",
        key: "available",
        width: 360,
        render: (_value, record) => {
          const enabled = record.nodePool?.enabled !== false;
          if (!enabled) {
            return <Typography.Text type="secondary">已禁用（按回退方案执行）</Typography.Text>;
          }
          const availableNodeIDs = normalizeNodeIDList(
            record.nodePool?.availableNodeIds,
          );
          if (availableNodeIDs.length === 0) {
            return (
              <Typography.Text type="secondary">
                未筛选（点击“筛选节点”后自动回填前5）
              </Typography.Text>
            );
          }
          return (
            <Space size={[4, 4]} wrap>
              {availableNodeIDs.slice(0, 5).map((nodeID) => {
                const node = activeNodeByID.get(nodeID);
                const score =
                  typeof node?.probeScore === "number" && node.probeScore > 0
                    ? ` ${node.probeScore.toFixed(1)}`
                    : "";
                return (
                  <Tag key={`${record.id}-${nodeID}`}>
                    {node ? `${node.name}${score}` : nodeID}
                  </Tag>
                );
              })}
              {availableNodeIDs.length > 5 ? <Tag>+{availableNodeIDs.length - 5}</Tag> : null}
            </Space>
          );
        },
      },
      {
        title: "操作",
        key: "actions",
        width: 160,
        render: (_value, record) => (
          <Space size={8}>
            <Button
              type="link"
              onClick={() => {
                setEditingID(record.id);
                setDraft(toDraft(record));
                setModalOpen(true);
              }}
            >
              编辑
            </Button>
            <Popconfirm
              title={`删除节点池 ${record.name || record.id}?`}
              okText="删除"
              cancelText="取消"
              onConfirm={() => {
                setDraftNodePools((prev) =>
                  prev.filter((item) => item.id !== record.id),
                );
                setDraftTouched(true);
              }}
            >
              <Button type="link" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ];
  }, [activeNodeByID]);

  const saveDraft = () => {
    const centerNoticeOptions = {
      title: "节点池保存失败",
      placement: "top-center" as const,
    };
    const name = draft.name.trim();
    if (!name) {
      notice.error("节点池名称不能为空", centerNoticeOptions);
      return;
    }
    const reservedIDs = new Set(["direct", "proxy", "reject"]);
    const usedIDs = new Set(
      value
        .filter((item) => item.id !== editingID)
        .map((item) => item.id.trim().toLowerCase()),
    );
    for (const reserved of reservedIDs) {
      usedIDs.add(reserved);
    }
    let id = draft.id.trim();
    if (!editingID) {
      id = buildRandomPoolID(usedIDs);
    }
    if (!id) {
      id = buildRandomPoolID(usedIDs);
    }
    if (usedIDs.has(id.toLowerCase())) {
      notice.error("ID已存在（大小写不区分），且不能与内置策略组重名", centerNoticeOptions);
      return;
    }
    const refs = splitNodeLines(draft.nodesText)
      .map((item) => ({
        type: draft.refType,
        node: normalizeDraftNodeValue(draft.refType, item),
      }))
      .filter((item) => item.node !== "");
    const nextItem: RulePolicyGroup = {
      id,
      name,
      type: "node_pool",
      nodePool: {
        enabled: draft.enabled,
        nodeSelectStrategy: "fastest",
        fallbackMode: draft.fallbackMode,
        availableNodeIds: [],
        nodes: refs,
      },
    };
    if (editingID) {
      setDraftNodePools((prev) => prev.map((item) => (item.id === editingID ? nextItem : item)));
    } else {
      setDraftNodePools((prev) => [...prev, nextItem]);
    }
    setDraftTouched(true);
    setEditingID("");
    setModalOpen(false);
  };

  const filterAvailableNodePools = async () => {
    if (draftNodePools.length === 0) {
      notice.warning("当前没有可筛选的节点池");
      return;
    }
    setFilteringNodePools(true);
    try {
      let latestActiveNodes = activeNodes;
      if (onProbeActiveGroupRealConnect) {
        latestActiveNodes = await onProbeActiveGroupRealConnect();
      }
      if (latestActiveNodes.length === 0) {
        notice.warning("当前激活分组没有可筛选节点");
        return;
      }
      let updatedCount = 0;
      const nextPools: RulePolicyGroup[] = draftNodePools.map((item): RulePolicyGroup => {
        if (item.type !== "node_pool") {
          return item;
        }
        const sourcePool = item.nodePool;
        const enabled = sourcePool?.enabled !== false;
        const fallbackMode: RuleNodePoolFallbackMode =
          sourcePool?.fallbackMode === "active_node" ? "active_node" : "reject";
        const nodeSelectStrategy =
          sourcePool?.nodeSelectStrategy === "first" ? "first" : "fastest";
        const previousAvailable = normalizeNodeIDList(sourcePool?.availableNodeIds);
        const nextAvailable = enabled ? buildTopAvailableNodeIDs(item, latestActiveNodes) : [];
        if (JSON.stringify(previousAvailable) !== JSON.stringify(nextAvailable)) {
          updatedCount += 1;
        }
        return {
          ...item,
          nodePool: {
            enabled,
            nodes: sourcePool?.nodes ?? [],
            nodeSelectStrategy,
            fallbackMode,
            availableNodeIds: nextAvailable,
          },
        };
      });
      setDraftNodePools(nextPools);
      setDraftTouched(true);
      const saved = await replacePools(nextPools);
      if (!saved) {
        notice.error("筛选结果保存失败，请稍后重试");
        return;
      }
      setDraftTouched(false);
      notice.success(`筛选完成：已更新 ${updatedCount} 个节点池`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "筛选节点失败");
    } finally {
      setFilteringNodePools(false);
    }
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
          title: "保存节点池草稿",
          label: "保存",
          icon: <BiIcon name="check-lg" />,
          loading: applyingDraftChanges,
          disabled: filteringNodePools,
          onClick: () => {
            void applyDraftChanges();
          },
        }}
        discard={{
          title: "取消节点池草稿",
          label: "取消",
          icon: <BiIcon name="x-lg" />,
          disabled: applyingDraftChanges || filteringNodePools,
          onClick: discardDraftChanges,
        }}
      />

      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Space
          size={8}
          align="center"
          wrap
        >
          <HelpLabel
            label={
              <Typography.Text strong style={{ fontSize: 15, color: "#1f2430" }}>
                节点池管理
              </Typography.Text>
            }
            helpContent={{
              scene: "需要把某类流量限制在特定节点集合中，并为这批候选节点设置统一回退行为时使用。",
              effect:
                "这里用于配置规则“动作=节点池”时的优选条件、启用状态、回退方案和优选结果；筛选节点后会按评分保留最多 5 个候选节点。",
              caution:
                "节点池禁用后，绑定该节点池的规则会直接按回退方案执行；修改“节点类型”或“优选条件”后，建议重新执行一次“筛选节点”。",
            }}
          />
        </Space>
        <Space size={8}>
          <Button
            loading={filteringNodePools}
            onClick={() => {
              void filterAvailableNodePools();
            }}
          >
            筛选节点
          </Button>
          <Button
            type="primary"
            onClick={() => {
              setEditingID("");
              setDraft(buildEmptyDraft());
              setModalOpen(true);
            }}
          >
            新增节点池
          </Button>
        </Space>
      </Space>

      <Table<RulePolicyGroup>
        rowKey="id"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={draftNodePools}
      />

      <Modal
        title={editingID ? "编辑节点池" : "新增节点池"}
        open={modalOpen}
        onOk={saveDraft}
        onCancel={() => setModalOpen(false)}
        width={860}
        okText="保存"
        cancelText="取消"
      >
        <Form
          layout="vertical"
          requiredMark={false}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "280px minmax(0, 1fr)",
              gap: 16,
              alignItems: "start",
            }}
          >
            <div>
              <Form.Item
                label={
                  <HelpLabel
                    label="节点池名称"
                    helpContent={[
                      "使用场景:",
                      "- 页面展示与业务识别。",
                      "",
                      "作用:",
                      "- 仅用于可读性，不参与内核匹配。",
                      "",
                      "推荐:",
                      "- 使用业务语义命名，如 美国节点池。",
                    ].join("\n")}
                  />
                }
                style={{ marginBottom: 16 }}
              >
                <Input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="例如: 美国节点池"
                />
              </Form.Item>

              <Form.Item
                label={
                  <HelpLabel
                    label="启用"
                    helpContent={[
                      "使用场景:",
                      "- 临时禁用某个节点池且保留配置内容。",
                      "",
                      "作用:",
                      "- 关闭后，绑定该节点池的规则将直接执行回退方案。",
                      "",
                      "注意点:",
                      "- 关闭不删除节点池内容，重新开启后可恢复使用。",
                    ].join("\n")}
                  />
                }
                style={{ marginBottom: 16 }}
              >
                <Switch
                  checked={draft.enabled}
                  onChange={(checked) => setDraft({ ...draft, enabled: checked })}
                />
              </Form.Item>

              <Form.Item
                label={
                  <HelpLabel
                    label="节点类型"
                    helpContent={[
                      "选择一类匹配方式后，按对应类型填写优选条件。",
                      "",
                      "- 国家: 使用订阅/节点表格“国家”简称（如 HK / JP / CN）。",
                      "- 名称: 使用订阅/节点表格“名称”列关键词，按包含匹配。",
                    ].join("\n")}
                  />
                }
                style={{ marginBottom: 16 }}
              >
                <Radio.Group
                  value={draft.refType}
                  options={strictRefTypeOptions}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      refType: event.target.value as NodeRefType,
                    })
                  }
                />
              </Form.Item>

              <Form.Item
                label={
                  <HelpLabel
                    label="回退方案"
                    helpContent={[
                      "使用场景:",
                      "- 当节点池禁用或候选节点全部不可用时执行。",
                      "",
                      "作用:",
                      "- 决定最终兜底流量走向。",
                      "",
                      "选项说明:",
                      "- 拦截: 直接阻断请求。",
                      "- 走当前激活节点: 复用当前激活代理节点继续转发。",
                    ].join("\n")}
                  />
                }
                style={{ marginBottom: 0 }}
              >
                <Radio.Group
                  value={draft.fallbackMode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fallbackMode: event.target.value as RuleNodePoolFallbackMode,
                    })
                  }
                  options={[
                    { label: "拦截", value: "reject" },
                    { label: "走当前激活节点", value: "active_node" },
                  ]}
                />
              </Form.Item>
            </div>

            <div>
              {draft.refType === "country" ? (
                <Form.Item
                  label={
                    <HelpLabel
                      label="快速选择国家"
                      helpContent={[
                        "使用方式:",
                        "- 仅在“节点类型=国家”时显示。",
                        "- 支持多选搜索国家/地区。",
                        "- 选择后会把国家代码按“每行一个”回填到下方优选条件。",
                      ].join("\n")}
                    />
                  }
                  style={{ marginBottom: 16 }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    showSearch
                    maxTagCount="responsive"
                    style={{ width: "100%" }}
                    placeholder="搜索国家或地区"
                    value={selectedCountryCodes}
                    options={countryQuickSelectOptions}
                    filterOption={(input, option) => {
                      const searchText = String(
                        (option as CountryQuickSelectOption | undefined)?.searchText ?? "",
                      );
                      const query = buildCountrySearchText(input);
                      return query === "" || searchText.includes(query);
                    }}
                    onChange={(nextValues) =>
                      setDraft({
                        ...draft,
                        nodesText: (nextValues as string[]).join("\n"),
                      })
                    }
                  />
                </Form.Item>
              ) : null}

              <Form.Item
                label={
                  <HelpLabel
                    label="优选条件"
                    helpContent={valueHelpTextByType(draft.refType)}
                  />
                }
                style={{ marginBottom: 0 }}
              >
                <Input.TextArea
                  rows={7}
                  value={draft.nodesText}
                  onChange={(event) => setDraft({ ...draft, nodesText: event.target.value })}
                  placeholder={valuePlaceholderByType(draft.refType)}
                />
              </Form.Item>
            </div>
          </div>
        </Form>
      </Modal>
    </Space>
  );
}
