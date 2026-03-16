import {
  AutoComplete,
  Button,
  Card,
  Collapse,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Menu,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tooltip,
  Typography,
} from "antd";
import type { MenuProps } from "antd";
import type { TableRowSelection } from "antd/es/table/interface";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { DraftActionBar } from "../../components/draft/DraftActionBar";
import { HelpLabel } from "../../components/form/HelpLabel";
import { SwitchWithLabel } from "../../components/form/SwitchWithLabel";
import { CountryFlag } from "../../components/flag/CountryFlag";
import { BiIcon } from "../../components/icons/BiIcon";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../hooks/useDraftNotice";
import { reorderListByMove, sameStringArray } from "./subscriptionsOrderUtils";
import {
  buildColumnMenuItems,
  buildSelectedColumnMenuKeys,
  buildSubscriptionsColumns,
  columnVisibilityStorageKey,
  compareRowsByColumn,
  loadVisibleColumns,
  resolveAvailableColumnOptions,
  resolveVisibleColumns,
  tableSelectionColumnWidth,
} from "./subscriptionsTableColumns";
import { useNodeRowDragSort } from "./useNodeRowDragSort";
import {
  buildSubscriptionsContextMenuItems,
  dispatchSubscriptionsContextMenuAction,
} from "./subscriptionsContextMenu";
import type { ColumnKey, NodeRow, SortState } from "./subscriptionsTableColumns";
import { useSubscriptionsRowActions } from "./useSubscriptionsRowActions";
import { useSubscriptionsGroupActions } from "./useSubscriptionsGroupActions";
import { SubscriptionNodeEditorModal } from "./SubscriptionNodeEditorModal";
import { MobileSwipeActionCard } from "./MobileSwipeActionCard";
import { MobileVirtualList } from "./MobileVirtualList";
import {
  protocolLabel as formatNodeProtocolLabel,
  supportedNodeProtocols,
} from "./nodeProtocolFormSchema";
import {
  probeIntervalMinOptions,
  probeNodeInfoQueryUrlOptions,
  probeRealConnectTestUrlOptions,
  probeTimeoutSecOptions,
  useSubscriptionsProbeDraft,
} from "./useSubscriptionsProbeDraft";
import { serializeNodeToClipboardLine } from "./subscriptionsClipboard";

import type {
  NodeGroup,
  NodeProtocol,
  ProbeNodesSummary,
  ProbeRuntimeStage,
  ProbeRuntimeTask,
  ProbeType,
  ProbeSettings,
  VpnNode,
} from "../../../../shared/daemon";
import { normalizeCountryCode } from "../../app/data/countryMetadata";
import type { DaemonPageProps } from "../../app/types";
import { isMobileRuntime } from "../../platform/runtimeStore";
import { daemonApi } from "../../services/daemonApi";
import { listenSubscriptionsExternalFocus } from "../../services/subscriptionsExternalFocus";
import { listenSubscriptionsUiAction } from "../../services/subscriptionsUiEvents";

const ALL_GROUP_TAB_ID = "__all_groups__";
const ADD_GROUP_TAB_ID = "__add_group__";
const subscriptionsTableScrollHeightPx = 360;
const mobileVirtualNodeCardHeightPx = 52;
const mobileVirtualNodeCardGapPx = 8;

function buildNodeSelectionKey(groupId: string | undefined, nodeId: string | undefined): string {
  const normalizedGroupId = String(groupId ?? "").trim();
  const normalizedNodeId = String(nodeId ?? "").trim();
  if (normalizedGroupId === "" || normalizedNodeId === "") {
    return "";
  }
  return `${normalizedGroupId}:${normalizedNodeId}`;
}

function formatProbeExecutionHint(summary: ProbeNodesSummary | undefined): string {
  const cachedCount = Math.max(0, Number(summary?.cachedResultCount ?? 0));
  const freshCount = Math.max(0, Number(summary?.freshProbeCount ?? 0));
  if (cachedCount > 0 && freshCount > 0) {
    return `，真实探测 ${freshCount}，缓存返回 ${cachedCount}`;
  }
  if (freshCount > 0) {
    return `，真实探测 ${freshCount}`;
  }
  if (cachedCount > 0) {
    return `，缓存返回 ${cachedCount}`;
  }
  return "";
}

interface ContextMenuState {
  x: number;
  y: number;
  rowContext: boolean;
  anchorNodeId: string | null;
}

const appTitlebarHeightPx = 48;
const contextMenuBottomOffsetPx = 30;
const contextMenuViewportPadding = 8;
const contextMenuEstimatedItemHeightPx = 28;
const contextMenuEstimatedDividerHeightPx = 9;
const contextMenuEstimatedPaddingBottomPx = 10;
const contextMenuMinimumVisibleHeightPx = 160;

function estimateContextMenuHeight(items: NonNullable<MenuProps["items"]>): number {
  let height = contextMenuEstimatedPaddingBottomPx;
  for (const item of items) {
    if (!item) {
      continue;
    }
    if ("type" in item && item.type === "divider") {
      height += contextMenuEstimatedDividerHeightPx;
      continue;
    }
    height += contextMenuEstimatedItemHeightPx;
  }
  return height;
}

function resolveContextMenuVisibleHeight(
  viewportHeight: number,
  pointerY: number,
  items: NonNullable<MenuProps["items"]>,
): number {
  const estimatedHeight = estimateContextMenuHeight(items);
  const safeTop = appTitlebarHeightPx;
  const safeBottom = contextMenuBottomOffsetPx;
  const safeHeight = Math.max(0, viewportHeight - safeTop - safeBottom);
  const midpointY = safeTop + safeHeight / 2;
  const preferDown = pointerY <= midpointY;
  const availableDown = Math.max(0, viewportHeight - Math.max(pointerY, safeTop) - safeBottom);
  const availableUp = Math.max(0, pointerY - safeTop);
  const preferredSpace = preferDown ? availableDown : availableUp;
  const fallbackSpace = preferDown ? availableUp : availableDown;
  const targetSpace = Math.max(
    Math.min(estimatedHeight, preferredSpace),
    Math.min(estimatedHeight, fallbackSpace, contextMenuMinimumVisibleHeightPx),
  );
  return Math.max(0, Math.min(estimatedHeight, Math.max(targetSpace, preferredSpace)));
}

function resolveContextMenuY(viewportHeight: number, pointerY: number, menuHeight: number): number {
  const safeTop = appTitlebarHeightPx;
  const safeBottom = contextMenuBottomOffsetPx;
  const safeHeight = Math.max(0, viewportHeight - safeTop - safeBottom);
  const midpointY = safeTop + safeHeight / 2;
  const preferDown = pointerY <= midpointY;
  if (preferDown) {
    return Math.max(safeTop, Math.round(pointerY));
  }
  return Math.max(safeTop, Math.round(pointerY - menuHeight));
}

interface NodeEditorState {
  mode: "add" | "edit";
  protocol: NodeProtocol;
  groupId: string;
  row?: NodeRow;
}

function isUpdateManualNodePayload(
  payload: Parameters<typeof daemonApi.addManualNode>[0] | Parameters<typeof daemonApi.updateManualNode>[0],
): payload is Parameters<typeof daemonApi.updateManualNode>[0] {
  return typeof (payload as { nodeId?: unknown }).nodeId === "string";
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
  const rows: NodeRow[] = [];
  let index = 1;
  for (const group of groups) {
    if (currentTabId !== ALL_GROUP_TAB_ID && group.id !== currentTabId) {
      continue;
    }
    for (const node of group.nodes) {
      const country = resolveNodeCountry(node);
      rows.push({
        key: node.id,
        index,
        groupId: group.id,
        groupName: group.name,
        country,
        displayName: cleanDisplayNameByCountry(node.name, country),
        node,
      });
      index += 1;
    }
  }
  return rows;
}

function formatTrafficMB(value: number): string {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} GB`;
  }
  return `${value.toFixed(1)} MB`;
}

function formatNodeProtocolCompactLabel(protocol: string | undefined): string {
  const normalized = String(protocol ?? "").trim().toUpperCase();
  if (normalized === "") {
    return "-";
  }
  return normalized.length <= 6 ? normalized : normalized.slice(0, 6);
}

function resolveMobileGroupMetaLabel(group: NodeGroup): string {
  return group.kind === "subscription" ? "订阅分组" : "普通分组";
}

function formatProbeScoreLabel(value: number | undefined): string {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(Math.round(value));
  }
  return "-";
}

function formatProbeLatencyLabel(value: number | undefined): string {
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
    return String(Math.round(value));
  }
  return "-";
}

type MobileProbeMetricTone = "good" | "warn" | "bad" | "muted" | "pending";

function resolveMobileProbeToneClass(tone: MobileProbeMetricTone): string {
  return `is-${tone}`;
}

function resolveMobileLatencyMetricTone(value: number | undefined): MobileProbeMetricTone {
  const normalized = Math.round(Number(value ?? 0));
  if (normalized === -1 || normalized >= 1000) {
    return "bad";
  }
  if (normalized >= 200) {
    return "warn";
  }
  if (normalized >= 1) {
    return "good";
  }
  return "muted";
}

function resolveMobileScoreMetricTone(value: number | undefined): MobileProbeMetricTone {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "muted";
  }
  const normalized = Math.round(value);
  if (normalized >= 86) {
    return "good";
  }
  if (normalized >= 51) {
    return "warn";
  }
  return "bad";
}

function resolveMobileMetricText(
  value: number | undefined,
  pending: boolean,
  formatter: (input: number | undefined) => string,
): string {
  return pending && (typeof value !== "number" || value === 0) ? "探测中" : formatter(value);
}

function resolveTrafficMonitorIntervalSec(value: number | undefined): 0 | 1 | 2 | 5 {
  if (value === 1 || value === 2 || value === 5) {
    return value;
  }
  return 0;
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
} {
  const text = status.trim();
  if (text === "") {
    return {
      traffic: "",
      date: "",
      fallback: "-",
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
  };
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

function normalizeProbeRuntimeTasks(tasks: ProbeRuntimeTask[] | undefined): ProbeRuntimeTask[] {
  return Array.isArray(tasks)
    ? tasks.filter((task) => typeof task?.taskId === "string" && task.taskId.trim() !== "")
    : [];
}

function hasProbeRuntimeStage(
  tasks: ProbeRuntimeTask[],
  nodeID: string,
  stage: ProbeRuntimeStage,
): boolean {
  const normalizedNodeID = nodeID.trim();
  if (normalizedNodeID === "") {
    return false;
  }
  for (const task of tasks) {
    for (const nodeState of task.nodeStates ?? []) {
      if ((nodeState.nodeId ?? "").trim() !== normalizedNodeID) {
        continue;
      }
      if ((nodeState.pendingStages ?? []).includes(stage)) {
        return true;
      }
    }
  }
  return false;
}

export function SubscriptionsPage({
  snapshot,
  loading,
  runAction,
  active = true,
}: DaemonPageProps & {
  active?: boolean;
}) {
  const isMobileView = isMobileRuntime();
  const probeRunsInBackground = isMobileView;
  const backgroundTaskHint = probeRunsInBackground
    ? "请通过左上角悬浮图标查看进度。"
    : "请通过后台任务查看进度。";
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const groups = snapshot?.groups ?? [];
  const subscriptions = snapshot?.subscriptions ?? [];
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    if (!groups.length) {
      return ALL_GROUP_TAB_ID;
    }
    if (snapshot?.activeGroupId && groups.some((group) => group.id === snapshot.activeGroupId)) {
      return snapshot.activeGroupId;
    }
    return groups[0].id;
  });
  const [mobileExpandedGroupId, setMobileExpandedGroupId] = useState<string | null>(() =>
    snapshot?.activeGroupId ? snapshot.activeGroupId : (groups[0]?.id ?? null),
  );
  const initializedDefaultTabRef = useRef(activeTabId !== ALL_GROUP_TAB_ID);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [mobileMultiSelectEnabled, setMobileMultiSelectEnabled] = useState(false);
  const [localActiveNodeID, setLocalActiveNodeID] = useState<string>("");
  const activeSelectionKeyRef = useRef<string>(
    buildNodeSelectionKey(snapshot?.activeGroupId, snapshot?.selectedNodeId),
  );
  const activatingNodeKeyRef = useRef<string>("");
  const [sortState, setSortState] = useState<SortState>({
    key: "",
    order: "none",
  });
  const [draftGroupOrder, setDraftGroupOrder] = useState<string[] | null>(null);
  const [draftNodeOrders, setDraftNodeOrders] = useState<Record<string, string[]>>({});
  const draggingGroupIDRef = useRef<string>("");
  const hasDraftChangesRef = useRef(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<ColumnKey[]>(() =>
    loadVisibleColumns(),
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [probingNodes, setProbingNodes] = useState(false);
  const [clearingProbeData, setClearingProbeData] = useState(false);
  const [resettingTrafficStats, setResettingTrafficStats] = useState(false);
  const [updatingNodeCountries, setUpdatingNodeCountries] = useState(false);
  const [locatedNodeID, setLocatedNodeID] = useState("");
  const [pendingExternalFocus, setPendingExternalFocus] = useState<{
    groupId: string;
    nodeId: string;
  } | null>(null);
  const [tableRenderReady, setTableRenderReady] = useState(false);
  const hoveredRowKeyRef = useRef<string>("");
  const rowsByKeyRef = useRef<Map<string, NodeRow>>(new Map());
  const nodeTableContextRef = useRef<HTMLDivElement | null>(null);
  const mobileExpandedGroupScrollRef = useRef<HTMLDivElement | null>(null);
  const contextMenuOverlayRef = useRef<HTMLDivElement | null>(null);
  const {
    probeSettingsExpandedKeys,
    setProbeSettingsExpandedKeys,
    probeSettingsDraft,
    probeTimeoutSecInput,
    probeIntervalMinInput,
    setProbeTimeoutSecInput,
    setProbeIntervalMinInput,
    probeSettingsDirty,
    markProbeSettingsDirty,
    updateProbeSettingsDraft,
    applyProbeTimeoutDraftFromValue,
    commitProbeTimeoutInput,
    applyProbeIntervalDraftFromValue,
    commitProbeIntervalInput,
    getNormalizedProbeSettingsDraft,
    applyProbeSettingsFromSnapshot,
    discardProbeSettingsDraft,
  } = useSubscriptionsProbeDraft({
    snapshotProbeSettings: snapshot?.probeSettings,
    snapshotStateRevision: snapshot?.stateRevision,
  });
  const [applyingDraftChanges, setApplyingDraftChanges] = useState(false);
  const [addSubOpen, setAddSubOpen] = useState(false);
  const [nodeEditorState, setNodeEditorState] = useState<NodeEditorState | null>(null);
  const [submittingNodeEditor, setSubmittingNodeEditor] = useState(false);
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
  const addSubscriptionUrlValue = Form.useWatch("url", subscriptionForm);
  const showAddSubscriptionPullHint = String(addSubscriptionUrlValue ?? "").trim() !== "";

  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        setTableRenderReady(true);
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, []);

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
      .map((group) => {
        const orderedNodes = applyNodeOrder(group.nodes, draftNodeOrders[group.id]);
        if (orderedNodes === group.nodes) {
          return group;
        }
        return {
          ...group,
          nodes: orderedNodes,
        };
      });
  }, [groups, effectiveGroupOrder, draftNodeOrders]);
  const probeRuntimeTasks = useMemo(
    () => normalizeProbeRuntimeTasks(snapshot?.probeRuntimeTasks),
    [snapshot?.probeRuntimeTasks],
  );
  const hasPendingBackgroundProbeTask = useMemo(
    () =>
      (snapshot?.backgroundTasks ?? []).some(
        (task) =>
          task.type === "node_probe" &&
          (task.status === "queued" || task.status === "running"),
      ),
    [snapshot?.backgroundTasks],
  );
  const probeBusy = probingNodes || hasPendingBackgroundProbeTask;
  const trafficMonitoringEnabled =
    resolveTrafficMonitorIntervalSec(snapshot?.trafficMonitorIntervalSec) > 0;
  const realtimeNodeSpeedByID = useMemo(() => {
    const next = new Map<string, { downloadRateBps: number; uploadRateBps: number }>();
    if (!trafficMonitoringEnabled) {
      return next;
    }
    for (const item of snapshot?.activeConnectionNodes ?? []) {
      const nodeID = (item.nodeId ?? "").trim();
      if (nodeID === "") {
        continue;
      }
      next.set(nodeID, {
        downloadRateBps: Math.max(0, Math.trunc(item.downloadRateBps ?? 0)),
        uploadRateBps: Math.max(0, Math.trunc(item.uploadRateBps ?? 0)),
      });
    }
    return next;
  }, [trafficMonitoringEnabled, snapshot?.activeConnectionNodes]);
  const baseRows = useMemo(() => {
    if (isMobileView) {
      if (!active) {
        return [] as NodeRow[];
      }
      const activeGroup = orderedGroups.find((group) => group.id === activeTabId);
      if (!activeGroup) {
        return [] as NodeRow[];
      }
      return groupRows([activeGroup], activeGroup.id);
    }
    return tableRenderReady ? groupRows(orderedGroups, activeTabId) : [];
  }, [active, activeTabId, isMobileView, orderedGroups, tableRenderReady]);
  const rows = useMemo(() => {
    const rowsWithRealtime = baseRows.map((row) => {
      const realtime = realtimeNodeSpeedByID.get(row.node.id);
      return {
        ...row,
        realtimeDownloadRateBps: realtime?.downloadRateBps ?? 0,
        realtimeUploadRateBps: realtime?.uploadRateBps ?? 0,
      };
    });
    if (activeTabId !== ALL_GROUP_TAB_ID && sortState.key && sortState.order !== "none") {
      const sortedRows = [...rowsWithRealtime].sort((left, right) =>
        compareRowsByColumn(left, right, sortState.key as ColumnKey),
      );
      if (sortState.order === "desc") {
        sortedRows.reverse();
      }
      return sortedRows.map((row, index) => ({
        ...row,
        index: index + 1,
      }));
    }
    return rowsWithRealtime;
  }, [baseRows, activeTabId, sortState, realtimeNodeSpeedByID]);
  useEffect(() => {
    rowsByKeyRef.current = new Map(rows.map((row) => [row.key, row]));
    if (hoveredRowKeyRef.current && !rowsByKeyRef.current.has(hoveredRowKeyRef.current)) {
      hoveredRowKeyRef.current = "";
    }
  }, [rows]);
  const selectedRowKeySet = useMemo(
    () => new Set(selectedRowKeys),
    [selectedRowKeys],
  );
  const isProbePending = useCallback(
    (nodeID: string, probeType: ProbeType): boolean => {
      if (probeType !== "node_latency" && probeType !== "real_connect") {
        return false;
      }
      return hasProbeRuntimeStage(probeRuntimeTasks, nodeID, probeType);
    },
    [probeRuntimeTasks],
  );

  useEffect(() => {
    if (initializedDefaultTabRef.current) {
      return;
    }
    if (orderedGroups.length === 0) {
      return;
    }
    const preferredGroupID =
      snapshot?.activeGroupId &&
      orderedGroups.some((group) => group.id === snapshot.activeGroupId)
        ? snapshot.activeGroupId
        : orderedGroups[0].id;
    setActiveTabId(preferredGroupID);
    initializedDefaultTabRef.current = true;
  }, [orderedGroups, snapshot?.activeGroupId]);

  useEffect(() => {
    if (!isMobileView) {
      return;
    }
    setMobileExpandedGroupId((previous) => {
      if (!previous) {
        return previous;
      }
      return orderedGroups.some((group) => group.id === previous) ? previous : null;
    });
  }, [isMobileView, orderedGroups]);

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
    return listenSubscriptionsExternalFocus((detail) => {
      if (!orderedGroups.some((group) => group.id === detail.groupId)) {
        return;
      }
      initializedDefaultTabRef.current = true;
      setContextMenu(null);
      setActiveTabId(detail.groupId);
      if (isMobileView) {
        setMobileMultiSelectEnabled(false);
        setMobileExpandedGroupId(detail.groupId);
      }
      setSelectedRowKeys([detail.nodeId]);
      setPendingExternalFocus(detail);
      setLocalActiveNodeID(detail.nodeId);
    });
  }, [isMobileView, orderedGroups]);

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

  useLayoutEffect(() => {
    if (contextMenu == null) {
      return;
    }
    let cancelled = false;
    const rafID = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      const overlay = contextMenuOverlayRef.current;
      if (!overlay) {
        return;
      }
      const rect = overlay.getBoundingClientRect();
      let nextX = contextMenu.x;
      const maxRight = window.innerWidth - contextMenuViewportPadding;
      if (rect.right > maxRight) {
        nextX -= rect.right - maxRight;
      }
      if (rect.left < contextMenuViewportPadding) {
        nextX += contextMenuViewportPadding - rect.left;
      }
      nextX = Math.max(contextMenuViewportPadding, Math.round(nextX));
      if (nextX === contextMenu.x) {
        return;
      }
      setContextMenu((current) => {
        if (!current || current !== contextMenu) {
          return current;
        }
        return {
          ...current,
          x: nextX,
        };
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafID);
    };
  }, [contextMenu]);

  useEffect(() => {
    window.localStorage.setItem(
      columnVisibilityStorageKey,
      JSON.stringify(visibleColumnKeys),
    );
  }, [visibleColumnKeys]);

  const anchorRow = useMemo(() => {
    const anchorNodeId = contextMenu?.anchorNodeId;
    if (!anchorNodeId) {
      return null;
    }
    return rows.find((row) => row.key === anchorNodeId) ?? null;
  }, [rows, contextMenu?.anchorNodeId]);

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
    return orderedGroups.filter((group) => group.kind === "manual" && !usedGroupIds.has(group.id));
  }, [orderedGroups, operationRows]);

  const currentTabGroup = useMemo(
    () => orderedGroups.find((group) => group.id === activeTabId) ?? null,
    [orderedGroups, activeTabId],
  );
  const editingGroup = useMemo(
    () => orderedGroups.find((group) => group.id === editingGroupID) ?? null,
    [editingGroupID, orderedGroups],
  );
  const manualGroups = useMemo(
    () => orderedGroups.filter((group) => group.kind === "manual"),
    [orderedGroups],
  );
  const anchorGroup = useMemo(
    () => orderedGroups.find((group) => group.id === anchorRow?.groupId) ?? null,
    [anchorRow?.groupId, orderedGroups],
  );

  const canOperateRows = operationRows.length > 0;
  const canPullSubscription = currentTabGroup?.kind === "subscription";
  const canUseAnchorNode = Boolean(anchorRow);
  const canEditAnchorNode = Boolean(anchorRow && anchorGroup?.kind === "manual");
  const canAddNodeFromContext = currentTabGroup?.kind === "manual";
  const canMoveRows = operationRows.length > 0 && operationRows.every((row) => {
    const group = orderedGroups.find((item) => item.id === row.groupId);
    return group?.kind === "manual";
  });
  const canCopyRows = operationRows.length > 0;
  const canPasteToCurrentGroup = currentTabGroup?.kind === "manual";
  const selectedRowsInView = useMemo(() => {
    if (selectedRowKeys.length === 0) {
      return [] as NodeRow[];
    }
    return rows.filter((row) => selectedRowKeySet.has(row.key));
  }, [rows, selectedRowKeySet, selectedRowKeys.length]);
  const batchProbeRows = useMemo(() => {
    if (selectedRowsInView.length > 0) {
      return selectedRowsInView;
    }
    return rows;
  }, [rows, selectedRowsInView]);
  const batchOperationRows = useMemo(() => {
    if (selectedRowsInView.length > 0) {
      return selectedRowsInView;
    }
    return rows;
  }, [rows, selectedRowsInView]);
  const probeRows = useMemo(() => {
    if (selectedRowsInView.length > 0) {
      return selectedRowsInView;
    }
    if (!contextMenu?.rowContext) {
      return [] as NodeRow[];
    }
    if (anchorRow) {
      return [anchorRow];
    }
    return [] as NodeRow[];
  }, [selectedRowsInView, contextMenu, anchorRow]);
  const canProbeLatencyFromContext =
    activeTabId !== ALL_GROUP_TAB_ID &&
    snapshot?.connectionStage === "connected" &&
    probeRows.length > 0 &&
    !probeBusy;
  const canProbeRealConnectFromContext =
    activeTabId !== ALL_GROUP_TAB_ID &&
    snapshot?.connectionStage === "connected" &&
    probeRows.length > 0 &&
    !probeBusy;
  const canClearProbeFromContext =
    canOperateRows && !probeBusy && !clearingProbeData && !resettingTrafficStats;
  const canUpdateCountryFromContext =
    canOperateRows &&
    !probeBusy &&
    !updatingNodeCountries;
  const activeNodeID = snapshot?.selectedNodeId || localActiveNodeID;
  const canSortRows = activeTabId !== ALL_GROUP_TAB_ID;
  const canReorderRows = activeTabId !== ALL_GROUP_TAB_ID && sortState.order === "none";
  const currentGroupNodeOrder = useMemo(
    () => currentTabGroup?.nodes.map((node) => node.id) ?? [],
    [currentTabGroup],
  );
  const {
    draggingNodeIDs,
    sortPreview,
    clearDraggingNodeIDs,
    handleRowSortStart,
    handleRowSortCommit,
    handleRowSortPreview,
    handleRowSortLeave,
  } = useNodeRowDragSort<NodeRow>({
    canReorderRows,
    selectedRowKeys,
    rows,
    currentGroupID: currentTabGroup?.id ?? "",
    currentGroupNodeOrder,
    setDraftNodeOrder: (groupID, order) => {
      setDraftNodeOrders((previous) => ({
        ...previous,
        [groupID]: order,
      }));
    },
    notifyDragStart: (movingCount) => {
      notice.info(`上下拖拽排序(共${movingCount}行)`, {
        title: "拖拽排序",
        durationMs: 1800,
        placement: "top-center",
      });
    },
  });
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
  const hasProbeSettingsDraftChanges = probeSettingsDirty;
  const hasAnyDraftChanges = hasDraftOrderChanges || hasProbeSettingsDraftChanges;
  useDraftNavLock({
    lockClassName: "subscriptions-draft-nav-lock",
    enabled: hasAnyDraftChanges,
  });
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
  const { scopeTotalNodes, scopeAvailableNodes, scopeTotalDownloadMB, scopeTotalUploadMB } = useMemo(() => {
    let totalNodes = 0;
    let availableNodes = 0;
    let totalDownloadMB = 0;
    let totalUploadMB = 0;
    for (const group of orderedGroups) {
      if (activeTabId !== ALL_GROUP_TAB_ID && group.id !== activeTabId) {
        continue;
      }
      for (const node of group.nodes) {
        totalNodes += 1;
        if (node.latencyMs > 0) {
          availableNodes += 1;
        }
        totalDownloadMB += node.totalDownloadMb;
        totalUploadMB += node.totalUploadMb;
      }
    }
    return {
      scopeTotalNodes: totalNodes,
      scopeAvailableNodes: availableNodes,
      scopeTotalDownloadMB: totalDownloadMB,
      scopeTotalUploadMB: totalUploadMB,
    };
  }, [orderedGroups, activeTabId]);

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
    activeSelectionKeyRef.current = buildNodeSelectionKey(
      snapshot?.activeGroupId,
      snapshot?.selectedNodeId,
    );
    if (snapshot?.selectedNodeId) {
      setLocalActiveNodeID(snapshot.selectedNodeId);
    }
  }, [snapshot?.activeGroupId, snapshot?.selectedNodeId]);

  useEffect(() => {
    if (!locatedNodeID) {
      return;
    }
    if (!rows.some((row) => row.node.id === locatedNodeID)) {
      setLocatedNodeID("");
    }
  }, [rows, locatedNodeID]);

  const activateNode = useCallback(
    async (row: NodeRow): Promise<void> => {
      const targetSelectionKey = buildNodeSelectionKey(row.groupId, row.node.id);
      if (targetSelectionKey === "") {
        return;
      }
      if (activeSelectionKeyRef.current === targetSelectionKey) {
        return;
      }
      if (activatingNodeKeyRef.current === targetSelectionKey) {
        return;
      }
      activatingNodeKeyRef.current = targetSelectionKey;
      try {
        const next = await runAction(() => daemonApi.selectNode(row.node.id, row.groupId));
        const nextGroupId = next.activeGroupId || row.groupId;
        const nextNodeId = next.selectedNodeId || row.node.id;
        activeSelectionKeyRef.current = buildNodeSelectionKey(nextGroupId, nextNodeId);
        setLocalActiveNodeID(nextNodeId);
        notice.success(`已激活节点：${row.node.name}`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : "切换节点失败");
      } finally {
        if (activatingNodeKeyRef.current === targetSelectionKey) {
          activatingNodeKeyRef.current = "";
        }
      }
    },
    [runAction, notice],
  );

  const activateGroupWithoutRuntimeReload = useCallback(
    async (group: NodeGroup): Promise<void> => {
      if (group.nodes.length === 0) {
        return;
      }
      try {
        initializedDefaultTabRef.current = true;
        setContextMenu(null);
        setActiveTabId(group.id);
        setSelectedRowKeys([]);
        const next = await runAction(() =>
          daemonApi.selectActiveGroup(group.id, {
            applyRuntime: false,
            resetSelectedNode: true,
          }),
        );
        setLocalActiveNodeID(next.selectedNodeId || group.nodes[0]?.id || "");
        notice.success(`已激活分组：${group.name}`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : "激活分组失败");
      }
    },
    [notice, runAction],
  );

  const probeLatencyFromContext = async (): Promise<void> => {
    if (!snapshot || snapshot.connectionStage !== "connected" || probeRows.length === 0) {
      return;
    }
    const activeGroupId = activeTabId === ALL_GROUP_TAB_ID ? "" : activeTabId;
    const targetNodeIDs = probeRows.map((row) => row.node.id);
    const targetNodeIDSet = new Set(targetNodeIDs);
    setProbingNodes(true);
    try {
      const probeResult = await daemonApi.probeNodesWithSummary({
        groupId: activeGroupId,
        nodeIds: targetNodeIDs,
        probeType: "node_latency",
        background: probeRunsInBackground,
      });
      const next = await runAction(async () => probeResult.snapshot);
      if (probeResult.task) {
        notice.info(
          `延迟探测已加入后台任务${formatProbeExecutionHint(probeResult.summary)}，${backgroundTaskHint}`,
          { title: "后台任务" },
        );
        return;
      }
      if (Number(probeResult.summary?.requested ?? 0) <= 0) {
        return;
      }
      const nextRows = groupRows(next.groups ?? [], activeTabId);
      const scopedRows = nextRows.filter((row) => targetNodeIDSet.has(row.node.id));
      const available = scopedRows.filter((row) => row.node.latencyMs > 0).length;
      notice.success(
        `探测完成：可用 ${available}/${scopedRows.length}${formatProbeExecutionHint(probeResult.summary)}`,
      );
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "节点延迟探测失败");
    } finally {
      setProbingNodes(false);
    }
  };

  const probeRealConnectFromContext = async (): Promise<void> => {
    if (!snapshot || snapshot.connectionStage !== "connected" || probeRows.length === 0) {
      return;
    }
    const activeGroupId = activeTabId === ALL_GROUP_TAB_ID ? "" : activeTabId;
    const targetNodeIDs = probeRows.map((row) => row.node.id);
    const targetNodeIDSet = new Set(targetNodeIDs);
    setProbingNodes(true);
    try {
      const probeResult = await daemonApi.probeNodesWithSummary({
        groupId: activeGroupId,
        nodeIds: targetNodeIDs,
        probeType: "real_connect",
        background: probeRunsInBackground,
      });
      const next = await runAction(async () => probeResult.snapshot);
      if (probeResult.task) {
        notice.info(
          `节点评分已加入后台任务${formatProbeExecutionHint(probeResult.summary)}，${backgroundTaskHint}`,
          { title: "后台任务" },
        );
        return;
      }
      if (Number(probeResult.summary?.requested ?? 0) <= 0) {
        return;
      }
      const nextRows = groupRows(next.groups ?? [], activeTabId);
      const scopedRows = nextRows.filter((row) => targetNodeIDSet.has(row.node.id));
      const available = scopedRows.filter((row) => (row.node.probeRealConnectMs ?? -1) > 0).length;
      const skippedByLatency = Math.max(
        0,
        Number(probeResult.summary?.skippedRealConnectDueToLatency ?? 0),
      );
      const reprobedLatency = Math.max(
        0,
        Number(probeResult.summary?.reprobedLatencyBeforeRealConnect ?? 0),
      );
      const skippedText = skippedByLatency > 0 ? `，延迟不可用跳过 ${skippedByLatency}` : "";
      const reprobedText = reprobedLatency > 0 ? `，真连前延迟重测 ${reprobedLatency}` : "";
      notice.success(
        `真连接探测完成：可用 ${available}/${scopedRows.length}${formatProbeExecutionHint(probeResult.summary)}${skippedText}${reprobedText}`,
      );
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "真连接探测失败");
    } finally {
      setProbingNodes(false);
    }
  };

  const clearProbeDataFromContext = async (): Promise<void> => {
    if (operationRows.length === 0 || clearingProbeData || probeBusy || resettingTrafficStats) {
      return;
    }
    const nodeIDs = Array.from(new Set(operationRows.map((row) => row.node.id)));
    setClearingProbeData(true);
    try {
      await runAction(() =>
        daemonApi.clearProbeData({
          groupId: activeTabId === ALL_GROUP_TAB_ID ? undefined : activeTabId,
          nodeIds: nodeIDs,
          probeTypes: ["node_latency", "real_connect"],
        }),
      );
      notice.success(`已重置 ${nodeIDs.length} 个节点的延迟/真连/评分数据`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "重置评分失败");
    } finally {
      setClearingProbeData(false);
    }
  };

  const copyCurrentSubscriptionURL = async (): Promise<void> => {
    if (!currentSubscriptionURL) {
      return;
    }
    try {
      await navigator.clipboard.writeText(currentSubscriptionURL);
      notice.success("订阅链接已复制");
    } catch {
      notice.warning("复制失败，请检查系统剪贴板权限");
    }
  };

  const locateNodeInTable = useCallback(
    (targetNodeID: string): boolean => {
      const normalizedNodeID = targetNodeID.trim();
      if (normalizedNodeID === "") {
        return false;
      }
      const tableBody = nodeTableContextRef.current?.querySelector(".ant-table-body") as
        | HTMLElement
        | null;
      if (!tableBody) {
        notice.warning("节点表格尚未准备完成。");
        return false;
      }
      const targetRow = tableBody.querySelector(`tr[data-row-key="${normalizedNodeID}"]`) as
        | HTMLElement
        | null;
      if (!targetRow) {
        return false;
      }
      const centeredTop = targetRow.offsetTop - tableBody.clientHeight / 2 + targetRow.clientHeight / 2;
      tableBody.scrollTo({
        top: Math.max(0, centeredTop),
        behavior: "smooth",
      });
      setLocatedNodeID(normalizedNodeID === activeNodeID.trim() ? "" : normalizedNodeID);
      targetRow.classList.add("subscriptions-locate-row-flash");
      window.setTimeout(() => {
        targetRow.classList.remove("subscriptions-locate-row-flash");
      }, 900);
      return true;
    },
    [activeNodeID, notice],
  );

  const locateByStrategy = useCallback(
    (strategy: "active" | "score" | "latency" | "real_connect") => {
      if (rows.length === 0) {
        notice.warning("当前视图没有可定位节点。");
        return;
      }
      if (strategy === "active") {
        const targetNodeID = activeNodeID.trim();
        if (!targetNodeID) {
          notice.warning("当前没有激活节点。");
          return;
        }
        if (!locateNodeInTable(targetNodeID)) {
          notice.warning("当前视图中未找到激活节点。");
        }
        return;
      }
      if (strategy === "score") {
        const scoredRows = rows.filter(
          (row) =>
            typeof row.node.probeScore === "number" &&
            Number.isFinite(row.node.probeScore) &&
            (row.node.probeScore ?? 0) > 0,
        );
        if (scoredRows.length === 0) {
          notice.warning("当前视图没有可用评分数据。");
          return;
        }
        scoredRows.sort((left, right) => {
          const scoreDiff = (right.node.probeScore ?? 0) - (left.node.probeScore ?? 0);
          if (Math.abs(scoreDiff) > 0.0001) {
            return scoreDiff;
          }
          const realDiff = (left.node.probeRealConnectMs ?? Number.MAX_SAFE_INTEGER) -
            (right.node.probeRealConnectMs ?? Number.MAX_SAFE_INTEGER);
          if (realDiff !== 0) {
            return realDiff;
          }
          return (left.node.latencyMs ?? Number.MAX_SAFE_INTEGER) -
            (right.node.latencyMs ?? Number.MAX_SAFE_INTEGER);
        });
        if (!locateNodeInTable(scoredRows[0]?.node.id ?? "")) {
          notice.warning("定位评分最高节点失败。");
        }
        return;
      }
      if (strategy === "latency") {
        const latencyRows = rows
          .filter((row) => (row.node.latencyMs ?? -1) > 0)
          .sort((left, right) => (left.node.latencyMs ?? 0) - (right.node.latencyMs ?? 0));
        if (latencyRows.length === 0) {
          notice.warning("当前视图没有可用延迟数据。");
          return;
        }
        if (!locateNodeInTable(latencyRows[0]?.node.id ?? "")) {
          notice.warning("定位最低延迟节点失败。");
        }
        return;
      }
      const realConnectRows = rows
        .filter((row) => (row.node.probeRealConnectMs ?? -1) > 0)
        .sort(
          (left, right) =>
            (left.node.probeRealConnectMs ?? Number.MAX_SAFE_INTEGER) -
            (right.node.probeRealConnectMs ?? Number.MAX_SAFE_INTEGER),
        );
      if (realConnectRows.length === 0) {
        notice.warning("当前视图没有可用真连数据。");
        return;
      }
      if (!locateNodeInTable(realConnectRows[0]?.node.id ?? "")) {
        notice.warning("定位真连最快节点失败。");
      }
    },
    [rows, activeNodeID, locateNodeInTable, notice],
  );

  useEffect(() => {
    if (isMobileView) {
      return;
    }
    if (!pendingExternalFocus || !tableRenderReady) {
      return;
    }
    if (activeTabId !== pendingExternalFocus.groupId) {
      return;
    }
    const targetExists = rows.some(
      (row) =>
        row.groupId === pendingExternalFocus.groupId
        && row.node.id === pendingExternalFocus.nodeId,
    );
    if (!targetExists) {
      if (!orderedGroups.some((group) => group.id === pendingExternalFocus.groupId)) {
        setPendingExternalFocus(null);
      }
      return;
    }
    const timerId = window.setTimeout(() => {
      if (locateNodeInTable(pendingExternalFocus.nodeId)) {
        setPendingExternalFocus((current) => {
          if (
            current
            && current.groupId === pendingExternalFocus.groupId
            && current.nodeId === pendingExternalFocus.nodeId
          ) {
            return null;
          }
          return current;
        });
      }
    }, 60);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    activeTabId,
    isMobileView,
    locateNodeInTable,
    orderedGroups,
    pendingExternalFocus,
    rows,
    tableRenderReady,
  ]);

  const locateMenuItems = useMemo<NonNullable<MenuProps["items"]>>(
    () => [
      { key: "active", label: "激活节点" },
      { key: "score", label: "评分高" },
      { key: "latency", label: "延迟最低" },
      { key: "real_connect", label: "真连最快" },
    ],
    [],
  );

  const onLocateMenuClick: MenuProps["onClick"] = useCallback(
    ({ key }: { key: string }) => {
      if (key === "active") {
        locateByStrategy("active");
        return;
      }
      if (key === "score") {
        locateByStrategy("score");
        return;
      }
      if (key === "latency") {
        locateByStrategy("latency");
        return;
      }
      if (key === "real_connect") {
        locateByStrategy("real_connect");
      }
    },
    [locateByStrategy],
  );

  const canLocateByMenu = rows.length > 0;

  const probeCurrentGroupByTypes = useCallback(
    async (probeTypes: ProbeType[], actionName: string): Promise<void> => {
      if (!snapshot || activeTabId === ALL_GROUP_TAB_ID || !currentTabGroup) {
        return;
      }
      const targetNodeIDs = Array.from(new Set(batchProbeRows.map((row) => row.node.id)));
      if (targetNodeIDs.length === 0) {
        notice.warning("当前表格没有可探测节点。");
        return;
      }
      const scoreOnlyAction =
        probeTypes.length === 1 && probeTypes[0] === "real_connect";
      const targetNodeIDSet = new Set(targetNodeIDs);
      setProbingNodes(true);
      try {
        const probeResult = await daemonApi.probeNodesWithSummary({
          groupId: currentTabGroup.id,
          nodeIds: targetNodeIDs,
          probeTypes,
          background: probeRunsInBackground,
        });
        const next = await runAction(async () => probeResult.snapshot);
        if (probeResult.task) {
          notice.info(
            `${actionName}已加入后台任务${formatProbeExecutionHint(probeResult.summary)}，${backgroundTaskHint}`,
            { title: "后台任务" },
          );
          return;
        }
        if (Number(probeResult.summary?.requested ?? 0) <= 0) {
          return;
        }
        const nextRows = groupRows(next.groups ?? [], currentTabGroup.id);
        const scopedRows = nextRows.filter((row) => targetNodeIDSet.has(row.node.id));
        const summaries: string[] = [];
        if (probeTypes.includes("node_latency")) {
          const available = scopedRows.filter((row) => row.node.latencyMs > 0).length;
          summaries.push(`延迟可用 ${available}/${scopedRows.length}`);
        }
        if (probeTypes.includes("real_connect")) {
          const available = scopedRows.filter((row) => (row.node.probeRealConnectMs ?? -1) > 0).length;
          summaries.push(
            `${scoreOnlyAction ? "评分可用" : "真连可用"} ${available}/${scopedRows.length}`,
          );
          const skippedByLatency = Math.max(
            0,
            Number(probeResult.summary?.skippedRealConnectDueToLatency ?? 0),
          );
          if (skippedByLatency > 0) {
            summaries.push(`延迟不可用跳过 ${skippedByLatency}`);
          }
          const reprobedLatency = Math.max(
            0,
            Number(probeResult.summary?.reprobedLatencyBeforeRealConnect ?? 0),
          );
          if (reprobedLatency > 0) {
            summaries.push(`真连前延迟重测 ${reprobedLatency}`);
          }
        }
        const executionHint = formatProbeExecutionHint(probeResult.summary);
        const summaryText = summaries.length > 0 ? summaries.join("，") : `节点数 ${scopedRows.length}`;
        notice.success(`${actionName}完成：${summaryText}${executionHint}`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : `${actionName}失败`);
      } finally {
        setProbingNodes(false);
      }
    },
    [snapshot, activeTabId, currentTabGroup, batchProbeRows, runAction, notice],
  );

  const probeCurrentGroupLatency = useCallback(() => {
    void probeCurrentGroupByTypes(["node_latency"], "延迟探测");
  }, [probeCurrentGroupByTypes]);

  const probeCurrentGroupRealConnect = useCallback(() => {
    void probeCurrentGroupByTypes(["real_connect"], "节点评分");
  }, [probeCurrentGroupByTypes]);

  const clearCurrentGroupProbeData = useCallback(async (): Promise<void> => {
    if (
      activeTabId === ALL_GROUP_TAB_ID ||
      !currentTabGroup ||
      batchOperationRows.length === 0 ||
      probeBusy ||
      clearingProbeData ||
      resettingTrafficStats
    ) {
      return;
    }
    const targetNodeIDs = Array.from(new Set(batchOperationRows.map((row) => row.node.id)));
    setClearingProbeData(true);
    try {
      await runAction(() =>
        daemonApi.clearProbeData({
          groupId: currentTabGroup.id,
          nodeIds: targetNodeIDs,
          probeTypes: ["node_latency", "real_connect"],
        }),
      );
      notice.success(`已重置 ${targetNodeIDs.length} 个节点的延迟/真连/评分数据`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "重置评分失败");
    } finally {
      setClearingProbeData(false);
    }
  }, [
    activeTabId,
    currentTabGroup,
    batchOperationRows,
    probeBusy,
    clearingProbeData,
    resettingTrafficStats,
    runAction,
    notice,
  ]);

  const resetCurrentGroupTrafficStats = useCallback(async (): Promise<void> => {
    if (
      activeTabId === ALL_GROUP_TAB_ID ||
      !currentTabGroup ||
      batchOperationRows.length === 0 ||
      probeBusy ||
      clearingProbeData ||
      resettingTrafficStats
    ) {
      return;
    }
    const targetNodeIDs = Array.from(new Set(batchOperationRows.map((row) => row.node.id)));
    setResettingTrafficStats(true);
    try {
      await runAction(() =>
        daemonApi.resetTrafficStats({
          groupId: currentTabGroup.id,
          nodeIds: targetNodeIDs,
        }),
      );
      notice.success(`已重置 ${targetNodeIDs.length} 个节点的流量统计`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "重置流量统计失败");
    } finally {
      setResettingTrafficStats(false);
    }
  }, [
    activeTabId,
    currentTabGroup,
    batchOperationRows,
    probeBusy,
    clearingProbeData,
    resettingTrafficStats,
    runAction,
    notice,
  ]);

  const updateNodeCountriesFromContext = useCallback(async (): Promise<void> => {
    if (operationRows.length === 0 || probeBusy || updatingNodeCountries) {
      return;
    }
    const targetNodeIDs = Array.from(new Set(operationRows.map((row) => row.node.id)));
    const previousCountryByID = new Map(
      operationRows.map((row) => [row.node.id, (row.node.country ?? "").trim().toUpperCase()]),
    );
    setUpdatingNodeCountries(true);
    try {
      const updateResult = await daemonApi.updateNodeCountries({
        nodeIds: targetNodeIDs,
      });
      const nextSnapshot = await runAction(() =>
        Promise.resolve(updateResult.snapshot),
      );
      if (updateResult.task?.status === "queued" || updateResult.task?.status === "running") {
        return;
      }
      const nextCountryByID = new Map<string, string>();
      for (const group of nextSnapshot.groups ?? []) {
        for (const node of group.nodes) {
          nextCountryByID.set(node.id, (node.country ?? "").trim().toUpperCase());
        }
      }
      let resolvedCount = 0;
      let changedCount = 0;
      for (const nodeID of targetNodeIDs) {
        const nextCountry = nextCountryByID.get(nodeID) ?? "";
        if (nextCountry !== "") {
          resolvedCount++
        }
        if (nextCountry !== (previousCountryByID.get(nodeID) ?? "")) {
          changedCount++
        }
      }
      notice.success(`更新国家完成：已识别 ${resolvedCount}/${targetNodeIDs.length}，变更 ${changedCount}`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "更新国家失败");
    } finally {
      setUpdatingNodeCountries(false);
    }
  }, [operationRows, probeBusy, runAction, updatingNodeCountries, notice]);

  const copySubscriptionUrlForGroup = useCallback(
    async (group: NodeGroup): Promise<void> => {
      if (group.kind !== "subscription" || !group.subscriptionId) {
        return;
      }
      const source = subscriptions.find((item) => item.id === group.subscriptionId) ?? null;
      const url = (source?.url ?? "").trim();
      if (!url) {
        notice.warning("当前分组没有可复制的订阅地址。");
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        notice.success("订阅链接已复制");
      } catch {
        notice.warning("复制失败，请检查系统剪贴板权限");
      }
    },
    [notice, subscriptions],
  );

  const probeGroupByTypes = useCallback(
    async (
      group: NodeGroup,
      probeTypes: ProbeType[],
      actionName: string,
      targetRows?: NodeRow[],
    ): Promise<void> => {
      if (!snapshot || snapshot.connectionStage !== "connected") {
        notice.warning("请先启动代理，再执行探测。");
        return;
      }
      const scopedRows = targetRows && targetRows.length > 0 ? targetRows : groupRows([group], group.id);
      const targetNodeIDs = Array.from(new Set(scopedRows.map((row) => row.node.id)));
      if (targetNodeIDs.length === 0) {
        notice.warning("当前分组没有可探测节点。");
        return;
      }
      const scoreOnlyAction =
        probeTypes.length === 1 && probeTypes[0] === "real_connect";
      const targetNodeIDSet = new Set(targetNodeIDs);
      initializedDefaultTabRef.current = true;
      setActiveTabId(group.id);
      setProbingNodes(true);
      try {
        const probeResult = await daemonApi.probeNodesWithSummary({
          groupId: group.id,
          nodeIds: targetNodeIDs,
          probeTypes,
          background: probeRunsInBackground,
        });
        const next = await runAction(async () => probeResult.snapshot);
        if (probeResult.task) {
          notice.info(`${actionName}已加入后台任务${formatProbeExecutionHint(probeResult.summary)}，${backgroundTaskHint}`, {
            title: "后台任务",
          });
          return;
        }
        if (Number(probeResult.summary?.requested ?? 0) <= 0) {
          return;
        }
        const nextRows = groupRows(next.groups ?? [], group.id);
        const scopedRows = nextRows.filter((row) => targetNodeIDSet.has(row.node.id));
        const summaries: string[] = [];
        if (probeTypes.includes("node_latency")) {
          const available = scopedRows.filter((row) => row.node.latencyMs > 0).length;
          summaries.push(`延迟可用 ${available}/${scopedRows.length}`);
        }
        if (probeTypes.includes("real_connect")) {
          const available = scopedRows.filter((row) => (row.node.probeRealConnectMs ?? -1) > 0).length;
          summaries.push(
            `${scoreOnlyAction ? "评分可用" : "真连可用"} ${available}/${scopedRows.length}`,
          );
          const skippedByLatency = Math.max(
            0,
            Number(probeResult.summary?.skippedRealConnectDueToLatency ?? 0),
          );
          if (skippedByLatency > 0) {
            summaries.push(`延迟不可用跳过 ${skippedByLatency}`);
          }
          const reprobedLatency = Math.max(
            0,
            Number(probeResult.summary?.reprobedLatencyBeforeRealConnect ?? 0),
          );
          if (reprobedLatency > 0) {
            summaries.push(`真连前延迟重测 ${reprobedLatency}`);
          }
        }
        const executionHint = formatProbeExecutionHint(probeResult.summary);
        const summaryText = summaries.length > 0 ? summaries.join("，") : `节点数 ${scopedRows.length}`;
        notice.success(`${actionName}完成：${summaryText}${executionHint}`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : `${actionName}失败`);
      } finally {
        setProbingNodes(false);
      }
    },
    [backgroundTaskHint, notice, probeRunsInBackground, runAction, snapshot],
  );

  const clearProbeDataForGroup = useCallback(
    async (group: NodeGroup, targetRows?: NodeRow[]): Promise<void> => {
      if (probeBusy || clearingProbeData || resettingTrafficStats) {
        return;
      }
      const scopedRows = targetRows && targetRows.length > 0 ? targetRows : groupRows([group], group.id);
      const targetNodeIDs = Array.from(new Set(scopedRows.map((row) => row.node.id)));
      if (targetNodeIDs.length === 0) {
        notice.warning("当前分组没有可重置评分的节点。");
        return;
      }
      initializedDefaultTabRef.current = true;
      setActiveTabId(group.id);
      setClearingProbeData(true);
      try {
        await runAction(() =>
          daemonApi.clearProbeData({
            groupId: group.id,
            nodeIds: targetNodeIDs,
            probeTypes: ["node_latency", "real_connect"],
          }),
        );
        notice.success(`已重置 ${targetNodeIDs.length} 个节点的延迟/真连/评分数据`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : "重置评分失败");
      } finally {
        setClearingProbeData(false);
      }
    },
    [clearingProbeData, notice, probeBusy, resettingTrafficStats, runAction],
  );

  const resetTrafficStatsForGroup = useCallback(
    async (group: NodeGroup, targetRows?: NodeRow[]): Promise<void> => {
      if (probeBusy || clearingProbeData || resettingTrafficStats) {
        return;
      }
      const scopedRows = targetRows && targetRows.length > 0 ? targetRows : groupRows([group], group.id);
      const targetNodeIDs = Array.from(new Set(scopedRows.map((row) => row.node.id)));
      if (targetNodeIDs.length === 0) {
        notice.warning("当前分组没有可重置流量的节点。");
        return;
      }
      initializedDefaultTabRef.current = true;
      setActiveTabId(group.id);
      setResettingTrafficStats(true);
      try {
        await runAction(() =>
          daemonApi.resetTrafficStats({
            groupId: group.id,
            nodeIds: targetNodeIDs,
          }),
        );
        notice.success(`已重置 ${targetNodeIDs.length} 个节点的流量统计`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : "重置流量统计失败");
      } finally {
        setResettingTrafficStats(false);
      }
    },
    [clearingProbeData, notice, probeBusy, resettingTrafficStats, runAction],
  );

  const updateSingleNodeCountry = useCallback(
    async (_row: NodeRow): Promise<void> => {
      notice.warning("移动端暂未接入更新国家能力");
    },
    [notice],
  );

  const copyNodesToClipboard = useCallback(
    async (rowsToCopy?: NodeRow[]): Promise<void> => {
      const targetRows = rowsToCopy && rowsToCopy.length > 0 ? rowsToCopy : operationRows;
      if (targetRows.length === 0) {
        return;
      }
      const lines: string[] = [];
      let skippedCount = 0;
      for (const row of targetRows) {
        const line = serializeNodeToClipboardLine(row.node);
        if (line) {
          lines.push(line);
        } else {
          skippedCount += 1;
        }
      }
      if (lines.length === 0) {
        notice.warning("当前选中节点暂不支持复制为标准节点文本。");
        return;
      }
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        if (skippedCount > 0) {
          notice.warning(`已复制 ${lines.length} 条节点，另有 ${skippedCount} 条暂不支持该格式`);
          return;
        }
        notice.success(`已复制 ${lines.length} 条节点`);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : "复制节点失败");
      }
    },
    [notice, operationRows],
  );

  const pasteNodesFromClipboard = useCallback(async (): Promise<void> => {
    if (currentTabGroup?.kind !== "manual") {
      notice.warning("只有普通分组才可以粘贴节点。");
      return;
    }
    try {
      const content = (await navigator.clipboard.readText()).trim();
      if (content === "") {
        notice.warning("剪贴板没有可粘贴的节点文本。");
        return;
      }
      const previousIDs = new Set(currentTabGroup.nodes.map((node) => node.id));
      const nextSnapshot = await runAction(() =>
        daemonApi.importManualNodesText({
          groupId: currentTabGroup.id,
          content,
        }),
      );
      const nextGroup = nextSnapshot.groups.find((group) => group.id === currentTabGroup.id);
      const importedIDs = (nextGroup?.nodes ?? [])
        .map((node) => node.id)
        .filter((nodeID) => !previousIDs.has(nodeID));
      if (importedIDs.length > 0) {
        setSelectedRowKeys(importedIDs);
      }
      notice.success(`已粘贴导入 ${importedIDs.length} 条节点到普通分组：${currentTabGroup.name}`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "粘贴节点失败");
    }
  }, [currentTabGroup, notice, runAction]);

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

  const applyDraftChanges = useCallback(async (): Promise<void> => {
    if (!hasAnyDraftChanges || applyingDraftChanges) {
      return;
    }
    const normalizedProbeSettings = getNormalizedProbeSettingsDraft();
    if (isMobileView) {
      normalizedProbeSettings.autoProbeOnActiveGroup = false;
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
    setApplyingDraftChanges(true);
    try {
      if (hasDraftOrderChanges) {
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
        draggingGroupIDRef.current = "";
        clearDraggingNodeIDs();
        setSortState({
          key: "",
          order: "none",
        });
      }
      if (hasProbeSettingsDraftChanges) {
        const next = await runAction(() =>
          daemonApi.setSettings({
            probeSettings: normalizedProbeSettings,
          }),
        );
        applyProbeSettingsFromSnapshot(next.probeSettings);
        draftNotice.notifySaveSuccess("订阅草稿", next);
      } else {
        draftNotice.notifySaveSuccess("订阅草稿");
      }
    } catch (error) {
      draftNotice.notifySaveFailed("订阅草稿", error);
    } finally {
      setApplyingDraftChanges(false);
    }
  }, [
    hasAnyDraftChanges,
    applyingDraftChanges,
    getNormalizedProbeSettingsDraft,
    isMobileView,
    applyProbeSettingsFromSnapshot,
    hasDraftOrderChanges,
    hasProbeSettingsDraftChanges,
    draftNodeOrders,
    sortDraftDirty,
    currentTabGroup,
    sortState.key,
    sortState.order,
    orderedGroups,
    groups,
    isGroupOrderDirty,
    effectiveGroupOrder,
    clearDraggingNodeIDs,
    runAction,
    draftNotice,
  ]);

  const discardDraftChanges = useCallback((): void => {
    const hadOrderDraftChanges = hasDraftOrderChanges;
    const hadProbeDraftChanges = hasProbeSettingsDraftChanges;
    setDraftGroupOrder(null);
    setDraftNodeOrders({});
    draggingGroupIDRef.current = "";
    clearDraggingNodeIDs();
    setSortState({
      key: "",
      order: "none",
    });
    if (hadProbeDraftChanges) {
      discardProbeSettingsDraft();
    }
    if (hadOrderDraftChanges || hadProbeDraftChanges) {
      draftNotice.notifyDraftReverted("订阅");
    }
  }, [
    hasDraftOrderChanges,
    hasProbeSettingsDraftChanges,
    discardProbeSettingsDraft,
    clearDraggingNodeIDs,
    draftNotice,
  ]);

  useEffect(() => {
    hasDraftChangesRef.current = hasAnyDraftChanges;
  }, [hasAnyDraftChanges]);

  useEffect(() => {
    return () => {
      if (hasDraftChangesRef.current) {
        notice.warning("你已切换页面，当前草稿尚未应用或取消。");
      }
    };
  }, [notice]);

  const handleGroupDragStart = (groupID: string) => (event: React.DragEvent<HTMLElement>) => {
    draggingGroupIDRef.current = groupID;
    event.dataTransfer.effectAllowed = "move";
  };

  const handleGroupDragOver = (groupID: string) => (event: React.DragEvent<HTMLElement>) => {
    const currentDraggingGroupID = draggingGroupIDRef.current;
    if (currentDraggingGroupID === "" || currentDraggingGroupID === groupID) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleGroupDrop = (groupID: string) => (event: React.DragEvent<HTMLElement>) => {
    const currentDraggingGroupID = draggingGroupIDRef.current;
    if (currentDraggingGroupID === "" || currentDraggingGroupID === groupID) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placeAfter = event.clientX >= rect.left + rect.width / 2;
    const nextOrder = reorderListByMove(
      effectiveGroupOrder,
      [currentDraggingGroupID],
      groupID,
      placeAfter,
    );
    if (!sameStringArray(nextOrder, effectiveGroupOrder)) {
      setDraftGroupOrder(nextOrder);
    }
    draggingGroupIDRef.current = "";
  };

  const menuItems = useMemo<MenuProps["items"]>(
    () =>
      buildSubscriptionsContextMenuItems({
        canPullSubscription,
        canUseAnchorNode,
        canEditAnchorNode,
        canAddNode: Boolean(canAddNodeFromContext),
        canMoveRows,
        canCopyRows,
        canUpdateCountry: canUpdateCountryFromContext,
        canPasteToCurrentGroup: Boolean(canPasteToCurrentGroup),
        activeTabId,
        allGroupTabId: ALL_GROUP_TAB_ID,
        probingNodes: probeBusy,
        canProbeLatencyFromContext,
        canProbeRealConnectFromContext,
        canClearProbeFromContext,
        currentTabGroup,
        canOperateRows,
        targetGroups,
        commonProtocols: supportedNodeProtocols,
        protocolLabel: formatNodeProtocolLabel,
      }),
    [
      canPullSubscription,
      canUseAnchorNode,
      canEditAnchorNode,
      canAddNodeFromContext,
      canMoveRows,
      canCopyRows,
      canUpdateCountryFromContext,
      canPasteToCurrentGroup,
      activeTabId,
      probeBusy,
      canProbeLatencyFromContext,
      canProbeRealConnectFromContext,
      canClearProbeFromContext,
      currentTabGroup,
      canOperateRows,
      targetGroups,
    ],
  );

  const availableColumnOptions = useMemo(
    () => resolveAvailableColumnOptions(activeTabId, ALL_GROUP_TAB_ID),
    [activeTabId],
  );

  const columnMenuItems = useMemo<NonNullable<MenuProps["items"]>>(
    () => buildColumnMenuItems(availableColumnOptions),
    [availableColumnOptions],
  );

  const selectedColumnMenuKeys = useMemo(
    () => buildSelectedColumnMenuKeys(availableColumnOptions, visibleColumnKeys),
    [availableColumnOptions, visibleColumnKeys],
  );

  const setColumnVisible = useCallback((columnKey: ColumnKey, visible: boolean) => {
    setVisibleColumnKeys((prev) => {
      return resolveVisibleColumns(prev, columnKey, visible);
    });
  }, []);

  const columns = useMemo(
    () =>
      buildSubscriptionsColumns({
        activeTabId,
        allGroupTabId: ALL_GROUP_TAB_ID,
        visibleColumnKeys,
        canSortRows,
        sortState,
        activeNodeID,
        trafficMonitoringEnabled,
        isProbePending,
        toggleColumnSort,
        protocolLabel: formatNodeProtocolLabel,
      }),
    [
      activeTabId,
      visibleColumnKeys,
      canSortRows,
      sortState,
      activeNodeID,
      trafficMonitoringEnabled,
      isProbePending,
      toggleColumnSort,
    ],
  );

  const handleContextMenu: React.MouseEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const row = target.closest("[data-row-key]") as HTMLElement | null;
    const anchorNodeId = row?.getAttribute("data-row-key") ?? null;
    const estimatedMenuHeight = resolveContextMenuVisibleHeight(
      window.innerHeight,
      event.clientY,
      menuItems ?? [],
    );
    setContextMenu({
      x: event.clientX,
      y: resolveContextMenuY(window.innerHeight, event.clientY, estimatedMenuHeight),
      rowContext: anchorNodeId != null,
      anchorNodeId,
    });
  };

  const openNodeEditor = useCallback(
    (
      state:
        | { mode: "add"; protocol: NodeProtocol; groupId: string }
        | { mode: "edit"; row: NodeRow },
    ) => {
      if (state.mode === "edit") {
        setNodeEditorState({
          mode: "edit",
          protocol: state.row.node.protocol,
          groupId: state.row.groupId,
          row: state.row,
        });
        return;
      }
      setNodeEditorState({
        mode: "add",
        protocol: state.protocol,
        groupId: state.groupId,
      });
    },
    [],
  );

  const openManualRowEditor = useCallback(
    (row: NodeRow | null) => {
      if (!row) {
        return;
      }
      const group = orderedGroups.find((item) => item.id === row.groupId);
      if (!group || group.kind !== "manual") {
        return;
      }
      openNodeEditor({
        mode: "edit",
        row,
      });
    },
    [openNodeEditor, orderedGroups],
  );

  const {
    handlePullSubscriptionFromMenu,
    handleUseNodeFromMenu,
    handleEditNodeFromMenu,
    handleProbeLatencyFromMenu,
    handleProbeRealConnectFromMenu,
    handleClearProbeDataFromMenu,
    handleUpdateCountryFromMenu,
    handleSelectAllFromMenu,
    handleInverseSelectFromMenu,
    handleAddNodeFromMenu,
    handleMoveOrCopyFromMenu,
    handleDeleteRowsFromMenu,
    deleteRowsWithConfirm,
    pullSubscriptionForGroup,
    isPullSubscriptionPending,
  } = useSubscriptionsRowActions({
    snapshot,
    activeTabId,
    allGroupTabId: ALL_GROUP_TAB_ID,
    currentTabGroup,
    orderedGroups,
    rows,
    operationRows,
    anchorRow,
    runAction,
    notice,
    openNodeEditor,
    setSelectedRowKeys,
    activateNode,
    probeLatencyFromContext,
    probeRealConnectFromContext,
    clearProbeDataFromContext,
    updateNodeCountriesFromContext,
  });
  const currentTabPullSubscriptionPending = Boolean(
    currentTabGroup && isPullSubscriptionPending(currentTabGroup.id),
  );

  const {
    openAddSubscriptionModal,
    closeAddSubscriptionModal,
    submitAddSubscription,
    confirmRemoveGroup,
    openEditGroupModal,
    closeEditGroupModal,
    submitEditGroup,
  } = useSubscriptionsGroupActions({
    activeTabId,
    allGroupTabId: ALL_GROUP_TAB_ID,
    subscriptions,
    editingGroupID,
    runAction,
    setSelectedRowKeys,
    setActiveTabId,
    setAddSubOpen,
    setEditGroupOpen,
    setEditingGroupID,
    subscriptionForm,
    editGroupForm,
    notice,
  });

  useEffect(() => {
    if (!isMobileView) {
      return;
    }
    return listenSubscriptionsUiAction((detail) => {
      if (detail.action !== "open_add_group") {
        return;
      }
      openAddSubscriptionModal();
    });
  }, [isMobileView, openAddSubscriptionModal]);

  const handleMenuClick: MenuProps["onClick"] = ({ key }) => {
    setContextMenu(null);
    if (!snapshot) {
      return;
    }
    dispatchSubscriptionsContextMenuAction(String(key), {
      onPullSubscription: handlePullSubscriptionFromMenu,
      onUseNode: handleUseNodeFromMenu,
      onEditNode: handleEditNodeFromMenu,
      onProbeLatency: handleProbeLatencyFromMenu,
      onProbeRealConnect: handleProbeRealConnectFromMenu,
      onClearProbeData: handleClearProbeDataFromMenu,
      onUpdateCountry: handleUpdateCountryFromMenu,
      onCopyText: () => {
        void copyNodesToClipboard();
      },
      onPasteText: () => {
        void pasteNodesFromClipboard();
      },
      onSelectAll: handleSelectAllFromMenu,
      onInverseSelect: handleInverseSelectFromMenu,
      onAddNode: handleAddNodeFromMenu,
      onMoveOrCopy: handleMoveOrCopyFromMenu,
      onDelete: handleDeleteRowsFromMenu,
    });
  };

  const canCopySubscriptionUrl =
    currentTabGroup?.kind === "subscription" && currentSubscriptionURL.trim() !== "";
  const canAddNodeFromHeader = currentTabGroup?.kind === "manual";
  const scopeDetailLines = useMemo(() => {
    const lines = [
      `总节点：${scopeTotalNodes}`,
      `可用：${scopeAvailableNodes}`,
      `总下载：${formatTrafficMB(scopeTotalDownloadMB)}`,
      `总上传：${formatTrafficMB(scopeTotalUploadMB)}`,
    ];
    if (activeTabId === ALL_GROUP_TAB_ID) {
      lines.push("视图：聚合视图");
      return lines;
    }
    if (currentTabGroup?.kind !== "subscription") {
      return lines;
    }
    const traffic = currentSubscriptionStatusView.traffic.trim();
    const date = currentSubscriptionStatusView.date.trim();
    if (traffic !== "") {
      lines.push(`订阅流量：${traffic}`);
    }
    if (date !== "") {
      lines.push(`到期日期：${date}`);
    }
    if (traffic === "" && date === "") {
      const fallback = currentSubscriptionStatusView.fallback.trim();
      if (fallback !== "" && fallback !== "-") {
        lines.push(`状态：${shortenMiddle(fallback, 96)}`);
      }
    }
    return lines;
  }, [
    scopeTotalNodes,
    scopeAvailableNodes,
    scopeTotalDownloadMB,
    scopeTotalUploadMB,
    activeTabId,
    currentTabGroup?.kind,
    currentSubscriptionStatusView,
  ]);
  const probeActionDisabledReason = useMemo(() => {
    if (activeTabId === ALL_GROUP_TAB_ID) {
      return "“全部”TAB 不支持批量探测，请切换到具体分组。";
    }
    if (!currentTabGroup) {
      return "当前没有可用分组。";
    }
    if (probeBusy || clearingProbeData || resettingTrafficStats) {
      return "操作执行中，请稍候。";
    }
    if (rows.length === 0) {
      return "当前表格没有可探测节点。";
    }
    return "";
  }, [activeTabId, currentTabGroup, probeBusy, clearingProbeData, resettingTrafficStats, rows.length]);
  const canBatchProbeByGroup = probeActionDisabledReason === "";
  const clearProbeDisabledReason = useMemo(() => {
    if (activeTabId === ALL_GROUP_TAB_ID) {
      return "“全部”TAB 不支持分组清理，请切换到具体分组。";
    }
    if (!currentTabGroup) {
      return "当前没有可用分组。";
    }
    if (probeBusy || clearingProbeData || resettingTrafficStats) {
      return "操作执行中，请稍候。";
    }
    if (rows.length === 0) {
      return "当前表格没有可清理节点。";
    }
    return "";
  }, [activeTabId, currentTabGroup, probeBusy, clearingProbeData, resettingTrafficStats, rows.length]);
  const canClearProbeByGroup = clearProbeDisabledReason === "";
  const canResetTrafficByGroup = clearProbeDisabledReason === "";
  const rowSelection: TableRowSelection<NodeRow> = useMemo(() => {
    return {
      selectedRowKeys,
      columnWidth: tableSelectionColumnWidth,
      renderCell: (_checked: boolean, row: NodeRow, _index: number, originNode: ReactNode) => (
        <span className="subscriptions-selection-cell">
          {originNode}
          <span
            className={`subscriptions-drag-handle${canReorderRows ? "" : " is-disabled"}`}
            title={canReorderRows ? "拖拽排序" : "仅默认排序可拖拽"}
            onMouseDown={handleRowSortStart(row)}
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
        </span>
      ),
      onChange: (keys) => {
        setSelectedRowKeys(keys.map((item) => String(item)));
      },
    };
  }, [selectedRowKeys, canReorderRows, handleRowSortStart]);
  const handleTableRow = useCallback(
    (row: NodeRow) => ({
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (event.ctrlKey || event.metaKey) {
          openManualRowEditor(row);
          return;
        }
        void activateNode(row);
      },
      onMouseEnter: () => {
        hoveredRowKeyRef.current = row.key;
      },
      onMouseLeave: () => {
        if (hoveredRowKeyRef.current === row.key) {
          hoveredRowKeyRef.current = "";
        }
        handleRowSortLeave(row)();
      },
      onMouseMove: handleRowSortPreview(row),
      onMouseUp: handleRowSortCommit(row),
    }),
    [activateNode, handleRowSortCommit, handleRowSortLeave, handleRowSortPreview, openManualRowEditor],
  );

  const handleSubmitNodeEditor = useCallback(
    async (
      payload:
        | Parameters<typeof daemonApi.addManualNode>[0]
        | Parameters<typeof daemonApi.updateManualNode>[0],
    ) => {
      setSubmittingNodeEditor(true);
      try {
        await runAction(async () => {
          if (isUpdateManualNodePayload(payload)) {
            return daemonApi.updateManualNode(payload);
          }
          return daemonApi.addManualNode(payload);
        });
        setNodeEditorState(null);
      } catch (error) {
        notice.error(error instanceof Error ? error.message : "保存节点失败");
      } finally {
        setSubmittingNodeEditor(false);
      }
    },
    [notice, runAction],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
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
      const hoveredRowKey = hoveredRowKeyRef.current;
      const hoveredRow = hoveredRowKey ? rowsByKeyRef.current.get(hoveredRowKey) ?? null : null;
      const selectedRowsForShortcut =
        selectedRowKeys.length > 0
          ? selectedRowKeys
              .map((key) => rowsByKeyRef.current.get(key))
              .filter((row): row is NodeRow => Boolean(row))
          : [];

      if (event.key === "Enter") {
        if (!hoveredRow) {
          return;
        }
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          openManualRowEditor(hoveredRow);
          return;
        }
        void activateNode(hoveredRow);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        const rowsToDelete =
          selectedRowsForShortcut.length > 0 ? selectedRowsForShortcut : hoveredRow ? [hoveredRow] : [];
        if (rowsToDelete.length === 0) {
          return;
        }
        event.preventDefault();
        deleteRowsWithConfirm(rowsToDelete);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        const rowsToCopy =
          selectedRowsForShortcut.length > 0 ? selectedRowsForShortcut : hoveredRow ? [hoveredRow] : [];
        if (rowsToCopy.length === 0) {
          return;
        }
        event.preventDefault();
        void copyNodesToClipboard(rowsToCopy);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteNodesFromClipboard();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activateNode, copyNodesToClipboard, deleteRowsWithConfirm, openManualRowEditor, pasteNodesFromClipboard, selectedRowKeys]);

  const subscriptionById = useMemo(
    () => new Map(subscriptions.map((item) => [item.id, item])),
    [subscriptions],
  );
  const mobileExpandedGroupRows = useMemo(() => {
    if (!isMobileView || !active || !mobileExpandedGroupId) {
      return [] as NodeRow[];
    }
    const expandedGroup = orderedGroups.find((group) => group.id === mobileExpandedGroupId);
    if (!expandedGroup) {
      return [] as NodeRow[];
    }
    return groupRows([expandedGroup], expandedGroup.id);
  }, [active, isMobileView, mobileExpandedGroupId, orderedGroups]);
  const mobileExpandedGroup = useMemo(
    () => orderedGroups.find((group) => group.id === mobileExpandedGroupId) ?? null,
    [mobileExpandedGroupId, orderedGroups],
  );
  const mobileExpandedGroupRowKeySet = useMemo(
    () => new Set(mobileExpandedGroupRows.map((row) => row.key)),
    [mobileExpandedGroupRows],
  );
  const mobileSelectedExpandedGroupRows = useMemo(
    () => mobileExpandedGroupRows.filter((row) => selectedRowKeySet.has(row.key)),
    [mobileExpandedGroupRows, selectedRowKeySet],
  );
  const locateNodeInMobileList = useCallback(
    (targetNodeID: string): boolean => {
      const normalizedNodeID = targetNodeID.trim();
      if (!normalizedNodeID || !mobileExpandedGroup) {
        return false;
      }
      const targetIndex = mobileExpandedGroupRows.findIndex((row) => row.node.id === normalizedNodeID);
      if (targetIndex < 0) {
        return false;
      }
      const scrollContainer = mobileExpandedGroupScrollRef.current;
      if (!scrollContainer) {
        return false;
      }
      const itemStride = mobileVirtualNodeCardHeightPx + mobileVirtualNodeCardGapPx;
      const centeredTop =
        targetIndex * itemStride - scrollContainer.clientHeight / 2 + mobileVirtualNodeCardHeightPx / 2;
      scrollContainer.scrollTo({
        top: Math.max(0, centeredTop),
        behavior: "smooth",
      });
      setLocatedNodeID(normalizedNodeID === activeNodeID.trim() ? "" : normalizedNodeID);
      return true;
    },
    [activeNodeID, mobileExpandedGroup, mobileExpandedGroupRows],
  );
  useEffect(() => {
    if (!isMobileView || !pendingExternalFocus || !mobileExpandedGroup) {
      return;
    }
    if (mobileExpandedGroup.id !== pendingExternalFocus.groupId) {
      return;
    }
    const targetExists = mobileExpandedGroupRows.some((row) => row.node.id === pendingExternalFocus.nodeId);
    if (!targetExists) {
      if (!orderedGroups.some((group) => group.id === pendingExternalFocus.groupId)) {
        setPendingExternalFocus(null);
      }
      return;
    }
    const timerId = window.setTimeout(() => {
      if (locateNodeInMobileList(pendingExternalFocus.nodeId)) {
        setPendingExternalFocus((current) => {
          if (
            current &&
            current.groupId === pendingExternalFocus.groupId &&
            current.nodeId === pendingExternalFocus.nodeId
          ) {
            return null;
          }
          return current;
        });
      }
    }, 60);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    isMobileView,
    locateNodeInMobileList,
    mobileExpandedGroup,
    mobileExpandedGroupRows,
    orderedGroups,
    pendingExternalFocus,
  ]);
  const mobileExpandedGroupActionRows =
    mobileMultiSelectEnabled && mobileSelectedExpandedGroupRows.length > 0
      ? mobileSelectedExpandedGroupRows
      : mobileExpandedGroupRows;
  const mobileExpandedGroupSelectionCount = mobileSelectedExpandedGroupRows.length;
  const mobileAllExpandedGroupRowsSelected =
    mobileExpandedGroupRows.length > 0 &&
    mobileExpandedGroupSelectionCount === mobileExpandedGroupRows.length;
  const mobileActionBusy =
    probeBusy || clearingProbeData || resettingTrafficStats || updatingNodeCountries;
  const toggleMobileRowSelection = useCallback((rowKey: string) => {
    setSelectedRowKeys((previous) => {
      const scoped = previous.filter((item) => mobileExpandedGroupRowKeySet.has(item));
      return scoped.includes(rowKey)
        ? scoped.filter((item) => item !== rowKey)
        : [...scoped, rowKey];
    });
  }, [mobileExpandedGroupRowKeySet]);
  const enterMobileMultiSelectMode = useCallback((rowKey: string) => {
    setMobileMultiSelectEnabled(true);
    setSelectedRowKeys((previous) => {
      const scoped = previous.filter((item) => mobileExpandedGroupRowKeySet.has(item));
      if (scoped.includes(rowKey)) {
        return scoped;
      }
      return [...scoped, rowKey];
    });
  }, [mobileExpandedGroupRowKeySet]);
  const toggleMobileSelectAllRows = useCallback(() => {
    setMobileMultiSelectEnabled(true);
    setSelectedRowKeys((previous) => {
      const scoped = previous.filter((item) => mobileExpandedGroupRowKeySet.has(item));
      if (
        mobileExpandedGroupRows.length > 0 &&
        scoped.length === mobileExpandedGroupRows.length
      ) {
        return [];
      }
      return mobileExpandedGroupRows.map((row) => row.key);
    });
  }, [mobileExpandedGroupRowKeySet, mobileExpandedGroupRows]);
  useEffect(() => {
    if (!isMobileView) {
      return;
    }
    setSelectedRowKeys((previous) => {
      const next = previous.filter((item) => mobileExpandedGroupRowKeySet.has(item));
      return next.length === previous.length ? previous : next;
    });
  }, [isMobileView, mobileExpandedGroupRowKeySet]);
  useEffect(() => {
    if (!isMobileView) {
      return;
    }
    if (!mobileMultiSelectEnabled) {
      return;
    }
    if (mobileExpandedGroupSelectionCount > 0) {
      return;
    }
    setMobileMultiSelectEnabled(false);
  }, [isMobileView, mobileExpandedGroupSelectionCount, mobileMultiSelectEnabled]);
  const stopCollapseAction = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const collapseMobileExpandedGroup = () => {
    setMobileExpandedGroupId(null);
    setMobileMultiSelectEnabled(false);
    setSelectedRowKeys([]);
  };
  const mobileExpandedGroupCanProbe =
    snapshot?.connectionStage === "connected" &&
    mobileExpandedGroupActionRows.length > 0 &&
    !mobileActionBusy;
  const mobileExpandedGroupCanReset =
    mobileExpandedGroupActionRows.length > 0 &&
    !probeBusy &&
    !clearingProbeData &&
    !resettingTrafficStats;
  const mobileSelectAllIconName = mobileAllExpandedGroupRowsSelected
    ? "check-square-fill"
    : mobileExpandedGroupSelectionCount > 0
      ? "dash-square"
      : "square";

  const renderMobileCollapsedGroupHeaderActions = (
    group: NodeGroup,
    groupSubscriptionUrl: string,
  ) => (
    <div className="subscriptions-mobile-group-header-actions">
      <Tooltip title={groupSubscriptionUrl ? "复制订阅地址" : "当前分组没有订阅地址"}>
        <Button
          type="text"
          size="small"
          icon={<BiIcon name="copy" />}
          disabled={!groupSubscriptionUrl}
          onMouseDown={stopCollapseAction}
          onClick={(event) => {
            stopCollapseAction(event);
            void copySubscriptionUrlForGroup(group);
          }}
        />
      </Tooltip>
      <Tooltip title="编辑分组">
        <Button
          type="text"
          size="small"
          icon={<BiIcon name="pencil-square" />}
          onMouseDown={stopCollapseAction}
          onClick={(event) => {
            stopCollapseAction(event);
            openEditGroupModal(group);
          }}
        />
      </Tooltip>
      <Tooltip title="删除分组">
        <Button
          danger
          type="text"
          size="small"
          icon={<BiIcon name="trash" />}
          onMouseDown={stopCollapseAction}
          onClick={(event) => {
            stopCollapseAction(event);
            confirmRemoveGroup(group);
          }}
        />
      </Tooltip>
    </div>
  );

  const renderMobileExpandedGroupHeaderActions = (group: NodeGroup) => (
    <div className="subscriptions-mobile-group-header-actions is-expanded">
      {group.kind === "manual" ? (
        <Tooltip title="添加节点">
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="sign-intersection" />}
            onClick={() => {
              openNodeEditor({
                mode: "add",
                protocol: supportedNodeProtocols[0],
                groupId: group.id,
              });
            }}
          />
        </Tooltip>
      ) : (
        <Tooltip title="拉取订阅">
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="arrow-down-square" />}
            loading={isPullSubscriptionPending(group.id)}
            disabled={isPullSubscriptionPending(group.id)}
            onClick={() => {
              pullSubscriptionForGroup(group.id, group.name);
            }}
          />
        </Tooltip>
      )}
    </div>
  );

  const renderMobileExpandedGroupToolbar = (
    group: NodeGroup,
    actionRows: NodeRow[],
    options?: {
      sticky?: boolean;
    },
  ) => (
    <div className={`subscriptions-mobile-group-toolbar${options?.sticky ? " is-sticky" : ""}`}>
      <div className="subscriptions-mobile-group-toolbar-leading">
        {mobileMultiSelectEnabled ? (
          <>
            <button
              type="button"
              className="subscriptions-mobile-select-toggle"
              onClick={() => {
                toggleMobileSelectAllRows();
              }}
            >
              <BiIcon name={mobileSelectAllIconName} />
            </button>
            <Typography.Text
              type="secondary"
              className="subscriptions-mobile-group-toolbar-count"
            >
              {mobileExpandedGroupSelectionCount} 条记录
            </Typography.Text>
          </>
        ) : null}
      </div>
      <div className="subscriptions-mobile-group-toolbar-actions">
        <Tooltip title={mobileExpandedGroupCanProbe ? "一键探测延迟" : "需先启动代理且当前范围内有节点"}>
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="lightning-charge-fill" />}
            disabled={!mobileExpandedGroupCanProbe}
            loading={probeBusy}
            onClick={() => {
              void probeGroupByTypes(group, ["node_latency"], "延迟探测", actionRows);
            }}
          />
        </Tooltip>
        <Tooltip title={mobileExpandedGroupCanProbe ? "一键评分" : "需先启动代理且当前范围内有节点"}>
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="star-fill" />}
            disabled={!mobileExpandedGroupCanProbe}
            loading={probeBusy}
            onClick={() => {
              void probeGroupByTypes(group, ["real_connect"], "节点评分", actionRows);
            }}
          />
        </Tooltip>
        <Tooltip title={mobileExpandedGroupCanReset ? "重置评分" : "当前没有可重置评分的数据"}>
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="eraser-fill" />}
            disabled={!mobileExpandedGroupCanReset}
            loading={clearingProbeData}
            onClick={() => {
              void clearProbeDataForGroup(group, actionRows);
            }}
          />
        </Tooltip>
        <Tooltip title={mobileExpandedGroupCanReset ? "重置流量" : "当前没有可重置流量的数据"}>
          <Button
            type="text"
            size="small"
            icon={<BiIcon name="lightbulb-off" />}
            disabled={!mobileExpandedGroupCanReset}
            loading={resettingTrafficStats}
            onClick={() => {
              void resetTrafficStatsForGroup(group, actionRows);
            }}
          />
        </Tooltip>
        <Tooltip
          title={
            actionRows.length > 0
              ? mobileMultiSelectEnabled
                ? `删除已选 ${mobileExpandedGroupSelectionCount} 个节点`
                : "删除当前分组全部节点"
              : "当前没有可删除节点"
          }
        >
          <Button
            type="text"
            size="small"
            danger
            icon={<BiIcon name="trash" />}
            disabled={actionRows.length === 0}
            onClick={() => {
              deleteRowsWithConfirm(actionRows);
            }}
          />
        </Tooltip>
      </div>
    </div>
  );

  return (
    <Space
      className={`subscriptions-page${isMobileView ? " subscriptions-page-mobile" : ""}`}
      direction="vertical"
      size={12}
      style={{ width: "100%" }}
    >
      <DraftActionBar
        visible={hasAnyDraftChanges}
        apply={{
          title: "保存草稿修改",
          label: "保存",
          icon: <BiIcon name="check-lg" />,
          loading: applyingDraftChanges,
          onClick: () => {
            void applyDraftChanges();
          },
        }}
        discard={{
          title: "取消草稿修改",
          label: "取消",
          icon: <BiIcon name="x-lg" />,
          disabled: applyingDraftChanges,
          onClick: discardDraftChanges,
        }}
      />

      {isMobileView ? (
        <Card loading={loading} className="subscriptions-mobile-section-card">
          {orderedGroups.length === 0 ? (
            <div className="subscriptions-mobile-empty-state">
              <Typography.Text type="secondary">当前没有可用分组。</Typography.Text>
            </div>
          ) : (
            <>
              {mobileExpandedGroup ? (
                <div className="subscriptions-mobile-sticky-active-group">
                  <div className="subscriptions-mobile-active-group-panel">
                    <div className="subscriptions-mobile-group-header is-sticky">
                      <button
                        type="button"
                        className="subscriptions-mobile-group-header-main subscriptions-mobile-group-header-toggle"
                        onClick={collapseMobileExpandedGroup}
                      >
                        <span className="subscriptions-mobile-group-collapse-icon">
                          <BiIcon name="chevron-up" />
                        </span>
                        <div className="subscriptions-mobile-group-header-text">
                          <span className="subscriptions-mobile-group-header-name-row">
                            <Typography.Text strong className="subscriptions-mobile-group-header-name">
                              {mobileExpandedGroup.name}
                            </Typography.Text>
                            {snapshot?.activeGroupId === mobileExpandedGroup.id ? (
                              <span className="active-group-dot" />
                            ) : null}
                          </span>
                          <Typography.Text
                            type="secondary"
                            className="subscriptions-mobile-group-header-meta"
                          >
                            {resolveMobileGroupMetaLabel(mobileExpandedGroup)} ·{" "}
                            {mobileExpandedGroup.nodes.length} 个节点
                          </Typography.Text>
                        </div>
                      </button>
                      {renderMobileExpandedGroupHeaderActions(mobileExpandedGroup)}
                    </div>
                    {renderMobileExpandedGroupToolbar(
                      mobileExpandedGroup,
                      mobileExpandedGroupActionRows,
                      { sticky: true },
                    )}
                    <div
                      ref={mobileExpandedGroupScrollRef}
                      className="subscriptions-mobile-active-group-nodes-scroll"
                    >
                      {mobileExpandedGroupRows.length === 0 ? (
                        <div className="subscriptions-mobile-empty-state is-panel-empty">
                          <Typography.Text type="secondary">当前分组暂无节点。</Typography.Text>
                        </div>
                      ) : (
                        <MobileVirtualList
                          items={mobileExpandedGroupRows}
                          className="subscriptions-mobile-virtual-list"
                          itemHeight={mobileVirtualNodeCardHeightPx}
                          itemGap={mobileVirtualNodeCardGapPx}
                          getItemKey={(row) => row.key}
                          renderItem={(row) => {
                            const isActiveNode = row.node.id === activeNodeID;
                            const isSelected = selectedRowKeySet.has(row.key);
                            const showSelectionState = mobileMultiSelectEnabled;
                            return (
                              <MobileSwipeActionCard
                                leadingActions={
                                  mobileMultiSelectEnabled
                                    ? []
                                    : [
                                        {
                                          key: "select",
                                          label: "多选",
                                          icon: <BiIcon name="square" />,
                                          autoTriggerOnOpen: true,
                                          onClick: () => {
                                            enterMobileMultiSelectMode(row.key);
                                          },
                                        },
                                      ]
                                }
                                trailingActions={
                                  mobileMultiSelectEnabled
                                    ? []
                                    : [
                                        {
                                          key: "country",
                                          label: "国家",
                                          icon: <BiIcon name="globe2" />,
                                          onClick: () => {
                                            void updateSingleNodeCountry(row);
                                          },
                                        },
                                        {
                                          key: "edit",
                                          label: "编辑",
                                          icon: <BiIcon name="pencil-square" />,
                                          disabled: mobileExpandedGroup.kind !== "manual",
                                          onClick: () => {
                                            openManualRowEditor(row);
                                          },
                                        },
                                        {
                                          key: "delete",
                                          label: "删除",
                                          icon: <BiIcon name="trash" />,
                                          danger: true,
                                          onClick: () => {
                                            deleteRowsWithConfirm([row]);
                                          },
                                        },
                                      ]
                                }
                              >
                                <button
                                  type="button"
                                  className={`subscriptions-mobile-node-card${isActiveNode ? " is-active" : ""}${isSelected ? " is-selected" : ""}${row.node.id === locatedNodeID ? " is-located" : ""}`}
                                  onClick={() => {
                                    if (mobileMultiSelectEnabled) {
                                      toggleMobileRowSelection(row.key);
                                      return;
                                    }
                                    void activateNode(row);
                                  }}
                                >
                                  {showSelectionState ? (
                                    <span className="subscriptions-mobile-node-card-check">
                                      <BiIcon name={isSelected ? "check-square-fill" : "square"} />
                                    </span>
                                  ) : null}
                                  <span className="subscriptions-mobile-node-card-flag">
                                    {row.country ? (
                                      <CountryFlag
                                        code={row.country}
                                        ariaLabel={row.displayName}
                                      />
                                    ) : (
                                      <BiIcon name="globe2" />
                                    )}
                                  </span>
                                  <div className="subscriptions-mobile-node-card-body">
                                    {(() => {
                                      const latencyPending = isProbePending(row.node.id, "node_latency");
                                      const realConnectPending = isProbePending(row.node.id, "real_connect");
                                      const scorePending =
                                        (latencyPending || realConnectPending) &&
                                        Number(row.node.probeScore ?? 0) === 0;
                                      const displayLatencyPending =
                                        latencyPending && Number(row.node.latencyMs ?? 0) === 0;
                                      const displayRealConnectPending =
                                        realConnectPending && Number(row.node.probeRealConnectMs ?? 0) === 0;
                                      const scoreText = resolveMobileMetricText(
                                        row.node.probeScore,
                                        scorePending,
                                        formatProbeScoreLabel,
                                      );
                                      const latencyText = resolveMobileMetricText(
                                        row.node.latencyMs,
                                        displayLatencyPending,
                                        formatProbeLatencyLabel,
                                      );
                                      const realConnectText = resolveMobileMetricText(
                                        row.node.probeRealConnectMs,
                                        displayRealConnectPending,
                                        formatProbeLatencyLabel,
                                      );
                                      const scoreTone = scorePending
                                        ? "pending"
                                        : resolveMobileScoreMetricTone(row.node.probeScore);
                                      const latencyTone = displayLatencyPending
                                        ? "pending"
                                        : resolveMobileLatencyMetricTone(row.node.latencyMs);
                                      const realConnectTone = displayRealConnectPending
                                        ? "pending"
                                        : resolveMobileLatencyMetricTone(row.node.probeRealConnectMs);
                                      return (
                                        <>
                                          <div className="subscriptions-mobile-node-card-text">
                                            <Typography.Text
                                              strong
                                              className="subscriptions-mobile-node-card-title"
                                            >
                                              {row.displayName}
                                            </Typography.Text>
                                            <Typography.Text
                                              type="secondary"
                                              className="subscriptions-mobile-node-card-subtitle"
                                            >
                                              {formatNodeProtocolCompactLabel(row.node.protocol)}
                                            </Typography.Text>
                                          </div>
                                          <div className="subscriptions-mobile-node-card-metrics">
                                            <span
                                              className={`subscriptions-mobile-node-card-metric subscriptions-mobile-node-card-score ${resolveMobileProbeToneClass(scoreTone)}`}
                                            >
                                              <BiIcon name="star-fill" />
                                              <span>{scoreText}</span>
                                            </span>
                                            <div className="subscriptions-mobile-node-card-latency-row">
                                              <span
                                                className={`subscriptions-mobile-node-card-metric subscriptions-mobile-node-card-latency ${resolveMobileProbeToneClass(latencyTone)}`}
                                              >
                                                <BiIcon name="lightning-charge-fill" />
                                                <span>{latencyText}</span>
                                              </span>
                                              <span
                                                className={`subscriptions-mobile-node-card-metric subscriptions-mobile-node-card-latency ${resolveMobileProbeToneClass(realConnectTone)}`}
                                              >
                                                <BiIcon name="plug-fill" />
                                                <span>{realConnectText}</span>
                                              </span>
                                            </div>
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </div>
                                </button>
                              </MobileSwipeActionCard>
                            );
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
              <Collapse
                accordion
                className="subscriptions-mobile-group-collapse"
                activeKey={mobileExpandedGroupId ? [mobileExpandedGroupId] : []}
                onChange={(key) => {
                  const nextKey = Array.isArray(key)
                    ? (key[0] ? String(key[0]) : null)
                    : key
                      ? String(key)
                      : null;
                  setMobileExpandedGroupId(nextKey);
                  setMobileMultiSelectEnabled(false);
                  setSelectedRowKeys([]);
                  if (nextKey) {
                    initializedDefaultTabRef.current = true;
                    setActiveTabId(nextKey);
                  }
                }}
                items={orderedGroups.filter((group) => group.id !== mobileExpandedGroupId).map((group) => {
                const subscriptionSource =
                  group.kind === "subscription" && group.subscriptionId
                    ? (subscriptionById.get(group.subscriptionId) ?? null)
                    : null;
                return {
                  key: group.id,
                  label: (
                    <div className="subscriptions-mobile-group-header">
                      <div className="subscriptions-mobile-group-header-main">
                        <div className="subscriptions-mobile-group-header-text">
                          <span className="subscriptions-mobile-group-header-name-row">
                            <Typography.Text strong className="subscriptions-mobile-group-header-name">
                              {group.name}
                            </Typography.Text>
                            {snapshot?.activeGroupId === group.id ? (
                              <span className="active-group-dot" />
                            ) : null}
                          </span>
                          <Typography.Text
                            type="secondary"
                            className="subscriptions-mobile-group-header-meta"
                          >
                            {resolveMobileGroupMetaLabel(group)} · {group.nodes.length} 个节点
                          </Typography.Text>
                        </div>
                      </div>
                      {group.id === mobileExpandedGroupId
                        ? null
                        : renderMobileCollapsedGroupHeaderActions(
                            group,
                            subscriptionSource?.url?.trim() ?? "",
                          )}
                    </div>
                  ),
                  children: null,
                };
              })}
              />
            </>
          )}
        </Card>
      ) : (
      <Card
        loading={loading}
      >
        <div className="subscriptions-main-header-row">
          <div className="subscriptions-main-header-main">
            <HelpLabel
              label={
                <Typography.Text
                  strong
                  style={{ fontSize: 15, color: "#1f2430", whiteSpace: "nowrap" }}
                >
                  订阅管理
                </Typography.Text>
              }
              helpContent={{
                effect:
                  "用于管理订阅分组和普通分组，以及它们之间的节点复制和迁移。",
                caution:
                  "添加分组时输入订阅地址/URL则视为订阅分组，留空则为普通分组。订阅分组无法编辑/粘贴节点，普通分组可以。",
                recommendation:
                  "订阅分组常用高质量节点复制到普通分组中使用，加快[一键评分]筛选节点池。",
              }}
            />
            <Tooltip title={canCopySubscriptionUrl ? "复制订阅地址" : "仅订阅分组可复制 URL"}>
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-copy-btn"
                icon={<BiIcon name="copy" />}
                disabled={!canCopySubscriptionUrl}
                onClick={() => {
                  void copyCurrentSubscriptionURL();
                }}
              />
            </Tooltip>
            <Tooltip
              title={
                <div className="subscriptions-main-header-detail-tooltip">
                  {scopeDetailLines.map((line, index) => (
                    <div key={`${index}-${line}`}>{line}</div>
                  ))}
                </div>
              }
            >
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-detail-btn"
                icon={<BiIcon name="info-circle" />}
              />
            </Tooltip>
            <Tooltip
              title={canAddNodeFromHeader ? "添加节点" : "仅普通分组可用"}
            >
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-detail-btn"
                icon={<BiIcon name="sign-intersection" />}
                disabled={!canAddNodeFromHeader}
                onClick={() => {
                  if (!currentTabGroup || currentTabGroup.kind !== "manual") {
                    return;
                  }
                  openNodeEditor({
                    mode: "add",
                    protocol: supportedNodeProtocols[0],
                    groupId: currentTabGroup.id,
                  });
                }}
              />
            </Tooltip>
            <Tooltip
              title={
                !canPullSubscription
                  ? "仅订阅分组可用"
                  : currentTabPullSubscriptionPending
                    ? "拉取订阅中"
                    : "拉取订阅"
              }
            >
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-detail-btn"
                icon={<BiIcon name="arrow-down-square" />}
                loading={currentTabPullSubscriptionPending}
                disabled={!canPullSubscription || currentTabPullSubscriptionPending}
                onClick={() => {
                  handlePullSubscriptionFromMenu();
                }}
              />
            </Tooltip>
          </div>
          <Space
            size={4}
            className="subscriptions-main-header-actions"
          >
            <Tooltip title={canLocateByMenu ? "定位到" : "当前视图没有可定位节点"}>
              <Dropdown
                trigger={["click"]}
                disabled={!canLocateByMenu}
                menu={{
                  items: locateMenuItems,
                  onClick: onLocateMenuClick,
                }}
              >
                <Button
                  type="text"
                  size="small"
                  className="subscriptions-main-header-action-btn"
                  icon={<BiIcon name="geo-alt" />}
                  disabled={!canLocateByMenu}
                />
              </Dropdown>
            </Tooltip>
            <Tooltip title={canBatchProbeByGroup ? "一键探测延迟" : probeActionDisabledReason}>
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-action-btn"
                icon={<BiIcon name="lightning-charge-fill" />}
                disabled={!canBatchProbeByGroup}
                loading={probeBusy}
                onClick={probeCurrentGroupLatency}
              />
            </Tooltip>
            <Tooltip title={canBatchProbeByGroup ? "一键评分" : probeActionDisabledReason}>
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-action-btn"
                icon={<BiIcon name="star-fill" />}
                disabled={!canBatchProbeByGroup}
                loading={probeBusy}
                onClick={probeCurrentGroupRealConnect}
              />
            </Tooltip>
            <Tooltip title={canClearProbeByGroup ? "一键重置评分" : clearProbeDisabledReason}>
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-action-btn"
                icon={<BiIcon name="hurricane" />}
                disabled={!canClearProbeByGroup}
                loading={clearingProbeData}
                onClick={() => {
                  void clearCurrentGroupProbeData();
                }}
              />
            </Tooltip>
            <Tooltip title={canResetTrafficByGroup ? "一键重置流量" : clearProbeDisabledReason}>
              <Button
                type="text"
                size="small"
                className="subscriptions-main-header-action-btn"
                icon={<BiIcon name="lightbulb-off" />}
                disabled={!canResetTrafficByGroup}
                loading={resettingTrafficStats}
                onClick={() => {
                  void resetCurrentGroupTrafficStats();
                }}
              />
            </Tooltip>
          </Space>
        </div>
        <Tabs
          className="subscriptions-group-tabs"
          activeKey={activeTabId}
          onChange={(nextKey) => {
            setContextMenu(null);
            if (nextKey === ADD_GROUP_TAB_ID) {
              openAddSubscriptionModal();
              return;
            }
            initializedDefaultTabRef.current = true;
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
                    icon={<BiIcon name="table" />}
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
                  <BiIcon name="grid" />
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
                    draggingGroupIDRef.current = "";
                  }}
                >
                  <Tooltip
                    title={
                      group.kind === "subscription"
                        ? "URL 订阅分组，可拉取订阅"
                        : "普通分组，可自定义节点与分类"
                    }
                  >
                    {group.kind === "subscription" ? (
                      <BiIcon name="cloud-arrow-down" />
                    ) : (
                      <BiIcon name="database" />
                    )}
                  </Tooltip>
                  <Typography.Text>{group.name}</Typography.Text>
                  {snapshot?.activeGroupId === group.id ? (
                    <span className="active-group-dot" />
                  ) : null}
                  {group.nodes.length > 0 && snapshot?.activeGroupId !== group.id ? (
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
                        void activateGroupWithoutRuntimeReload(group);
                      }}
                    >
                      激活
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    type="text"
                    className="group-tab-close-btn"
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
            })),
            {
              key: ADD_GROUP_TAB_ID,
              label: (
                <Tooltip title="添加订阅/普通分组">
                  <Button
                    type="text"
                    size="small"
                    className="subscriptions-add-group-tab-btn"
                    icon={
                      <BiIcon
                        name="plus-circle-fill"
                        className="subscriptions-add-group-tab-icon"
                      />
                    }
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openAddSubscriptionModal();
                    }}
                  />
                </Tooltip>
              ),
            },
          ]}
        />
        <div
          ref={nodeTableContextRef}
          className="node-table-context-area"
          onContextMenu={tableRenderReady ? handleContextMenu : undefined}
        >
          {tableRenderReady ? (
            <>
              {draggingNodeIDs.length > 0 ? (
                <div className="table-sort-hint">
                  <Typography.Text type="secondary">
                    正在调整 {draggingNodeIDs.length} 行顺序，移动到目标行上半区或下半区后松开左键即可。
                  </Typography.Text>
                </div>
              ) : null}
              <Table<NodeRow>
                className="subscriptions-node-table table-fixed-leading-columns"
                rowKey="key"
                size="small"
                bordered
                tableLayout="fixed"
                columns={columns}
                dataSource={rows}
                pagination={false}
                scroll={{ x: "max-content", y: subscriptionsTableScrollHeightPx }}
                rowClassName={(row) => {
                  const classNames: string[] = [];
                  if (row.node.id === activeNodeID) {
                    classNames.push("active-node-row");
                  } else if (row.node.id === locatedNodeID) {
                    classNames.push("subscriptions-located-row");
                  }
                  if (draggingNodeIDs.includes(row.key)) {
                    classNames.push("table-row-sort-dragging");
                  }
                  if (sortPreview?.key === row.key) {
                    classNames.push(
                      sortPreview.position === "before"
                        ? "table-row-sort-target-before"
                        : "table-row-sort-target-after",
                    );
                  }
                  return classNames.join(" ");
                }}
                rowSelection={rowSelection}
                onRow={handleTableRow}
              />
              {contextMenu ? (
                <div
                  ref={contextMenuOverlayRef}
                  className="subscriptions-context-menu-panel"
                  style={{
                    left: contextMenu.x,
                    top: contextMenu.y,
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <Menu
                    className="subscriptions-context-menu"
                    items={menuItems ?? []}
                    onClick={handleMenuClick}
                    selectable={false}
                    mode="vertical"
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="subscriptions-table-deferred-placeholder">
              <Typography.Text type="secondary">正在准备节点数据...</Typography.Text>
            </div>
          )}
        </div>
      </Card>
      )}

      <Card
        size="small"
        className={`subscriptions-probe-card${isMobileView ? " subscriptions-mobile-section-card subscriptions-mobile-probe-card" : ""}`}
      >
        <Collapse
          size="small"
          destroyInactivePanel
          activeKey={probeSettingsExpandedKeys}
          className="subscriptions-probe-settings-collapse"
          onChange={(keys) => {
            const nextKeys = Array.isArray(keys) ? keys.map((item) => String(item)) : [];
            setProbeSettingsExpandedKeys(nextKeys);
          }}
          items={[
            {
              key: "probe-settings",
              label: (
                <HelpLabel
                  label={
                    <Typography.Text strong className="subscriptions-probe-settings-header-title">
                      探测设置
                    </Typography.Text>
                  }
                  helpContent={{
                    scene: isMobileView
                      ? "需要调整节点延迟探测与真连接评分相关参数时使用。"
                      : "需要调整节点延迟探测、真连接评分和自动评分行为时使用。",
                    effect:
                      isMobileView
                        ? "这里的配置会影响后续探测任务的并发数、超时时间、探测间隔和测试地址。"
                        : "这里的配置会影响后续探测任务的并发数、超时时间、探测间隔、测试地址以及自动评分策略。",
                    caution:
                      "配置变更会影响之后的评分结果与探测节奏；并发或频率过高时，可能增加网络请求压力。",
                  }}
                />
              ),
              children: (
                <div className="subscriptions-probe-settings-panel">
                  <div className="subscriptions-probe-settings-grid">
                    <div className="subscriptions-probe-settings-field">
                      <Typography.Text type="secondary">并发线程数</Typography.Text>
                      <InputNumber
                        min={1}
                        max={64}
                        value={probeSettingsDraft.concurrency}
                        onChange={(value) => {
                          if (typeof value !== "number" || Number.isNaN(value)) {
                            return;
                          }
                          updateProbeSettingsDraft({
                            concurrency: Math.max(1, Math.min(64, Math.round(value))),
                          });
                        }}
                      />
                    </div>
                    <div className="subscriptions-probe-settings-field">
                      <Typography.Text type="secondary">单次超时(秒)</Typography.Text>
                      <AutoComplete
                        value={probeTimeoutSecInput}
                        options={probeTimeoutSecOptions.map((item) => ({
                          value: String(item),
                        }))}
                        onChange={(value) => {
                          setProbeTimeoutSecInput(value);
                          markProbeSettingsDirty();
                        }}
                        onSelect={(value) => {
                          setProbeTimeoutSecInput(value);
                          applyProbeTimeoutDraftFromValue(value);
                        }}
                        onBlur={commitProbeTimeoutInput}
                      />
                    </div>
                    <div className="subscriptions-probe-settings-field">
                      <Typography.Text type="secondary">探测间隔(分钟)</Typography.Text>
                      <AutoComplete
                        value={probeIntervalMinInput}
                        options={probeIntervalMinOptions.map((item) => ({
                          value: String(item),
                        }))}
                        onChange={(value) => {
                          setProbeIntervalMinInput(value);
                          markProbeSettingsDirty();
                        }}
                        onSelect={(value) => {
                          setProbeIntervalMinInput(value);
                          applyProbeIntervalDraftFromValue(value);
                        }}
                        onBlur={commitProbeIntervalInput}
                      />
                    </div>
                    <div className="subscriptions-probe-settings-field subscriptions-probe-settings-field-wide">
                      <Typography.Text type="secondary">真实连接测试地址</Typography.Text>
                      <AutoComplete
                        value={probeSettingsDraft.realConnectTestUrl}
                        options={probeRealConnectTestUrlOptions.map((item) => ({ value: item }))}
                        onChange={(value) => {
                          updateProbeSettingsDraft({ realConnectTestUrl: value });
                        }}
                      />
                    </div>
                    <div className="subscriptions-probe-settings-field subscriptions-probe-settings-field-wide">
                      <Typography.Text type="secondary">节点信息查询地址</Typography.Text>
                      <AutoComplete
                        value={probeSettingsDraft.nodeInfoQueryUrl}
                        options={probeNodeInfoQueryUrlOptions.map((item) => ({ value: item }))}
                        onChange={(value) => {
                          updateProbeSettingsDraft({ nodeInfoQueryUrl: value });
                        }}
                      />
                    </div>
                  </div>
                  {!isMobileView ? (
                    <Space
                      wrap
                      size={[18, 8]}
                      className="subscriptions-probe-settings-switches"
                    >
                      <SwitchWithLabel
                        label="自动评分"
                        helpContent="开启后按“探测间隔”自动执行当前激活分组的一键评分（真连评分逻辑），关闭则仅手动评分。"
                        checked={probeSettingsDraft.autoProbeOnActiveGroup}
                        onChange={(checked) => {
                          updateProbeSettingsDraft({ autoProbeOnActiveGroup: checked });
                        }}
                      />
                    </Space>
                  ) : null}
                  <Space
                    size={10}
                    className="subscriptions-probe-settings-actions"
                  >
                   
                  </Space>
                </div>
              ),
            },
          ]}
        />
      </Card>

      {addSubOpen ? (
        <Modal
          title="添加订阅/普通分组"
          open={addSubOpen}
          onCancel={closeAddSubscriptionModal}
          onOk={submitAddSubscription}
          footer={(_, { OkBtn, CancelBtn }) => (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <Typography.Text
                style={{
                  color: "#389e0d",
                  visibility: showAddSubscriptionPullHint ? "visible" : "hidden",
                }}
              >
                展开分组后点击图标"拉取订阅"
              </Typography.Text>
              <Space size={8}>
                <CancelBtn />
                <OkBtn />
              </Space>
            </div>
          )}
        >
          <Form
            layout="vertical"
            form={subscriptionForm}
          >
            <Form.Item
              label="分组名称"
              name="name"
              rules={[{ required: true, message: "请输入订阅名称" }]}
            >
              <Input placeholder="例如：机场A / 普通分组A" />
            </Form.Item>
            <Form.Item
              label={(
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span>URL/订阅地址</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.3 }}>
                    （留空=普通分组；填写订阅地址=订阅分组）
                  </Typography.Text>
                </div>
              )}
              name="url"
            >
              <Input placeholder="https://example.com/subscription" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}

      {editGroupOpen ? (
        <Modal
          title="编辑分组"
          open={editGroupOpen}
          okText="确定"
          cancelText="取消"
          onCancel={closeEditGroupModal}
          onOk={() => {
            void submitEditGroup();
          }}
          footer={(_, { OkBtn, CancelBtn }) => (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <Button
                danger
                type="text"
                disabled={!editingGroup}
                icon={<BiIcon name="trash" />}
                onClick={() => {
                  if (!editingGroup) {
                    return;
                  }
                  closeEditGroupModal();
                  confirmRemoveGroup(editingGroup);
                }}
              >
                删除分组
              </Button>
              <Space size={8}>
                <CancelBtn />
                <OkBtn />
              </Space>
            </div>
          )}
        >
          <Form
            layout="vertical"
            form={editGroupForm}
          >
            <Form.Item
              label="分组名称"
              name="name"
              rules={[{ required: true, message: "请输入分组名称" }]}
            >
              <Input placeholder="例如：机场A / 普通分组A" />
            </Form.Item>
            <Form.Item
              label={(
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span>URL/订阅地址</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.3 }}>
                    （留空=普通分组；填写订阅地址=订阅分组）
                  </Typography.Text>
                </div>
              )}
              name="url"
            >
              <Input placeholder="https://example.com/subscription" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}

      <SubscriptionNodeEditorModal
        open={nodeEditorState != null}
        mode={nodeEditorState?.mode ?? "add"}
        manualGroups={manualGroups}
        initialProtocol={nodeEditorState?.protocol ?? supportedNodeProtocols[0]}
        initialGroupId={nodeEditorState?.groupId ?? manualGroups[0]?.id ?? ""}
        editingNode={
          nodeEditorState?.mode === "edit" && nodeEditorState.row
            ? {
                groupId: nodeEditorState.row.groupId,
                node: nodeEditorState.row.node,
              }
            : null
        }
        submitting={submittingNodeEditor}
        onCancel={() => {
          if (submittingNodeEditor) {
            return;
          }
          setNodeEditorState(null);
        }}
        onSubmit={handleSubmitNodeEditor}
      />
    </Space>
  );
}
