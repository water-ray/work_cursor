import {
  AppstoreOutlined,
  CheckOutlined,
  CloseCircleOutlined,
  CloudSyncOutlined,
  CopyOutlined,
  CloseOutlined,
  DatabaseOutlined,
  PlusOutlined,
  TableOutlined,
} from "@ant-design/icons";
import {
  App as AntdApp,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  NodeGroup,
  NodeProtocol,
  VpnNode,
} from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { daemonApi } from "../../services/daemonApi";

const ALL_GROUP_TAB_ID = "__all_groups__";
const ADD_GROUP_TAB_ID = "__add_group__";
const sortDraftNotificationKey = "subscriptions-sort-draft";
const probeSummaryStorageKey = "wateray.subscriptions.probe_summary.v1";

const commonProtocols: NodeProtocol[] = [
  "vmess",
  "vless",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "tuic",
  "wireguard",
  "socks5",
  "http",
];

interface NodeRow {
  key: string;
  index: number;
  groupId: string;
  groupName: string;
  country: string;
  displayName: string;
  node: VpnNode;
}

interface ContextMenuState {
  x: number;
  y: number;
  rowContext: boolean;
  anchorNodeId: string | null;
}

type ColumnKey =
  | "index"
  | "protocol"
  | "country"
  | "name"
  | "address"
  | "port"
  | "transport"
  | "latency"
  | "totalDownload"
  | "totalUpload"
  | "todayDownload"
  | "todayUpload"
  | "group";

interface ColumnVisibilityOption {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
}

type SortOrder = "none" | "asc" | "desc";

interface SortState {
  key: ColumnKey | "";
  order: SortOrder;
}

interface ProbeSummary {
  testedCount: number;
  availableCount: number;
  timestampMs: number;
}

const columnVisibilityStorageKey = "wateray.subscriptions.visible_columns.v1";

const columnVisibilityOptions: ColumnVisibilityOption[] = [
  { key: "index", label: "序号", defaultVisible: true },
  { key: "protocol", label: "类型", defaultVisible: true },
  { key: "country", label: "国家", defaultVisible: true },
  { key: "name", label: "名称", defaultVisible: true },
  { key: "address", label: "地址", defaultVisible: true },
  { key: "port", label: "端口", defaultVisible: true },
  { key: "transport", label: "传输协议", defaultVisible: true },
  { key: "latency", label: "延迟", defaultVisible: true },
  { key: "totalDownload", label: "总下载", defaultVisible: false },
  { key: "totalUpload", label: "总上传", defaultVisible: false },
  { key: "todayDownload", label: "今日下载", defaultVisible: false },
  { key: "todayUpload", label: "今日上传", defaultVisible: false },
  { key: "group", label: "分组", defaultVisible: true },
];

function protocolLabel(protocol: NodeProtocol): string {
  return protocol.toUpperCase();
}

function normalizeCountryCode(value: string | undefined): string {
  const code = (value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return "";
  }
  return code;
}

function countryFlagUrl(code: string): string {
  return `https://flagcdn.com/w20/${code.toLowerCase()}.png`;
}

function resolveNodeCountry(node: VpnNode): string {
  return normalizeCountryCode(node.country) || normalizeCountryCode(node.region);
}

function cleanDisplayNameByCountry(name: string, countryCode: string): string {
  let result = name.trim();
  if (result.length === 0) {
    return result;
  }
  // Remove leading flag emoji (regional indicator pair), keep country words in name.
  result = result.replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/u, "");
  // Some environments render flag emoji fallback as repeated country code text like "HK HK ...".
  const code = countryCode.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let changed = true;
    while (changed && result.length > 0) {
      changed = false;
      const next = result
        .replace(new RegExp(`^\\[${escaped}\\][\\s\\-_]*`, "i"), "")
        .replace(new RegExp(`^${escaped}[\\s\\-_]+`, "i"), "");
      if (next !== result) {
        result = next.trim();
        changed = true;
      }
    }
  }
  return result || name.trim();
}

function groupRows(groups: NodeGroup[], currentTabId: string): NodeRow[] {
  const nodes =
    currentTabId === ALL_GROUP_TAB_ID
      ? groups.flatMap((group) =>
          group.nodes.map((node) => ({
            groupId: group.id,
            groupName: group.name,
            node,
          })),
        )
      : groups
          .filter((group) => group.id === currentTabId)
          .flatMap((group) =>
            group.nodes.map((node) => ({
              groupId: group.id,
              groupName: group.name,
              node,
            })),
          );

  return nodes.map((item, index) => {
    const country = resolveNodeCountry(item.node);
    return {
      key: item.node.id,
      index: index + 1,
      groupId: item.groupId,
      groupName: item.groupName,
      country,
      displayName: cleanDisplayNameByCountry(item.node.name, country),
      node: item.node,
    };
  });
}

function loadVisibleColumns(): ColumnKey[] {
  const defaultColumns = columnVisibilityOptions
    .filter((item) => item.defaultVisible)
    .map((item) => item.key);
  try {
    const raw = window.localStorage.getItem(columnVisibilityStorageKey);
    if (!raw) {
      return defaultColumns;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return defaultColumns;
    }
    const valid = parsed.filter((item): item is ColumnKey =>
      columnVisibilityOptions.some((option) => option.key === item),
    );
    if (!valid.includes("index")) {
      valid.unshift("index");
    }
    return Array.from(new Set(valid));
  } catch {
    return defaultColumns;
  }
}

function loadProbeSummaryByScope(): Record<string, ProbeSummary> {
  try {
    const raw = window.localStorage.getItem(probeSummaryStorageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, ProbeSummary>;
    if (typeof parsed !== "object" || parsed == null) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function formatTrafficMB(value: number): string {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} GB`;
  }
  return `${value.toFixed(1)} MB`;
}

function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return "未探测";
  }
  return new Date(timestampMs).toLocaleString("zh-CN", {
    hour12: false,
  });
}

function shortenMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${text.slice(0, left)}...${text.slice(text.length - right)}`;
}

function normalizeTrafficToken(value: string): string {
  const compact = value.replace(/\s*\/\s*/g, "/").trim();
  return compact.replace(
    /(\d+(?:\.\d+)?)\s*([kmgpt])\s*(i)?\s*b/gi,
    (_raw, amount: string, unit: string, hasI: string | undefined) =>
      `${amount}${unit.toUpperCase()}${hasI ? "i" : ""}B`,
  );
}

function parseSubscriptionStatus(status: string): {
  traffic: string;
  date: string;
  fallback: string;
  title: string;
} {
  const text = status.trim();
  if (text === "") {
    return {
      traffic: "",
      date: "",
      fallback: "-",
      title: "-",
    };
  }
  const trafficMatch = text.match(
    /(\d+(?:\.\d+)?\s*[KMGTP]i?B\s*\/\s*\d+(?:\.\d+)?\s*[KMGTP]i?B)/i,
  );
  const dateMatch = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
  const traffic = trafficMatch ? normalizeTrafficToken(trafficMatch[1]) : "";
  const date = dateMatch ? dateMatch[1].replace(/\//g, "-") : "";
  const cleaned = text
    .replace(/^status\s*[:=]\s*/i, "")
    .replace(/^流量\s*[:：]\s*/i, "")
    .replace(/到期时间\s*[:：]\s*/gi, "")
    .trim();
  return {
    traffic,
    date,
    fallback: cleaned || "-",
    title: text,
  };
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function reorderListByMove(
  source: string[],
  moveIDs: string[],
  targetID: string,
  placeAfter: boolean,
): string[] {
  const moveSet = new Set(moveIDs);
  const remaining = source.filter((id) => !moveSet.has(id));
  const insertIndex = remaining.indexOf(targetID);
  if (insertIndex < 0) {
    return source;
  }
  const next = [...remaining];
  const index = placeAfter ? insertIndex + 1 : insertIndex;
  next.splice(index, 0, ...moveIDs);
  return next;
}

function applyNodeOrder(nodes: VpnNode[], order: string[] | undefined): VpnNode[] {
  if (!order || order.length !== nodes.length) {
    return nodes;
  }
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const reordered = order.map((id) => nodeByID.get(id)).filter((node): node is VpnNode => Boolean(node));
  if (reordered.length !== nodes.length) {
    return nodes;
  }
  return reordered;
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function compareRowsByColumn(left: NodeRow, right: NodeRow, columnKey: ColumnKey): number {
  switch (columnKey) {
    case "index":
      return left.index - right.index;
    case "protocol":
      return normalizeValue(left.node.protocol).localeCompare(normalizeValue(right.node.protocol));
    case "country":
      return normalizeValue(left.country).localeCompare(normalizeValue(right.country));
    case "name":
      return normalizeValue(left.displayName).localeCompare(normalizeValue(right.displayName));
    case "address":
      return normalizeValue(left.node.address).localeCompare(normalizeValue(right.node.address));
    case "port":
      return left.node.port - right.node.port;
    case "transport":
      return normalizeValue(left.node.transport).localeCompare(normalizeValue(right.node.transport));
    case "latency":
      return left.node.latencyMs - right.node.latencyMs;
    case "totalDownload":
      return left.node.totalDownloadMb - right.node.totalDownloadMb;
    case "totalUpload":
      return left.node.totalUploadMb - right.node.totalUploadMb;
    case "todayDownload":
      return left.node.todayDownloadMb - right.node.todayDownloadMb;
    case "todayUpload":
      return left.node.todayUploadMb - right.node.todayUploadMb;
    case "group":
      return normalizeValue(left.groupName).localeCompare(normalizeValue(right.groupName));
    default:
      return 0;
  }
}

export function SubscriptionsPage({
  snapshot,
  loading,
  runAction,
}: DaemonPageProps) {
  const { message, notification } = AntdApp.useApp();
  const [activeTabId, setActiveTabId] = useState<string>(ALL_GROUP_TAB_ID);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [hoveredRowKey, setHoveredRowKey] = useState<string>("");
  const [localActiveNodeID, setLocalActiveNodeID] = useState<string>("");
  const [sortState, setSortState] = useState<SortState>({
    key: "",
    order: "none",
  });
  const [draftGroupOrder, setDraftGroupOrder] = useState<string[] | null>(null);
  const [draftNodeOrders, setDraftNodeOrders] = useState<Record<string, string[]>>({});
  const [draggingGroupID, setDraggingGroupID] = useState<string>("");
  const [draggingNodeIDs, setDraggingNodeIDs] = useState<string[]>([]);
  const hasDraftOrderChangesRef = useRef(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<ColumnKey[]>(() =>
    loadVisibleColumns(),
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [probingNodes, setProbingNodes] = useState(false);
  const [probeSummaryByScope, setProbeSummaryByScope] = useState<
    Record<string, ProbeSummary>
  >(() => loadProbeSummaryByScope());
  const [addSubOpen, setAddSubOpen] = useState(false);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const [editingGroupID, setEditingGroupID] = useState("");
  const [subscriptionForm] = Form.useForm<{
    name: string;
    url: string;
  }>();
  const [editGroupForm] = Form.useForm<{
    name: string;
    url: string;
  }>();
  const [nodeForm] = Form.useForm<{
    groupId: string;
    name: string;
    address: string;
    port: number;
    transport: string;
    protocol: NodeProtocol;
  }>();

  const groups = snapshot?.groups ?? [];
  const subscriptions = snapshot?.subscriptions ?? [];
  const snapshotGroupOrder = useMemo(
    () => groups.map((group) => group.id),
    [groups],
  );
  const effectiveGroupOrder = useMemo(() => {
    if (
      draftGroupOrder &&
      draftGroupOrder.length === snapshotGroupOrder.length &&
      draftGroupOrder.every((groupID) => snapshotGroupOrder.includes(groupID))
    ) {
      return draftGroupOrder;
    }
    return snapshotGroupOrder;
  }, [draftGroupOrder, snapshotGroupOrder]);
  const orderedGroups = useMemo(() => {
    const groupByID = new Map(groups.map((group) => [group.id, group]));
    return effectiveGroupOrder
      .map((groupID) => groupByID.get(groupID))
      .filter((group): group is NodeGroup => Boolean(group))
      .map((group) => ({
        ...group,
        nodes: applyNodeOrder(group.nodes, draftNodeOrders[group.id]),
      }));
  }, [groups, effectiveGroupOrder, draftNodeOrders]);
  const baseRows = useMemo(
    () => groupRows(orderedGroups, activeTabId),
    [orderedGroups, activeTabId],
  );
  const selectedScopeRows = useMemo(
    () => groupRows(orderedGroups, activeTabId),
    [orderedGroups, activeTabId],
  );
  const rows = useMemo(() => {
    let nextRows = baseRows;
    if (activeTabId !== ALL_GROUP_TAB_ID && sortState.key && sortState.order !== "none") {
      nextRows = [...baseRows].sort((left, right) =>
        compareRowsByColumn(left, right, sortState.key as ColumnKey),
      );
      if (sortState.order === "desc") {
        nextRows.reverse();
      }
    }
    return nextRows.map((row, index) => ({
      ...row,
      index: index + 1,
    }));
  }, [baseRows, activeTabId, sortState]);
  const selectedRowKeySet = useMemo(
    () => new Set(selectedRowKeys),
    [selectedRowKeys],
  );

  useEffect(() => {
    if (activeTabId === ALL_GROUP_TAB_ID) {
      if (sortState.order !== "none") {
        setSortState({
          key: "",
          order: "none",
        });
      }
      return;
    }
    const exists = orderedGroups.some((group) => group.id === activeTabId);
    if (!exists) {
      setActiveTabId(ALL_GROUP_TAB_ID);
    }
  }, [activeTabId, orderedGroups, sortState.order]);

  useEffect(() => {
    if (contextMenu == null) {
      return;
    }
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    window.localStorage.setItem(
      columnVisibilityStorageKey,
      JSON.stringify(visibleColumnKeys),
    );
  }, [visibleColumnKeys]);

  useEffect(() => {
    window.localStorage.setItem(
      probeSummaryStorageKey,
      JSON.stringify(probeSummaryByScope),
    );
  }, [probeSummaryByScope]);

  const anchorRow = useMemo(
    () => rows.find((row) => row.key === contextMenu?.anchorNodeId) ?? null,
    [rows, contextMenu],
  );

  const operationRows = useMemo(() => {
    if (!contextMenu?.rowContext || anchorRow == null) {
      return [] as NodeRow[];
    }
    const selectedRows = rows.filter((row) => selectedRowKeySet.has(row.key));
    if (selectedRows.some((row) => row.key === anchorRow.key)) {
      return selectedRows;
    }
    return [anchorRow];
  }, [rows, selectedRowKeySet, contextMenu, anchorRow]);

  const targetGroups = useMemo(() => {
    const usedGroupIds = new Set(operationRows.map((row) => row.groupId));
    return orderedGroups.filter((group) => !usedGroupIds.has(group.id));
  }, [orderedGroups, operationRows]);

  const currentTabGroup = useMemo(
    () => orderedGroups.find((group) => group.id === activeTabId) ?? null,
    [orderedGroups, activeTabId],
  );

  const canOperateRows = operationRows.length > 0;
  const canPullSubscription = currentTabGroup?.kind === "subscription";
  const canUseAnchorNode = Boolean(anchorRow);
  const hoveredRowForContext = useMemo(
    () => rows.find((row) => row.key === hoveredRowKey) ?? null,
    [rows, hoveredRowKey],
  );
  const selectedRowsInView = useMemo(
    () => rows.filter((row) => selectedRowKeySet.has(row.key)),
    [rows, selectedRowKeySet],
  );
  const probeRows = useMemo(() => {
    if (selectedRowsInView.length > 0) {
      return selectedRowsInView;
    }
    if (!contextMenu?.rowContext) {
      return [] as NodeRow[];
    }
    if (hoveredRowForContext) {
      return [hoveredRowForContext];
    }
    if (anchorRow) {
      return [anchorRow];
    }
    return [] as NodeRow[];
  }, [selectedRowsInView, contextMenu, hoveredRowForContext, anchorRow]);
  const canProbeFromContext =
    activeTabId !== ALL_GROUP_TAB_ID &&
    snapshot?.proxyMode !== "off" &&
    probeRows.length > 0 &&
    !probingNodes;
  const activeNodeID = snapshot?.selectedNodeId || localActiveNodeID;
  const canSortRows = activeTabId !== ALL_GROUP_TAB_ID;
  const canReorderRows = activeTabId !== ALL_GROUP_TAB_ID && sortState.order === "none";
  const currentGroupNodeOrder = useMemo(
    () => currentTabGroup?.nodes.map((node) => node.id) ?? [],
    [currentTabGroup],
  );
  const isGroupOrderDirty = !sameStringArray(effectiveGroupOrder, snapshotGroupOrder);
  const dirtyNodeOrderGroupIDs = useMemo(() => {
    const snapshotGroupByID = new Map(groups.map((group) => [group.id, group]));
    const dirty: string[] = [];
    for (const [groupID, order] of Object.entries(draftNodeOrders)) {
      const group = snapshotGroupByID.get(groupID);
      if (!group) {
        continue;
      }
      const currentOrder = group.nodes.map((node) => node.id);
      if (order.length !== currentOrder.length) {
        continue;
      }
      if (!sameStringArray(order, currentOrder)) {
        dirty.push(groupID);
      }
    }
    return dirty;
  }, [draftNodeOrders, groups]);
  const sortDraftDirty = canSortRows && sortState.key !== "" && sortState.order !== "none";
  const hasDraftOrderChanges =
    isGroupOrderDirty || dirtyNodeOrderGroupIDs.length > 0 || sortDraftDirty;
  const currentScopeKey = activeTabId === ALL_GROUP_TAB_ID ? ALL_GROUP_TAB_ID : activeTabId;
  const currentSubscriptionSource = useMemo(() => {
    if (!currentTabGroup || currentTabGroup.kind !== "subscription") {
      return null;
    }
    return subscriptions.find((item) => item.id === currentTabGroup.subscriptionId) ?? null;
  }, [currentTabGroup, subscriptions]);
  const currentSubscriptionURL = currentSubscriptionSource?.url ?? "";
  const currentSubscriptionStatus = (currentSubscriptionSource?.status ?? "").trim();
  const currentSubscriptionStatusView = useMemo(
    () => parseSubscriptionStatus(currentSubscriptionStatus),
    [currentSubscriptionStatus],
  );
  const currentScopeProbeSummary = useMemo(() => {
    if (activeTabId !== ALL_GROUP_TAB_ID) {
      return probeSummaryByScope[currentScopeKey];
    }
    const summaries = Object.entries(probeSummaryByScope)
      .filter(([scopeKey]) => scopeKey !== ALL_GROUP_TAB_ID && scopeKey !== ADD_GROUP_TAB_ID)
      .map(([, summary]) => summary)
      .filter((summary) => summary.timestampMs > 0);
    if (summaries.length === 0) {
      return undefined;
    }
    return {
      testedCount: summaries.reduce((sum, item) => sum + item.testedCount, 0),
      availableCount: summaries.reduce((sum, item) => sum + item.availableCount, 0),
      timestampMs: Math.max(...summaries.map((item) => item.timestampMs)),
    };
  }, [activeTabId, currentScopeKey, probeSummaryByScope]);
  const scopeTotalNodes = selectedScopeRows.length;
  const scopeAvailableNodes =
    currentScopeProbeSummary?.availableCount ??
    selectedScopeRows.filter((row) => row.node.latencyMs > 0).length;
  const scopeProbedNodes = currentScopeProbeSummary?.testedCount ?? scopeAvailableNodes;
  const scopeLastProbeTimeLabel = currentScopeProbeSummary
    ? formatTimestamp(currentScopeProbeSummary.timestampMs)
    : "未探测";
  const scopeTotalDownloadMB = selectedScopeRows.reduce(
    (sum, row) => sum + row.node.totalDownloadMb,
    0,
  );
  const scopeTotalUploadMB = selectedScopeRows.reduce(
    (sum, row) => sum + row.node.totalUploadMb,
    0,
  );
  const scopeTodayDownloadMB = selectedScopeRows.reduce(
    (sum, row) => sum + row.node.todayDownloadMb,
    0,
  );
  const scopeTodayUploadMB = selectedScopeRows.reduce(
    (sum, row) => sum + row.node.todayUploadMb,
    0,
  );

  useEffect(() => {
    setDraftGroupOrder((previous) => {
      if (!previous) {
        return previous;
      }
      if (
        previous.length === snapshotGroupOrder.length &&
        previous.every((groupID) => snapshotGroupOrder.includes(groupID))
      ) {
        return previous;
      }
      return null;
    });
    setDraftNodeOrders((previous) => {
      const groupByID = new Map(groups.map((group) => [group.id, group]));
      const next: Record<string, string[]> = {};
      for (const [groupID, order] of Object.entries(previous)) {
        const group = groupByID.get(groupID);
        if (!group || order.length !== group.nodes.length) {
          continue;
        }
        const currentSet = new Set(group.nodes.map((node) => node.id));
        if (order.every((nodeID) => currentSet.has(nodeID))) {
          next[groupID] = order;
        }
      }
      return next;
    });
  }, [groups, snapshotGroupOrder]);

  useEffect(() => {
    if (snapshot?.selectedNodeId) {
      setLocalActiveNodeID(snapshot.selectedNodeId);
    }
  }, [snapshot?.selectedNodeId]);

  const activateNode = useCallback(
    async (row: NodeRow, connect: boolean): Promise<void> => {
      try {
        const next = await runAction(() => daemonApi.selectNode(row.node.id, row.groupId));
        setLocalActiveNodeID(next.selectedNodeId || row.node.id);
        if (connect && next.connectionStage !== "connected") {
          await runAction(() => daemonApi.startConnection());
        }
        message.success(connect ? `已连接节点：${row.node.name}` : `已切换节点：${row.node.name}`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "切换节点失败");
      }
    },
    [runAction, message],
  );

  const hoveredRow = useMemo(
    () => rows.find((row) => row.key === hoveredRowKey) ?? null,
    [rows, hoveredRowKey],
  );

  useEffect(() => {
    if (!hoveredRow) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (
        tagName === "input" ||
        tagName === "textarea" ||
        target?.isContentEditable ||
        target?.closest(".ant-select-selector")
      ) {
        return;
      }
      event.preventDefault();
      void activateNode(hoveredRow, false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hoveredRow, activateNode]);

  const probeConnectivityFromContext = async (): Promise<void> => {
    if (!snapshot || snapshot.proxyMode === "off" || probeRows.length === 0) {
      return;
    }
    const activeGroupId = activeTabId === ALL_GROUP_TAB_ID ? "" : activeTabId;
    const targetNodeIDs = probeRows.map((row) => row.node.id);
    const targetNodeIDSet = new Set(targetNodeIDs);
    setProbingNodes(true);
    try {
      const next = await runAction(() =>
        daemonApi.probeNodes({
          groupId: activeGroupId,
          nodeIds: targetNodeIDs,
          timeoutMs: 5000,
        }),
      );
      const nextRows = groupRows(next.groups ?? [], activeTabId);
      const scopedRows = nextRows.filter((row) => targetNodeIDSet.has(row.node.id));
      const available = scopedRows.filter((row) => row.node.latencyMs > 0).length;
      setProbeSummaryByScope((previous) => ({
        ...previous,
        [currentScopeKey]: {
          testedCount: scopedRows.length,
          availableCount: available,
          timestampMs: Date.now(),
        },
      }));
      message.success(`探测完成：可用 ${available}/${scopedRows.length}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "节点连通性探测失败");
    } finally {
      setProbingNodes(false);
    }
  };

  const copyCurrentSubscriptionURL = async (): Promise<void> => {
    if (!currentSubscriptionURL) {
      return;
    }
    try {
      await navigator.clipboard.writeText(currentSubscriptionURL);
      message.success("订阅链接已复制");
    } catch {
      message.warning("复制失败，请检查系统剪贴板权限");
    }
  };

  const confirmRemoveGroup = (group: NodeGroup): void => {
    Modal.confirm({
      title: "删除分组",
      content: `是否删除 ${group.name} 分组, 共 ${group.nodes.length} 条节点记录?`,
      okText: "确定",
      cancelText: "取消",
      onOk: async () => {
        try {
          const nodeIDSet = new Set(group.nodes.map((node) => node.id));
          await runAction(() => daemonApi.removeGroup(group.id));
          setSelectedRowKeys((prev) => prev.filter((nodeID) => !nodeIDSet.has(nodeID)));
          if (activeTabId === group.id) {
            setActiveTabId(ALL_GROUP_TAB_ID);
          }
          message.success(`已删除分组：${group.name}`);
        } catch (error) {
          message.error(error instanceof Error ? error.message : "删除分组失败");
          throw error;
        }
      },
    });
  };

  const openEditGroupModal = (group: NodeGroup): void => {
    const currentURL =
      group.kind === "subscription" && group.subscriptionId
        ? subscriptions.find((item) => item.id === group.subscriptionId)?.url ?? ""
        : "";
    setEditingGroupID(group.id);
    editGroupForm.setFieldsValue({
      name: group.name,
      url: currentURL,
    });
    setEditGroupOpen(true);
  };

  const submitEditGroup = async (): Promise<void> => {
    if (editingGroupID.trim() === "") {
      message.warning("分组ID无效，请重试");
      return;
    }
    try {
      const values = await editGroupForm.validateFields();
      await runAction(() =>
        daemonApi.updateGroup({
          groupId: editingGroupID,
          name: values.name.trim(),
          url: values.url.trim(),
        }),
      );
      setEditGroupOpen(false);
      setEditingGroupID("");
      editGroupForm.resetFields();
      message.success("分组已更新");
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message);
      }
    }
  };

  const toggleColumnSort = useCallback(
    (columnKey: ColumnKey): void => {
      if (!canSortRows) {
        return;
      }
      setSortState((previous) => {
        if (previous.key !== columnKey || previous.order === "none") {
          return {
            key: columnKey,
            order: "asc",
          };
        }
        if (previous.order === "asc") {
          return {
            key: columnKey,
            order: "desc",
          };
        }
        return {
          key: "",
          order: "none",
        };
      });
    },
    [canSortRows],
  );

  const closeSortDraftNotification = useCallback(() => {
    notification.destroy(sortDraftNotificationKey);
  }, [notification]);

  const applyDraftOrderChanges = useCallback(async (): Promise<void> => {
    if (!hasDraftOrderChanges) {
      return;
    }
    const pendingNodeOrders: Record<string, string[]> = {
      ...draftNodeOrders,
    };
    if (sortDraftDirty && currentTabGroup && sortState.key) {
      const sortableRows = groupRows(orderedGroups, currentTabGroup.id);
      const sortedRows = [...sortableRows].sort((left, right) =>
        compareRowsByColumn(left, right, sortState.key as ColumnKey),
      );
      if (sortState.order === "desc") {
        sortedRows.reverse();
      }
      pendingNodeOrders[currentTabGroup.id] = sortedRows.map((row) => row.node.id);
    }
    const snapshotGroupByID = new Map(groups.map((group) => [group.id, group]));
    const dirtyNodeOrders = Object.entries(pendingNodeOrders)
      .filter(([groupID, order]) => {
        const group = snapshotGroupByID.get(groupID);
        if (!group || order.length !== group.nodes.length) {
          return false;
        }
        const currentOrder = group.nodes.map((node) => node.id);
        return !sameStringArray(order, currentOrder);
      })
      .map(([groupID, order]) => ({
        groupID,
        order,
      }));
    try {
      if (isGroupOrderDirty) {
        await runAction(() => daemonApi.reorderGroups(effectiveGroupOrder));
      }
      for (const item of dirtyNodeOrders) {
        await runAction(() =>
          daemonApi.reorderNodes({
            groupId: item.groupID,
            nodeIds: item.order,
          }),
        );
      }
      setDraftGroupOrder(null);
      setDraftNodeOrders({});
      setDraggingGroupID("");
      setDraggingNodeIDs([]);
      setSortState({
        key: "",
        order: "none",
      });
      closeSortDraftNotification();
      message.success("排序变更已应用");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "应用排序变更失败");
    }
  }, [
    hasDraftOrderChanges,
    draftNodeOrders,
    sortDraftDirty,
    currentTabGroup,
    sortState.key,
    sortState.order,
    orderedGroups,
    groups,
    isGroupOrderDirty,
    effectiveGroupOrder,
    runAction,
    closeSortDraftNotification,
    message,
  ]);

  const discardDraftOrderChanges = useCallback((): void => {
    setDraftGroupOrder(null);
    setDraftNodeOrders({});
    setDraggingGroupID("");
    setDraggingNodeIDs([]);
    setSortState({
      key: "",
      order: "none",
    });
    closeSortDraftNotification();
    message.info("已取消未应用的排序变更");
  }, [closeSortDraftNotification, message]);

  useEffect(() => {
    hasDraftOrderChangesRef.current = hasDraftOrderChanges;
  }, [hasDraftOrderChanges]);

  useEffect(() => {
    if (!hasDraftOrderChanges) {
      closeSortDraftNotification();
      return;
    }
    notification.open({
      key: sortDraftNotificationKey,
      placement: "topRight",
      duration: 0,
      message: "排序编辑中",
      description: (
        <div className="sort-draft-notice-content">
          <Typography.Text type="secondary">
            当前排序为草稿状态，请应用或取消。
          </Typography.Text>
          <Space className="sort-draft-notice-actions" size={10}>
            <Button
              size="large"
              shape="circle"
              className="sort-draft-apply-btn"
              icon={<CheckOutlined />}
              onClick={() => {
                void applyDraftOrderChanges();
              }}
            />
            <Button
              size="large"
              shape="circle"
              className="sort-draft-cancel-btn"
              icon={<CloseCircleOutlined />}
              onClick={discardDraftOrderChanges}
            />
          </Space>
        </div>
      ),
      className: "sort-draft-notification",
      closeIcon: null,
    });
  }, [
    hasDraftOrderChanges,
    notification,
    closeSortDraftNotification,
    applyDraftOrderChanges,
    discardDraftOrderChanges,
  ]);

  useEffect(() => {
    return () => {
      closeSortDraftNotification();
      if (hasDraftOrderChangesRef.current) {
        notification.warning({
          placement: "topRight",
          message: "排序编辑状态未保存",
          description: "你已切换页面，当前排序草稿尚未应用或取消。",
        });
      }
    };
  }, [notification, closeSortDraftNotification]);

  const handleGroupDragStart = (groupID: string) => (event: React.DragEvent<HTMLElement>) => {
    setDraggingGroupID(groupID);
    event.dataTransfer.effectAllowed = "move";
  };

  const handleGroupDragOver = (groupID: string) => (event: React.DragEvent<HTMLElement>) => {
    if (draggingGroupID === "" || draggingGroupID === groupID) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleGroupDrop = (groupID: string) => (event: React.DragEvent<HTMLElement>) => {
    if (draggingGroupID === "" || draggingGroupID === groupID) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientX >= rect.left + rect.width / 2;
    const nextOrder = reorderListByMove(effectiveGroupOrder, [draggingGroupID], groupID, placeAfter);
    if (!sameStringArray(nextOrder, effectiveGroupOrder)) {
      setDraftGroupOrder(nextOrder);
    }
    setDraggingGroupID("");
  };

  const handleRowDragStart = (row: NodeRow) => (event: React.DragEvent<HTMLElement>) => {
    if (!canReorderRows || !currentTabGroup) {
      return;
    }
    const visibleNodeIDSet = new Set(rows.map((item) => item.key));
    const selectedInGroup = selectedRowKeys.filter((nodeID) => visibleNodeIDSet.has(nodeID));
    const movingIDs = selectedInGroup.length > 0 ? selectedInGroup : [row.key];
    setDraggingNodeIDs(movingIDs);
    message.info(`上下拖拽排序(共${movingIDs.length}行)`, 1.2);
    event.dataTransfer.effectAllowed = "move";
  };

  const handleRowDragOver = (row: NodeRow) => (event: React.DragEvent<HTMLElement>) => {
    if (!canReorderRows || draggingNodeIDs.length === 0) {
      return;
    }
    if (draggingNodeIDs.includes(row.key)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleRowDrop = (row: NodeRow) => (event: React.DragEvent<HTMLElement>) => {
    if (!canReorderRows || !currentTabGroup || draggingNodeIDs.length === 0) {
      return;
    }
    event.preventDefault();
    const movingIDs = draggingNodeIDs.filter((nodeID) => currentGroupNodeOrder.includes(nodeID));
    if (movingIDs.length === 0) {
      setDraggingNodeIDs([]);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientY >= rect.top + rect.height / 2;
    const nextOrder = reorderListByMove(currentGroupNodeOrder, movingIDs, row.key, placeAfter);
    if (!sameStringArray(nextOrder, currentGroupNodeOrder)) {
      setDraftNodeOrders((previous) => ({
        ...previous,
        [currentTabGroup.id]: nextOrder,
      }));
    }
    setDraggingNodeIDs([]);
  };

  const menuItems = useMemo<MenuProps["items"]>(() => {
    const items: NonNullable<MenuProps["items"]> = [];
    if (canPullSubscription && currentTabGroup) {
      items.push({
        key: "pull-subscription",
        label: "拉取订阅",
      });
    }
    if (canUseAnchorNode) {
      items.push({
        key: "use-node",
        label: "激活节点",
      });
    }
    if (activeTabId !== ALL_GROUP_TAB_ID) {
      items.push({
        key: "probe-connectivity",
        label: probingNodes ? "探测中..." : "探测连通性",
        disabled: !canProbeFromContext,
      });
    }
    items.push({
      key: "add-node",
      label: "添加节点",
      children: commonProtocols.map((protocol) => ({
        key: `add-node:${protocol}`,
        label: protocolLabel(protocol),
      })),
    });
    items.push({
      key: "select-all",
      label: "全选",
    });
    items.push({
      key: "inverse-select",
      label: "反选",
    });
    if (canOperateRows && targetGroups.length > 0) {
      items.push({
        key: "move-to",
        label: "移动到",
        children: targetGroups.map((group) => ({
          key: `move-to:${group.id}`,
          label: group.name,
        })),
      });
      items.push({
        key: "copy-to",
        label: "复制到",
        children: targetGroups.map((group) => ({
          key: `copy-to:${group.id}`,
          label: group.name,
        })),
      });
    }
    if (canOperateRows) {
      items.push({
        key: "delete",
        label: "删除",
        danger: true,
      });
    }
    return items;
  }, [
    canPullSubscription,
    canUseAnchorNode,
    activeTabId,
    probingNodes,
    canProbeFromContext,
    currentTabGroup,
    canOperateRows,
    targetGroups,
  ]);

  const availableColumnOptions = useMemo(
    () =>
      columnVisibilityOptions.filter(
        (option) => option.key !== "group" || activeTabId === ALL_GROUP_TAB_ID,
      ),
    [activeTabId],
  );

  const visibleColumnKeySet = useMemo(
    () => new Set(visibleColumnKeys),
    [visibleColumnKeys],
  );

  const columnMenuItems = useMemo<NonNullable<MenuProps["items"]>>(
    () =>
      availableColumnOptions.map((option) => ({
        key: option.key,
        label: option.label,
        disabled: option.key === "index",
      })),
    [availableColumnOptions],
  );

  const selectedColumnMenuKeys = useMemo(
    () =>
      availableColumnOptions
        .map((option) => option.key)
        .filter((key) => visibleColumnKeySet.has(key)),
    [availableColumnOptions, visibleColumnKeySet],
  );

  const setColumnVisible = (columnKey: ColumnKey, visible: boolean) => {
    if (columnKey === "index" && !visible) {
      return;
    }
    setVisibleColumnKeys((prev) => {
      const nextSet = new Set(prev);
      if (visible) {
        nextSet.add(columnKey);
      } else {
        nextSet.delete(columnKey);
      }
      nextSet.add("index");
      return columnVisibilityOptions
        .map((option) => option.key)
        .filter((key) => nextSet.has(key));
    });
  };

  const columns = useMemo<ColumnsType<NodeRow>>(() => {
    const visible = new Set(visibleColumnKeys);
    const next: ColumnsType<NodeRow> = [];
    const renderSortableTitle = (label: string, columnKey: ColumnKey) => {
      if (!canSortRows) {
        return label;
      }
      const indicator =
        sortState.key === columnKey
          ? sortState.order === "asc"
            ? "▲"
            : sortState.order === "desc"
              ? "▼"
              : ""
          : "";
      return (
        <span
          className="sortable-column-title"
          onClick={() => toggleColumnSort(columnKey)}
        >
          {label}
          {indicator ? <span className="sortable-column-indicator">{indicator}</span> : null}
        </span>
      );
    };
    if (visible.has("index")) {
      next.push({
        title: renderSortableTitle("序号", "index"),
        dataIndex: "index",
        width: 64,
        align: "center",
      });
    }
    if (visible.has("protocol")) {
      next.push({
        title: renderSortableTitle("类型", "protocol"),
        dataIndex: ["node", "protocol"],
        width: 96,
        ellipsis: true,
        render: (value: NodeProtocol) => protocolLabel(value),
      });
    }
    if (visible.has("country")) {
      next.push({
        title: renderSortableTitle("国家", "country"),
        width: 86,
        render: (_, row) => row.country || "-",
      });
    }
    if (visible.has("name")) {
      next.push({
        title: renderSortableTitle("名称", "name"),
        dataIndex: ["node", "name"],
        width: 190,
        render: (_value: string, row) => {
          const country = row.country;
          const cleanedName = row.displayName;
          return (
            <Space size={6}>
              {country ? (
                <img
                  src={countryFlagUrl(country)}
                  alt={country}
                  width={16}
                  height={12}
                  loading="lazy"
                  style={{ borderRadius: 2, objectFit: "cover", flexShrink: 0 }}
                />
              ) : (
                <Tag>[未知]</Tag>
              )}
              <Tooltip title={cleanedName}>
                <span
                  style={{
                    display: "inline-block",
                    maxWidth: 102,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cleanedName}
                </span>
              </Tooltip>
            </Space>
          );
        },
      });
    }
    if (visible.has("address")) {
      next.push({
        title: renderSortableTitle("地址", "address"),
        dataIndex: ["node", "address"],
        width: 210,
        ellipsis: true,
        render: (value: string) => <span title={value}>{value}</span>,
      });
    }
    if (visible.has("port")) {
      next.push({
        title: renderSortableTitle("端口", "port"),
        dataIndex: ["node", "port"],
        width: 78,
      });
    }
    if (visible.has("transport")) {
      next.push({
        title: renderSortableTitle("传输协议", "transport"),
        dataIndex: ["node", "transport"],
        width: 108,
        ellipsis: true,
      });
    }
    if (visible.has("latency")) {
      next.push({
        title: renderSortableTitle("延迟", "latency"),
        width: 92,
        render: (_, row) => `${row.node.latencyMs} ms`,
      });
    }
    if (visible.has("totalDownload")) {
      next.push({
        title: renderSortableTitle("总下载", "totalDownload"),
        width: 112,
        render: (_, row) => `${row.node.totalDownloadMb.toFixed(1)} MB`,
      });
    }
    if (visible.has("totalUpload")) {
      next.push({
        title: renderSortableTitle("总上传", "totalUpload"),
        width: 112,
        render: (_, row) => `${row.node.totalUploadMb.toFixed(1)} MB`,
      });
    }
    if (visible.has("todayDownload")) {
      next.push({
        title: renderSortableTitle("今日下载", "todayDownload"),
        width: 112,
        render: (_, row) => `${row.node.todayDownloadMb.toFixed(1)} MB`,
      });
    }
    if (visible.has("todayUpload")) {
      next.push({
        title: renderSortableTitle("今日上传", "todayUpload"),
        width: 112,
        render: (_, row) => `${row.node.todayUploadMb.toFixed(1)} MB`,
      });
    }
    if (activeTabId === ALL_GROUP_TAB_ID && visible.has("group")) {
      next.push({
        title: "分组",
        width: 146,
        render: (_: unknown, row: NodeRow) => <Tag color="blue">{row.groupName}</Tag>,
      });
    }
    const activeCellProps = (row: NodeRow) =>
      row.node.id === activeNodeID
        ? {
            className: "active-node-cell",
          }
        : {};
    for (const column of next) {
      column.onCell = activeCellProps;
    }
    return next;
  }, [activeTabId, visibleColumnKeys, activeNodeID, canSortRows, sortState, toggleColumnSort]);

  const handleContextMenu: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const row = target.closest("[data-row-key]") as HTMLElement | null;
    const anchorNodeId = row?.getAttribute("data-row-key") ?? null;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      rowContext: anchorNodeId != null,
      anchorNodeId,
    });
  };

  const handleMenuClick: MenuProps["onClick"] = ({ key }) => {
    setContextMenu(null);
    if (!snapshot) {
      return;
    }
    if (key === "pull-subscription" && currentTabGroup) {
      void runAction(() => daemonApi.pullSubscriptionByGroup(currentTabGroup.id));
      return;
    }
    if (key === "use-node" && anchorRow) {
      void activateNode(anchorRow, false);
      return;
    }
    if (key === "probe-connectivity") {
      void probeConnectivityFromContext();
      return;
    }
    if (key === "select-all") {
      setSelectedRowKeys(rows.map((row) => row.key));
      return;
    }
    if (key === "inverse-select") {
      setSelectedRowKeys((prev) => {
        const current = new Set(prev);
        return rows
          .map((row) => row.key)
          .filter((nodeId) => !current.has(nodeId));
      });
      return;
    }
    if (key.startsWith("add-node:")) {
      const protocol = key.replace("add-node:", "") as NodeProtocol;
      setAddNodeOpen(true);
      const fallbackGroupId =
        activeTabId === ALL_GROUP_TAB_ID
          ? snapshot.activeGroupId || orderedGroups[0]?.id || ""
          : activeTabId;
      nodeForm.setFieldsValue({
        groupId: fallbackGroupId,
        protocol,
        transport: "tcp",
        port: 443,
      });
      return;
    }
    if (key.startsWith("move-to:") || key.startsWith("copy-to:")) {
      const move = key.startsWith("move-to:");
      const targetGroupId = key.split(":")[1];
      if (!targetGroupId || operationRows.length === 0) {
        return;
      }
      void runAction(() =>
        daemonApi.transferNodes({
          targetGroupId,
          nodeIds: operationRows.map((row) => row.node.id),
          move,
        }),
      ).then(() => {
        if (move) {
          setSelectedRowKeys((prev) =>
            prev.filter(
              (keyItem) =>
                !operationRows.some((row) => row.node.id === keyItem.toString()),
            ),
          );
        }
      });
      return;
    }
    if (key === "delete" && operationRows.length > 0) {
      Modal.confirm({
        title: `${activeTabId === ALL_GROUP_TAB_ID ? "当前视图" : currentTabGroup?.name || ""} 删除节点`,
        content: `确定删除 ${operationRows.length} 条节点吗？`,
        okText: "确定",
        cancelText: "取消",
        onOk: async () => {
          let currentSnapshot = snapshot;
          for (const row of operationRows) {
            currentSnapshot = await daemonApi.removeNode(row.groupId, row.node.id);
          }
          setSelectedRowKeys((prev) =>
            prev.filter(
              (keyItem) =>
                !operationRows.some((row) => row.node.id === keyItem.toString()),
            ),
          );
          await runAction(async () => currentSnapshot);
        },
      });
    }
  };

  const currentScopeTypeIcon =
    activeTabId === ALL_GROUP_TAB_ID ? (
      <AppstoreOutlined />
    ) : currentTabGroup?.kind === "subscription" ? (
      <CloudSyncOutlined />
    ) : (
      <DatabaseOutlined />
    );
  const currentScopeName =
    activeTabId === ALL_GROUP_TAB_ID ? "全部分组" : currentTabGroup?.name ?? "未知分组";
  const currentScopeTypeText =
    activeTabId === ALL_GROUP_TAB_ID
      ? "聚合视图"
      : currentTabGroup?.kind === "subscription"
        ? "订阅分组"
        : "手动分组";

  return (
    <Space
      direction="vertical"
      size={12}
      style={{ width: "100%" }}
    >
      <Card
        size="small"
        className="subscriptions-scope-card"
      >
        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Space
            wrap
            size={8}
            className="subscriptions-scope-line"
          >
            <Tag
              color="blue"
              icon={currentScopeTypeIcon}
            >
              {currentScopeTypeText}
            </Tag>
            <Typography.Text strong>{currentScopeName}</Typography.Text>
            <Typography.Text
              type="secondary"
              title={currentSubscriptionURL || "-"}
            >
              URL: {currentSubscriptionURL ? shortenMiddle(currentSubscriptionURL, 26) : "-"}
            </Typography.Text>
            <Tooltip title="复制订阅地址">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                disabled={!currentSubscriptionURL}
                onClick={() => {
                  void copyCurrentSubscriptionURL();
                }}
              />
            </Tooltip>
            {currentSubscriptionStatusView.traffic ? (
              <Tag style={{ fontSize: 12 }}>
                {currentSubscriptionStatusView.traffic}
              </Tag>
            ) : null}
            {currentSubscriptionStatusView.date ? (
              <Tag style={{ fontSize: 12 }}>
                {currentSubscriptionStatusView.date}
              </Tag>
            ) : null}
            {!currentSubscriptionStatusView.traffic && !currentSubscriptionStatusView.date ? (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12 }}
                title={currentSubscriptionStatusView.title}
              >
                {shortenMiddle(currentSubscriptionStatusView.fallback, 36)}
              </Typography.Text>
            ) : null}
          </Space>
          <Space
            wrap
            size={[8, 6]}
            className="subscriptions-scope-line"
          >
            {snapshot?.proxyMode !== "off" ? <Tag color="green">探测状态：可探测</Tag> : null}
            <Tag>总节点：{scopeTotalNodes}</Tag>
            <Tag>已探测：{scopeProbedNodes}</Tag>
            <Tag color="success">可用：{scopeAvailableNodes}</Tag>
            <Tag>上次探测：{scopeLastProbeTimeLabel}</Tag>
            <Tag color="processing">总下载：{formatTrafficMB(scopeTotalDownloadMB)}</Tag>
            <Tag color="processing">总上传：{formatTrafficMB(scopeTotalUploadMB)}</Tag>
            <Tag>今日下载：{formatTrafficMB(scopeTodayDownloadMB)}</Tag>
            <Tag>今日上传：{formatTrafficMB(scopeTodayUploadMB)}</Tag>
          </Space>
        </Space>
      </Card>

      <Card
        loading={loading}
      >
        <Tabs
          className="subscriptions-group-tabs"
          activeKey={activeTabId}
          onChange={(nextKey) => {
            if (nextKey === ADD_GROUP_TAB_ID) {
              setAddSubOpen(true);
              return;
            }
            setActiveTabId(nextKey);
          }}
          tabBarExtraContent={{
            right: (
              <Tooltip title="显示列">
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: columnMenuItems,
                    selectable: true,
                    multiple: true,
                    selectedKeys: selectedColumnMenuKeys,
                    onSelect: ({ key }) => {
                      setColumnVisible(key as ColumnKey, true);
                    },
                    onDeselect: ({ key }) => {
                      setColumnVisible(key as ColumnKey, false);
                    },
                  }}
                >
                  <Button
                    type="text"
                    icon={<TableOutlined />}
                  />
                </Dropdown>
              </Tooltip>
            ),
          }}
          items={[
            {
              key: ALL_GROUP_TAB_ID,
              label: (
                <Space size={6}>
                  <AppstoreOutlined />
                  <span>全部</span>
                </Space>
              ),
            },
            ...orderedGroups.map((group) => ({
              key: group.id,
              label: (
                <span
                  className="group-tab-label"
                  draggable
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openEditGroupModal(group);
                  }}
                  onDragStart={handleGroupDragStart(group.id)}
                  onDragOver={handleGroupDragOver(group.id)}
                  onDrop={handleGroupDrop(group.id)}
                  onDragEnd={() => {
                    setDraggingGroupID("");
                  }}
                >
                  <Tooltip
                    title={
                      group.kind === "subscription"
                        ? "URL 订阅分组，可拉取订阅"
                        : "手动分组，可自定义节点与分类"
                    }
                  >
                    {group.kind === "subscription" ? (
                      <CloudSyncOutlined />
                    ) : (
                      <DatabaseOutlined />
                    )}
                  </Tooltip>
                  <Typography.Text>{group.name}</Typography.Text>
                  {snapshot?.activeGroupId === group.id ? (
                    <span className="active-group-dot" />
                  ) : null}
                  <Button
                    size="small"
                    type="text"
                    className="group-tab-close-btn"
                    icon={<CloseOutlined />}
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
            })),
            {
              key: ADD_GROUP_TAB_ID,
              label: (
                <Tooltip title="添加订阅分组">
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setAddSubOpen(true);
                    }}
                  />
                </Tooltip>
              ),
            },
          ]}
        />
        <div
          className="node-table-context-area"
          onContextMenu={handleContextMenu}
        >
          <Table<NodeRow>
            className="subscriptions-node-table"
            rowKey="key"
            size="small"
            bordered
            virtual
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ x: "max-content", y: 410 }}
            rowClassName={(row) => {
              const names: string[] = [];
              if (row.node.id === activeNodeID) {
                names.push("active-node-row");
              }
              if (canReorderRows) {
                names.push("draggable-node-row");
              }
              return names.join(" ");
            }}
            rowSelection={{
              selectedRowKeys,
              columnWidth: 42,
              onChange: (keys) => {
                setSelectedRowKeys(keys.map((item) => item.toString()));
              },
            }}
            onRow={(row) => ({
              draggable: canReorderRows,
              onDoubleClick: () => {
                void activateNode(row, true);
              },
              onMouseEnter: () => {
                setHoveredRowKey(row.key);
              },
              onMouseLeave: () => {
                setHoveredRowKey((prev) => (prev === row.key ? "" : prev));
              },
              onDragStart: handleRowDragStart(row),
              onDragOver: handleRowDragOver(row),
              onDrop: handleRowDrop(row),
              onDragEnd: () => {
                setDraggingNodeIDs([]);
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
      </Card>

      <Modal
        title="添加订阅分组"
        open={addSubOpen}
        okText="确定"
        cancelText="取消"
        onCancel={() => setAddSubOpen(false)}
        onOk={() => {
          void subscriptionForm.validateFields().then((values) => {
            void runAction(() =>
              daemonApi.addSubscription(values.name.trim(), values.url.trim()),
            )
              .then(() => {
                setAddSubOpen(false);
                subscriptionForm.resetFields();
              })
              .catch((error) => {
                message.error(
                  error instanceof Error ? error.message : "添加订阅失败",
                );
              });
          });
        }}
      >
        <Form
          layout="vertical"
          form={subscriptionForm}
        >
          <Form.Item
            label="名称"
            name="name"
            rules={[{ required: true, message: "请输入订阅名称" }]}
          >
            <Input placeholder="例如：机场A / 手动分组A" />
          </Form.Item>
          <Form.Item
            label="URL（留空表示普通分组）"
            name="url"
          >
            <Input placeholder="https://example.com/subscription" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑分组"
        open={editGroupOpen}
        okText="确定"
        cancelText="取消"
        onCancel={() => {
          setEditGroupOpen(false);
          setEditingGroupID("");
          editGroupForm.resetFields();
        }}
        onOk={() => {
          void submitEditGroup();
        }}
      >
        <Form
          layout="vertical"
          form={editGroupForm}
        >
          <Form.Item
            label="名称"
            name="name"
            rules={[{ required: true, message: "请输入分组名称" }]}
          >
            <Input placeholder="例如：机场A / 手动分组A" />
          </Form.Item>
          <Form.Item
            label="URL（留空表示普通分组）"
            name="url"
          >
            <Input placeholder="https://example.com/subscription" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="添加节点"
        open={addNodeOpen}
        okText="确定"
        cancelText="取消"
        onCancel={() => setAddNodeOpen(false)}
        onOk={() => {
          void nodeForm.validateFields().then((values) => {
            void runAction(() =>
              daemonApi.addManualNode({
                groupId: values.groupId,
                name: values.name.trim(),
                region: values.name.trim(),
                address: values.address.trim(),
                port: values.port,
                transport: values.transport.trim(),
                protocol: values.protocol,
              }),
            )
              .then(() => {
                setAddNodeOpen(false);
                nodeForm.resetFields();
              })
              .catch((error) => {
                message.error(
                  error instanceof Error ? error.message : "添加节点失败",
                );
              });
          });
        }}
      >
        <Form
          layout="vertical"
          form={nodeForm}
        >
          <Form.Item
            label="目标分组"
            name="groupId"
            rules={[{ required: true, message: "请选择分组" }]}
          >
            <Select
              options={orderedGroups.map((group) => ({
                value: group.id,
                label: `${group.kind === "subscription" ? "订阅" : "手动"} · ${group.name}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="节点名称"
            name="name"
            rules={[{ required: true, message: "请输入节点名称" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label="服务器地址"
            name="address"
            rules={[{ required: true, message: "请输入服务器地址" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label="端口"
            name="port"
            rules={[{ required: true, message: "请输入端口" }]}
          >
            <InputNumber
              min={1}
              max={65535}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            label="传输协议"
            name="transport"
            rules={[{ required: true, message: "请输入传输协议" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label="协议类型"
            name="protocol"
            rules={[{ required: true, message: "请选择协议类型" }]}
          >
            <Select
              options={commonProtocols.map((item) => ({
                value: item,
                label: protocolLabel(item),
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
