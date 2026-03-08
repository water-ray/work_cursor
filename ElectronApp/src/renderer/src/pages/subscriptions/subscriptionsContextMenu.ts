import type { MenuProps } from "antd";
import { createElement } from "react";
import type { NodeGroup, NodeProtocol } from "../../../../shared/daemon";
import { BiIcon } from "../../components/icons/BiIcon";

const subscriptionsContextSubmenuClassName = "subscriptions-context-submenu";

interface BuildSubscriptionsContextMenuParams {
  canPullSubscription: boolean;
  canUseAnchorNode: boolean;
  canEditAnchorNode: boolean;
  canAddNode: boolean;
  canMoveRows: boolean;
  canCopyRows: boolean;
  canUpdateCountry: boolean;
  canPasteToCurrentGroup: boolean;
  activeTabId: string;
  allGroupTabId: string;
  probingNodes: boolean;
  canProbeLatencyFromContext: boolean;
  canProbeRealConnectFromContext: boolean;
  canClearProbeFromContext: boolean;
  currentTabGroup: NodeGroup | null;
  canOperateRows: boolean;
  targetGroups: NodeGroup[];
  commonProtocols: NodeProtocol[];
  protocolLabel: (protocol: NodeProtocol) => string;
}

export function buildSubscriptionsContextMenuItems({
  canPullSubscription,
  canUseAnchorNode,
  canEditAnchorNode,
  canAddNode,
  canMoveRows,
  canCopyRows,
  canUpdateCountry,
  canPasteToCurrentGroup,
  activeTabId,
  allGroupTabId,
  probingNodes,
  canProbeLatencyFromContext,
  canProbeRealConnectFromContext,
  canClearProbeFromContext,
  currentTabGroup,
  canOperateRows,
  targetGroups,
  commonProtocols,
  protocolLabel,
}: BuildSubscriptionsContextMenuParams): NonNullable<MenuProps["items"]> {
  const items: NonNullable<MenuProps["items"]> = [];
  const renderMenuLabel = (text: string, shortcut?: string) =>
    createElement(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          minWidth: 180,
        },
      },
      createElement("span", null, text),
      shortcut
        ? createElement(
            "span",
            {
              style: {
                color: "#8c8c8c",
                fontSize: 12,
                whiteSpace: "nowrap",
              },
            },
            shortcut,
          )
        : null,
    );
  const secondaryItems: NonNullable<MenuProps["items"]> = [];
  if (canUseAnchorNode) {
    items.push({
      key: "use-node",
      label: renderMenuLabel("激活节点", "回车 / 双击"),
      icon: createElement(BiIcon, { name: "cursor-fill" }),
    });
  }
  if (canEditAnchorNode) {
    items.push({
      key: "edit-node",
      label: renderMenuLabel("编辑节点", "Ctrl+回车 / Ctrl+双击"),
      icon: createElement(BiIcon, { name: "pencil-square" }),
    });
  }
  if (canOperateRows) {
    items.push({
      key: "copy-text",
      label: renderMenuLabel("复制", "Ctrl+C"),
      icon: createElement(BiIcon, { name: "clipboard" }),
    });
  }
  if (canPasteToCurrentGroup) {
    items.push({
      key: "paste-text",
      label: renderMenuLabel("粘贴", "Ctrl+V"),
      icon: createElement(BiIcon, { name: "clipboard-plus" }),
    });
  }
  const transferItems: NonNullable<MenuProps["items"]> = [];
  if (canCopyRows && targetGroups.length > 0) {
    transferItems.push({
      key: "copy-to",
      label: renderMenuLabel("复制到"),
      icon: createElement(BiIcon, { name: "files" }),
      children: targetGroups.map((group) => ({
        key: `copy-to:${group.id}`,
        label: group.name,
      })),
    });
  }
  if (canMoveRows && targetGroups.length > 0) {
    transferItems.push({
      key: "move-to",
      label: renderMenuLabel("移动到"),
      icon: createElement(BiIcon, { name: "arrow-right-circle" }),
      children: targetGroups.map((group) => ({
        key: `move-to:${group.id}`,
        label: group.name,
      })),
    });
  }
  items.push(...transferItems);
  if (canAddNode) {
    items.push({
      key: "add-node",
      label: renderMenuLabel("添加节点"),
      icon: createElement(BiIcon, { name: "plus-circle" }),
      children: commonProtocols.map((protocol) => ({
        key: `add-node:${protocol}`,
        label: protocolLabel(protocol),
      })),
    });
  }
  if (canPullSubscription && currentTabGroup) {
    secondaryItems.push({
      key: "pull-subscription",
      label: renderMenuLabel("拉取订阅"),
      icon: createElement(BiIcon, { name: "cloud-arrow-down" }),
    });
  }
  if (activeTabId !== allGroupTabId) {
    secondaryItems.push({
      key: "probe-latency",
      label: renderMenuLabel(probingNodes ? "探测中..." : "探测延迟"),
      disabled: !canProbeLatencyFromContext,
      icon: createElement(BiIcon, { name: "lightning-charge-fill" }),
    });
    secondaryItems.push({
      key: "probe-real-connect",
      label: renderMenuLabel(probingNodes ? "探测中..." : "探测真连/评分"),
      disabled: !canProbeRealConnectFromContext,
      icon: createElement(BiIcon, { name: "star-fill" }),
    });
  }
  if (canOperateRows) {
    secondaryItems.push({
      key: "clear-probe",
      label: renderMenuLabel("重置评分"),
      disabled: !canClearProbeFromContext,
      icon: createElement(BiIcon, { name: "hurricane" }),
    });
    secondaryItems.push({
      key: "update-country",
      label: renderMenuLabel("更新国家"),
      disabled: !canUpdateCountry,
      icon: createElement(BiIcon, { name: "globe2" }),
    });
  }
  secondaryItems.push({
    key: "select-all",
    label: renderMenuLabel("全选"),
    icon: createElement(BiIcon, { name: "check2-square" }),
  });
  secondaryItems.push({
    key: "inverse-select",
    label: renderMenuLabel("反选"),
    icon: createElement(BiIcon, { name: "ui-checks-grid" }),
  });
  if (secondaryItems.length > 0) {
    items.push({
      type: "divider",
    });
    items.push(...secondaryItems);
  }
  if (canOperateRows) {
    items.push({
      type: "divider",
    });
    items.push({
      key: "delete",
      label: renderMenuLabel("删除", "Ctrl+D"),
      danger: true,
      icon: createElement(BiIcon, { name: "trash" }),
    });
  }
  return decorateContextMenuItems(items);
}

function decorateContextMenuItems(
  items: NonNullable<MenuProps["items"]>,
): NonNullable<MenuProps["items"]> {
  return items.map((item) => {
    if (!item || !("children" in item) || !Array.isArray(item.children)) {
      return item;
    }
    return {
      ...item,
      popupClassName: subscriptionsContextSubmenuClassName,
      children: decorateContextMenuItems(item.children),
    };
  });
}

interface SubscriptionsContextMenuActionHandlers {
  onPullSubscription: () => void;
  onUseNode: () => void;
  onEditNode: () => void;
  onProbeLatency: () => void;
  onProbeRealConnect: () => void;
  onClearProbeData: () => void;
  onUpdateCountry: () => void;
  onCopyText: () => void;
  onPasteText: () => void;
  onSelectAll: () => void;
  onInverseSelect: () => void;
  onAddNode: (protocol: NodeProtocol) => void;
  onMoveOrCopy: (targetGroupId: string, move: boolean) => void;
  onDelete: () => void;
}

export function dispatchSubscriptionsContextMenuAction(
  actionKey: string,
  handlers: SubscriptionsContextMenuActionHandlers,
): void {
  if (actionKey === "pull-subscription") {
    handlers.onPullSubscription();
    return;
  }
  if (actionKey === "use-node") {
    handlers.onUseNode();
    return;
  }
  if (actionKey === "edit-node") {
    handlers.onEditNode();
    return;
  }
  if (actionKey === "probe-latency") {
    handlers.onProbeLatency();
    return;
  }
  if (actionKey === "probe-real-connect") {
    handlers.onProbeRealConnect();
    return;
  }
  if (actionKey === "clear-probe") {
    handlers.onClearProbeData();
    return;
  }
  if (actionKey === "update-country") {
    handlers.onUpdateCountry();
    return;
  }
  if (actionKey === "copy-text") {
    handlers.onCopyText();
    return;
  }
  if (actionKey === "paste-text") {
    handlers.onPasteText();
    return;
  }
  if (actionKey === "select-all") {
    handlers.onSelectAll();
    return;
  }
  if (actionKey === "inverse-select") {
    handlers.onInverseSelect();
    return;
  }
  if (actionKey.startsWith("add-node:")) {
    handlers.onAddNode(actionKey.replace("add-node:", "") as NodeProtocol);
    return;
  }
  if (actionKey.startsWith("move-to:") || actionKey.startsWith("copy-to:")) {
    const move = actionKey.startsWith("move-to:");
    const targetGroupId = actionKey.split(":")[1];
    if (!targetGroupId || targetGroupId.trim() === "") {
      return;
    }
    handlers.onMoveOrCopy(targetGroupId, move);
    return;
  }
  if (actionKey === "delete") {
    handlers.onDelete();
  }
}
