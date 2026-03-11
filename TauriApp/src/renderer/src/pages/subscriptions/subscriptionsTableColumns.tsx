import { Tag } from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import { resolveCountryMetadata } from "../../app/data/countryMetadata";
import { CountryFlag } from "../../components/flag/CountryFlag";
import { BiIcon } from "../../components/icons/BiIcon";
import type { NodeProtocol, ProbeType, VpnNode } from "../../../../shared/daemon";

export interface NodeRow {
  key: string;
  index: number;
  groupId: string;
  groupName: string;
  country: string;
  displayName: string;
  node: VpnNode;
  realtimeDownloadRateBps?: number;
  realtimeUploadRateBps?: number;
}

export type ColumnKey =
  | "index"
  | "protocol"
  | "country"
  | "name"
  | "address"
  | "port"
  | "transport"
  | "latency"
  | "probeRealConnect"
  | "realtimeSpeed"
  | "probeScore"
  | "totalDownload"
  | "totalUpload"
  | "group";

export interface ColumnVisibilityOption {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
}

export type SortOrder = "none" | "asc" | "desc";

export interface SortState {
  key: ColumnKey | "";
  order: SortOrder;
}

export const columnVisibilityStorageKey = "wateray.subscriptions.visible_columns.v4";
export const tableSelectionColumnWidth = 56;
export const tableIndexColumnWidth = 74;
export const tableRealtimeSpeedColumnWidth = 164;

export const columnVisibilityOptions: ColumnVisibilityOption[] = [
  { key: "index", label: "序号", defaultVisible: true },
  { key: "protocol", label: "类型", defaultVisible: true },
  { key: "country", label: "国家", defaultVisible: false },
  { key: "name", label: "名称", defaultVisible: true },
  { key: "address", label: "地址", defaultVisible: false },
  { key: "port", label: "端口", defaultVisible: false },
  { key: "transport", label: "传输协议", defaultVisible: false },
  { key: "latency", label: "延迟", defaultVisible: true },
  { key: "probeRealConnect", label: "真实连接", defaultVisible: true },
  { key: "realtimeSpeed", label: "实时速度", defaultVisible: true },
  { key: "probeScore", label: "综合评分", defaultVisible: true },
  { key: "totalDownload", label: "总下载", defaultVisible: false },
  { key: "totalUpload", label: "总上传", defaultVisible: false },
  { key: "group", label: "分组", defaultVisible: false },
];

const columnOrder = columnVisibilityOptions.map((option) => option.key);

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

export function compareRowsByColumn(left: NodeRow, right: NodeRow, columnKey: ColumnKey): number {
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
    case "probeRealConnect": {
      const leftValue = left.node.probeRealConnectMs ?? Number.MAX_SAFE_INTEGER;
      const rightValue = right.node.probeRealConnectMs ?? Number.MAX_SAFE_INTEGER;
      return leftValue - rightValue;
    }
    case "realtimeSpeed": {
      const leftValue =
        Math.max(0, left.realtimeDownloadRateBps ?? 0) + Math.max(0, left.realtimeUploadRateBps ?? 0);
      const rightValue =
        Math.max(0, right.realtimeDownloadRateBps ?? 0) + Math.max(0, right.realtimeUploadRateBps ?? 0);
      return leftValue - rightValue;
    }
    case "probeScore":
      return (left.node.probeScore ?? -1) - (right.node.probeScore ?? -1);
    case "totalDownload":
      return left.node.totalDownloadMb - right.node.totalDownloadMb;
    case "totalUpload":
      return left.node.totalUploadMb - right.node.totalUploadMb;
    case "group":
      return normalizeValue(left.groupName).localeCompare(normalizeValue(right.groupName));
    default:
      return 0;
  }
}

export function loadVisibleColumns(): ColumnKey[] {
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

export function resolveVisibleColumns(
  previous: ColumnKey[],
  columnKey: ColumnKey,
  visible: boolean,
): ColumnKey[] {
  if (columnKey === "index" && !visible) {
    return previous;
  }
  const nextSet = new Set(previous);
  if (visible) {
    nextSet.add(columnKey);
  } else {
    nextSet.delete(columnKey);
  }
  nextSet.add("index");
  return columnOrder.filter((key) => nextSet.has(key));
}

export function resolveAvailableColumnOptions(
  activeTabId: string,
  allGroupTabId: string,
): ColumnVisibilityOption[] {
  return columnVisibilityOptions.filter(
    (option) => option.key !== "group" || activeTabId === allGroupTabId,
  );
}

export function buildColumnMenuItems(
  availableColumnOptions: ColumnVisibilityOption[],
): NonNullable<MenuProps["items"]> {
  return availableColumnOptions.map((option) => ({
    key: option.key,
    label: option.label,
    disabled: option.key === "index",
  }));
}

export function buildSelectedColumnMenuKeys(
  availableColumnOptions: ColumnVisibilityOption[],
  visibleColumnKeys: ColumnKey[],
): ColumnKey[] {
  const visibleSet = new Set(visibleColumnKeys);
  return availableColumnOptions
    .map((option) => option.key)
    .filter((key) => visibleSet.has(key));
}

interface BuildSubscriptionsColumnsParams {
  activeTabId: string;
  allGroupTabId: string;
  visibleColumnKeys: ColumnKey[];
  canSortRows: boolean;
  sortState: SortState;
  activeNodeID: string;
  trafficMonitoringEnabled?: boolean;
  isProbePending?: (nodeID: string, probeType: ProbeType) => boolean;
  toggleColumnSort: (columnKey: ColumnKey) => void;
  protocolLabel: (protocol: NodeProtocol) => string;
}

export function buildSubscriptionsColumns({
  activeTabId,
  allGroupTabId,
  visibleColumnKeys,
  canSortRows,
  sortState,
  activeNodeID,
  trafficMonitoringEnabled,
  isProbePending,
  toggleColumnSort,
  protocolLabel,
}: BuildSubscriptionsColumnsParams): ColumnsType<NodeRow> {
  const visible = new Set(visibleColumnKeys);
  const next: ColumnsType<NodeRow> = [];
  const fixedIndexColumnStyle = {
    width: tableIndexColumnWidth,
    minWidth: tableIndexColumnWidth,
    maxWidth: tableIndexColumnWidth,
  };
  const fixedRealtimeSpeedColumnStyle = {
    width: tableRealtimeSpeedColumnWidth,
    minWidth: tableRealtimeSpeedColumnWidth,
    maxWidth: tableRealtimeSpeedColumnWidth,
  };
  const buildSortableHeaderCellProps = (columnKey: ColumnKey, extraClassName = "") => {
    const className = ["subscriptions-sortable-header-cell", extraClassName]
      .filter((item) => item.trim() !== "")
      .join(" ");
    if (!canSortRows) {
      return extraClassName.trim() !== "" ? { className: extraClassName } : {};
    }
    return {
      className,
      onClick: () => toggleColumnSort(columnKey),
    };
  };
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
      <span className="sortable-column-title">
        {label}
        {indicator ? <span className="sortable-column-indicator">{indicator}</span> : null}
      </span>
    );
  };
  const formatRateToKM = (value: number): string => {
    const normalized = Math.max(0, Math.trunc(Number(value ?? 0)));
    const valueKB = normalized / 1024;
    if (valueKB >= 1024) {
      return `${(valueKB / 1024).toFixed(1)}M`;
    }
    return `${valueKB.toFixed(1)}K`;
  };
  if (visible.has("index")) {
    next.push({
      title: renderSortableTitle("序号", "index"),
      dataIndex: "index",
      className: "table-index-column subscriptions-index-column",
      width: tableIndexColumnWidth,
      align: "center",
      onHeaderCell: () =>
        ({
          ...buildSortableHeaderCellProps("index", "table-index-column subscriptions-index-column"),
          style: fixedIndexColumnStyle,
        }),
      onCell: () => ({
        className: "table-index-column subscriptions-index-column",
        style: fixedIndexColumnStyle,
      }),
    });
  }
  if (visible.has("protocol")) {
    next.push({
      title: renderSortableTitle("类型", "protocol"),
      dataIndex: ["node", "protocol"],
      render: (value: NodeProtocol) => protocolLabel(value),
      onHeaderCell: () => buildSortableHeaderCellProps("protocol"),
    });
  }
  if (visible.has("country")) {
    next.push({
      title: renderSortableTitle("国家", "country"),
      render: (_, row) => row.country || "-",
      onHeaderCell: () => buildSortableHeaderCellProps("country"),
    });
  }
  if (visible.has("name")) {
    next.push({
      title: renderSortableTitle("名称", "name"),
      dataIndex: ["node", "name"],
      onHeaderCell: () => buildSortableHeaderCellProps("name"),
      render: (_value: string, row) => {
        const country = row.country;
        const cleanedName = row.displayName;
        const countryMetadata = resolveCountryMetadata(country);
        return (
          <span className="subscriptions-node-name-cell">
            {country ? (
              <span
                className="subscriptions-node-flag"
                title={
                  countryMetadata
                    ? `${countryMetadata.chineseName} · ${countryMetadata.code} · ${countryMetadata.englishName}`
                    : country
                }
              >
                {countryMetadata ? (
                  <CountryFlag
                    code={countryMetadata.code}
                    ariaLabel={countryMetadata.chineseName}
                  />
                ) : (
                  country
                )}
              </span>
            ) : (
              <Tag>[未知]</Tag>
            )}
            <span className="subscriptions-node-name-text" title={cleanedName}>
              {cleanedName}
            </span>
          </span>
        );
      },
    });
  }
  if (visible.has("address")) {
    next.push({
      title: renderSortableTitle("地址", "address"),
      dataIndex: ["node", "address"],
      render: (value: string) => <span title={value}>{value}</span>,
      onHeaderCell: () => buildSortableHeaderCellProps("address"),
    });
  }
  if (visible.has("port")) {
    next.push({
      title: renderSortableTitle("端口", "port"),
      dataIndex: ["node", "port"],
      onHeaderCell: () => buildSortableHeaderCellProps("port"),
    });
  }
  if (visible.has("transport")) {
    next.push({
      title: renderSortableTitle("传输协议", "transport"),
      dataIndex: ["node", "transport"],
      onHeaderCell: () => buildSortableHeaderCellProps("transport"),
    });
  }
  if (visible.has("latency")) {
    next.push({
      title: renderSortableTitle("延迟", "latency"),
      render: (_, row) => {
        if (isProbePending?.(row.node.id, "node_latency")) {
          const pendingText = isProbePending?.(row.node.id, "real_connect") ? "预检中" : "待检测";
          return <span className="subscriptions-probe-pending-text">{pendingText}</span>;
        }
        const latencyMs = row.node.latencyMs;
        const levelClassName =
          latencyMs < 0
            ? "is-failed"
            : latencyMs > 0 && latencyMs < 120
              ? "is-fast"
              : "is-slow";
        return (
          <span className={`subscriptions-latency-text ${levelClassName}`}>
            {latencyMs} ms
          </span>
        );
      },
      onHeaderCell: () => buildSortableHeaderCellProps("latency"),
    });
  }
  if (visible.has("probeRealConnect")) {
    next.push({
      title: renderSortableTitle("真实连接", "probeRealConnect"),
      render: (_, row) => {
        if (isProbePending?.(row.node.id, "real_connect")) {
          return <span className="subscriptions-probe-pending-text">待检测</span>;
        }
        const value = row.node.probeRealConnectMs;
        if (typeof value !== "number" || value <= 0) {
          return <span className="subscriptions-probe-realconnect-text is-failed">-</span>;
        }
        const levelClassName = value < 180 ? "is-fast" : "is-slow";
        return (
          <span className={`subscriptions-probe-realconnect-text ${levelClassName}`}>
            {value} ms
          </span>
        );
      },
      onHeaderCell: () => buildSortableHeaderCellProps("probeRealConnect"),
    });
  }
  if (visible.has("realtimeSpeed")) {
    next.push({
      title: renderSortableTitle("实时速度", "realtimeSpeed"),
      className: "subscriptions-realtime-speed-column",
      width: tableRealtimeSpeedColumnWidth,
      render: (_, row) => {
        const downloadRateBps = trafficMonitoringEnabled
          ? Math.max(0, Math.trunc(row.realtimeDownloadRateBps ?? 0))
          : 0;
        const uploadRateBps = trafficMonitoringEnabled
          ? Math.max(0, Math.trunc(row.realtimeUploadRateBps ?? 0))
          : 0;
        const downloadText = formatRateToKM(downloadRateBps);
        const uploadText = formatRateToKM(uploadRateBps);
        const text = `下载 ${downloadText} / 上传 ${uploadText}`;
        return (
          <span className="subscriptions-realtime-speed-text" title={text}>
            <span className="subscriptions-realtime-speed-part">
              <BiIcon name="download" className="subscriptions-realtime-speed-icon" />
              <span>{downloadText}</span>
            </span>
            <span className="subscriptions-realtime-speed-separator">/</span>
            <span className="subscriptions-realtime-speed-part">
              <BiIcon name="upload" className="subscriptions-realtime-speed-icon" />
              <span>{uploadText}</span>
            </span>
          </span>
        );
      },
      onHeaderCell: () => ({
        ...buildSortableHeaderCellProps(
          "realtimeSpeed",
          "subscriptions-realtime-speed-column",
        ),
        style: fixedRealtimeSpeedColumnStyle,
      }),
      onCell: () => ({
        className: "subscriptions-realtime-speed-column",
        style: fixedRealtimeSpeedColumnStyle,
      }),
    });
  }
  if (visible.has("probeScore")) {
    next.push({
      title: renderSortableTitle("综合评分", "probeScore"),
      render: (_, row) =>
        typeof row.node.probeScore === "number" && Number.isFinite(row.node.probeScore) ? (
          row.node.probeScore.toFixed(1)
        ) : (
          <span className="subscriptions-probe-placeholder">-</span>
        ),
      onHeaderCell: () => buildSortableHeaderCellProps("probeScore"),
    });
  }
  if (visible.has("totalDownload")) {
    next.push({
      title: renderSortableTitle("总下载", "totalDownload"),
      render: (_, row) => `${row.node.totalDownloadMb.toFixed(1)} MB`,
      onHeaderCell: () => buildSortableHeaderCellProps("totalDownload"),
    });
  }
  if (visible.has("totalUpload")) {
    next.push({
      title: renderSortableTitle("总上传", "totalUpload"),
      render: (_, row) => `${row.node.totalUploadMb.toFixed(1)} MB`,
      onHeaderCell: () => buildSortableHeaderCellProps("totalUpload"),
    });
  }
  if (activeTabId === allGroupTabId && visible.has("group")) {
    next.push({
      title: "分组",
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
    const originalOnCell = column.onCell;
    column.onCell = (row, index) => {
      const originalProps = originalOnCell?.(row, index) ?? {};
      const activeProps = activeCellProps(row);
      const className = [originalProps.className, activeProps.className]
        .filter((item) => typeof item === "string" && item.trim() !== "")
        .join(" ");
      return {
        ...originalProps,
        ...activeProps,
        className: className || undefined,
      };
    };
  }
  return next;
}
