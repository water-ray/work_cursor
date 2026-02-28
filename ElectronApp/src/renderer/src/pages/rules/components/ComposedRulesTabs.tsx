import {
  Button,
  Dropdown,
  Form,
  Input,
  message,
  Modal,
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  notification,
} from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  HolderOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import type { DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BaseRuleItem,
  ComposedRuleGroup,
  ComposedRuleItem,
  RuleApplyMode,
} from "../../../../../shared/daemon";

interface ComposedRulesTabsProps {
  groups: ComposedRuleGroup[];
  activeGroupId: string;
  baseRules: BaseRuleItem[];
  onChange: (nextGroups: ComposedRuleGroup[], nextActiveGroupId: string) => Promise<boolean>;
  onHotReloadRules: () => Promise<{ status: "updated" | "noop"; message: string }>;
}

interface ContextMenuState {
  x: number;
  y: number;
  anchorRuleID: string | null;
}

interface ComposedRuleDraft {
  id: string;
  name: string;
  baseRuleId: string;
  enabled: boolean;
}

const sortDraftNoticeKey = "rules-composed-sort-draft";
const ADD_GROUP_KEY = "__add_composed_group__";

function normalizeGroups(groups: ComposedRuleGroup[]): ComposedRuleGroup[] {
  if (groups.length > 0) {
    return groups.map((group) => ({
      id: group.id,
      name: group.name || group.id,
      mode: (group.mode === "direct" ? "direct" : "proxy") as RuleApplyMode,
      items: group.items ?? [],
    }));
  }
  return [
    {
      id: "default",
      name: "默认分组",
      mode: "proxy",
      items: [],
    },
  ];
}

function buildDraft(index: number): ComposedRuleDraft {
  return {
    id: `composed-rule-${Date.now()}-${index}`,
    name: "",
    baseRuleId: "",
    enabled: true,
  };
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function sameStringMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const set = new Set(left);
  return right.every((item) => set.has(item));
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

export function ComposedRulesTabs({
  groups,
  activeGroupId,
  baseRules,
  onChange,
  onHotReloadRules,
}: ComposedRulesTabsProps) {
  const [api, holder] = notification.useNotification();
  const [openedGroupID, setOpenedGroupID] = useState<string>(activeGroupId);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [hoveredRowID, setHoveredRowID] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draftItemsByGroup, setDraftItemsByGroup] = useState<Record<string, ComposedRuleItem[]>>({});
  const [draftGroupOrder, setDraftGroupOrder] = useState<string[] | null>(null);
  const [draftDeletedGroupIDs, setDraftDeletedGroupIDs] = useState<string[]>([]);
  const [draggingIDs, setDraggingIDs] = useState<string[]>([]);
  const [draggingGroupID, setDraggingGroupID] = useState<string>("");

  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<"add" | "edit">("add");
  const [editingGroupID, setEditingGroupID] = useState<string>("");
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRuleID, setEditingRuleID] = useState("");
  const [ruleDraft, setRuleDraft] = useState<ComposedRuleDraft>(() => buildDraft(1));
  const [hotReloading, setHotReloading] = useState(false);
  const [groupNameForm] = Form.useForm();

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

  const normalizedGroups = useMemo(() => normalizeGroups(groups), [groups]);
  const snapshotGroupOrder = useMemo(() => normalizedGroups.map((group) => group.id), [normalizedGroups]);
  const deletedGroupIDSet = useMemo(() => new Set(draftDeletedGroupIDs), [draftDeletedGroupIDs]);
  const visibleSnapshotGroupOrder = useMemo(
    () => snapshotGroupOrder.filter((groupID) => !deletedGroupIDSet.has(groupID)),
    [snapshotGroupOrder, deletedGroupIDSet],
  );
  const effectiveGroupOrder = useMemo(() => {
    if (
      draftGroupOrder &&
      sameStringMembers(draftGroupOrder, visibleSnapshotGroupOrder)
    ) {
      return draftGroupOrder;
    }
    return visibleSnapshotGroupOrder;
  }, [draftGroupOrder, visibleSnapshotGroupOrder]);
  const orderedGroups = useMemo(() => {
    const byID = new Map(normalizedGroups.map((group) => [group.id, group]));
    return effectiveGroupOrder
      .map((groupID) => byID.get(groupID))
      .filter((group): group is ComposedRuleGroup => Boolean(group));
  }, [effectiveGroupOrder, normalizedGroups]);

  useEffect(() => {
    setOpenedGroupID((previous) => {
      if (orderedGroups.some((group) => group.id === previous)) {
        return previous;
      }
      return orderedGroups[0]?.id ?? "default";
    });
  }, [orderedGroups]);

  const currentGroup = useMemo(
    () =>
      orderedGroups.find((group) => group.id === openedGroupID) ??
      orderedGroups[0] ?? {
        id: "default",
        name: "默认分组",
        mode: "proxy" as RuleApplyMode,
        items: [],
      },
    [orderedGroups, openedGroupID],
  );
  const effectiveItems = draftItemsByGroup[currentGroup.id] ?? currentGroup.items ?? [];
  const hasDraftItems = Object.keys(draftItemsByGroup).length > 0;
  const hasDraftGroupOrder =
    draftGroupOrder != null &&
    sameStringMembers(draftGroupOrder, visibleSnapshotGroupOrder) &&
    !sameStringArray(draftGroupOrder, visibleSnapshotGroupOrder);
  const hasDeletedGroups = draftDeletedGroupIDs.length > 0;
  const hasDraft = hasDraftItems || hasDraftGroupOrder || hasDeletedGroups;
  const hasDraftRef = useRef(false);

  useEffect(() => {
    if (draftGroupOrder && !sameStringMembers(draftGroupOrder, visibleSnapshotGroupOrder)) {
      setDraftGroupOrder(null);
    }
  }, [draftGroupOrder, visibleSnapshotGroupOrder]);

  useEffect(() => {
    setDraftDeletedGroupIDs((prev) => {
      const snapshotSet = new Set(snapshotGroupOrder);
      const next = prev.filter((groupID) => snapshotSet.has(groupID));
      return next.length === prev.length ? prev : next;
    });
  }, [snapshotGroupOrder]);

  const baseRuleNameByID = useMemo(() => {
    const mapping = new Map<string, string>();
    baseRules.forEach((item) => mapping.set(item.id, item.name || item.id));
    return mapping;
  }, [baseRules]);
  const baseRuleOptions = useMemo(
    () =>
      baseRules.map((item) => ({
        value: item.id,
        label: `${item.name} (${item.id})`,
      })),
    [baseRules],
  );

  const operationRuleIDs = useMemo(() => {
    if (selectedRowKeys.length > 0) {
      return selectedRowKeys;
    }
    if (contextMenu?.anchorRuleID) {
      return [contextMenu.anchorRuleID];
    }
    if (hoveredRowID) {
      return [hoveredRowID];
    }
    return [];
  }, [selectedRowKeys, contextMenu, hoveredRowID]);

  const commitGroupItems = useCallback((groupID: string, nextItems: ComposedRuleItem[]) => {
    setDraftItemsByGroup((prev) => ({
      ...prev,
      [groupID]: nextItems,
    }));
  }, []);

  const applyDraft = useCallback(async () => {
    if (!hasDraft) {
      return;
    }
    const byID = new Map(normalizedGroups.map((group) => [group.id, group]));
    const nextGroups: ComposedRuleGroup[] = [];
    for (const groupID of effectiveGroupOrder) {
      const base = byID.get(groupID);
      if (!base) {
        continue;
      }
      nextGroups.push({
        ...base,
        items: draftItemsByGroup[groupID] ?? base.items ?? [],
      });
    }
    if (nextGroups.length === 0) {
      return;
    }
    const nextActiveGroupID = nextGroups.some((group) => group.id === activeGroupId)
      ? activeGroupId
      : nextGroups[0].id;
    const saved = await onChange(nextGroups, nextActiveGroupID);
    if (!saved) {
      return;
    }
    setDraftItemsByGroup({});
    setDraftGroupOrder(null);
    setDraftDeletedGroupIDs([]);
    setDraggingIDs([]);
    setDraggingGroupID("");
  }, [activeGroupId, draftItemsByGroup, effectiveGroupOrder, hasDraft, normalizedGroups, onChange]);

  const discardDraft = useCallback(() => {
    setDraftItemsByGroup({});
    setDraftGroupOrder(null);
    setDraftDeletedGroupIDs([]);
    setDraggingIDs([]);
    setDraggingGroupID("");
  }, []);

  useEffect(() => {
    hasDraftRef.current = hasDraft;
  }, [hasDraft]);

  useEffect(() => {
    if (!hasDraft) {
      api.destroy(sortDraftNoticeKey);
      return;
    }
    api.open({
      key: sortDraftNoticeKey,
      placement: "topRight",
      duration: 0,
      closeIcon: null,
      message: "合成规则编辑草稿",
      description: (
        <div className="sort-draft-notice-content">
          <Typography.Text type="secondary">
            当前有未提交的分组/规则变更，请应用或取消。
          </Typography.Text>
          <Space className="sort-draft-notice-actions" size={10}>
            <Button
              size="large"
              shape="circle"
              className="sort-draft-apply-btn"
              icon={<CheckOutlined />}
              onClick={() => {
                void applyDraft();
              }}
            />
            <Button
              size="large"
              shape="circle"
              className="sort-draft-cancel-btn"
              icon={<CloseCircleOutlined />}
              onClick={discardDraft}
            />
          </Space>
        </div>
      ),
      className: "sort-draft-notification",
    });
  }, [api, hasDraft, applyDraft, discardDraft]);

  useEffect(() => {
    return () => {
      api.destroy(sortDraftNoticeKey);
      if (hasDraftRef.current) {
        api.warning({
          placement: "topRight",
          message: "排序编辑状态未保存",
          description: "你离开了规则页，合成规则草稿尚未应用或取消。",
        });
      }
    };
  }, [api]);

  const moveRows = (movingIDs: string[], targetID: string, placeAfter: boolean) => {
    const movingSet = new Set(movingIDs);
    const source = [...effectiveItems];
    const movingItems = source.filter((item) => movingSet.has(item.id));
    if (movingItems.length === 0) {
      return;
    }
    const remain = source.filter((item) => !movingSet.has(item.id));
    const targetIndex = remain.findIndex((item) => item.id === targetID);
    if (targetIndex < 0) {
      return;
    }
    const insertIndex = placeAfter ? targetIndex + 1 : targetIndex;
    const next = [...remain];
    next.splice(insertIndex, 0, ...movingItems);
    commitGroupItems(currentGroup.id, next);
  };

  const handleGroupDragStart = (groupID: string) => (event: DragEvent<HTMLElement>) => {
    setDraggingGroupID(groupID);
    event.dataTransfer.effectAllowed = "move";
  };

  const handleGroupDragOver = (groupID: string) => (event: DragEvent<HTMLElement>) => {
    if (draggingGroupID === "" || draggingGroupID === groupID) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleGroupDrop = (groupID: string) => (event: DragEvent<HTMLElement>) => {
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

  const columns: ColumnsType<ComposedRuleItem> = [
    {
      title: "",
      key: "drag",
      width: 38,
      render: () => (
        <span style={{ cursor: "grab", color: "#6a7a99" }}>
          <HolderOutlined />
        </span>
      ),
    },
    {
      title: "序号",
      key: "index",
      width: 68,
      render: (_value, _record, index) => index + 1,
    },
    {
      title: "名称",
      key: "name",
      width: 220,
      render: (_value, record) => record.name || baseRuleNameByID.get(record.baseRuleId) || record.id,
    },
    {
      title: "基础规则",
      key: "base",
      render: (_value, record) => baseRuleNameByID.get(record.baseRuleId) ?? record.baseRuleId,
    },
    {
      title: "启用",
      key: "enabled",
      width: 90,
      render: (_value, record) => (
        <Switch
          size="small"
          checked={record.enabled}
          onChange={(checked) => {
            const next = effectiveItems.map((item) =>
              item.id === record.id
                ? {
                    ...item,
                    enabled: checked,
                  }
                : item,
            );
            commitGroupItems(currentGroup.id, next);
          }}
        />
      ),
    },
  ];

  const contextItems: MenuProps["items"] = [
    {
      key: "delete",
      danger: true,
      label: `批量删除 (${operationRuleIDs.length})`,
      disabled: operationRuleIDs.length === 0,
    },
  ];

  const handleContextMenuClick: MenuProps["onClick"] = ({ key }) => {
    setContextMenu(null);
    if (key !== "delete" || operationRuleIDs.length === 0) {
      return;
    }
    commitGroupItems(
      currentGroup.id,
      effectiveItems.filter((item) => !operationRuleIDs.includes(item.id)),
    );
    setSelectedRowKeys((prev) => prev.filter((id) => !operationRuleIDs.includes(id)));
  };

  const openAddGroupModal = useCallback(() => {
    setGroupModalMode("add");
    setEditingGroupID("");
    groupNameForm.setFieldsValue({ name: "" });
    setAddGroupOpen(true);
  }, [groupNameForm]);

  const openEditGroupModal = useCallback(
    (group: ComposedRuleGroup) => {
      setGroupModalMode("edit");
      setEditingGroupID(group.id);
      groupNameForm.setFieldsValue({ name: group.name || group.id });
      setAddGroupOpen(true);
    },
    [groupNameForm],
  );

  const updateCurrentGroupMode = useCallback(
    (reversed: boolean) => {
      const nextMode = (reversed ? "direct" : "proxy") as RuleApplyMode;
      const nextGroups = normalizedGroups.map((group) =>
        group.id === currentGroup.id
          ? {
              ...group,
              mode: nextMode,
            }
          : group,
      );
      void onChange(nextGroups, activeGroupId);
    },
    [activeGroupId, currentGroup.id, normalizedGroups, onChange],
  );

  const triggerHotReloadRules = useCallback(async () => {
    if (hasDraft) {
      message.warning("请先应用或取消合成规则草稿后，再热更规则");
      return;
    }
    setHotReloading(true);
    try {
      const result = await onHotReloadRules();
      if (result.status === "noop") {
        message.info(result.message || "无需更新");
      } else {
        message.success(result.message || "规则已热更");
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "热更失败";
      message.error(`热更失败：${errorText}`);
    } finally {
      setHotReloading(false);
    }
  }, [hasDraft, onHotReloadRules]);

  return (
    <Space
      direction="vertical"
      size={10}
      style={{ width: "100%" }}
    >
      {holder}

      <Tabs
        className="rules-composed-tabs"
        tabBarExtraContent={{
          right: (
            <Space
              size={10}
              className="rules-composed-tabs-extra"
            >
              <Button
                className="rules-hot-reload-btn"
                loading={hotReloading}
                disabled={hasDraft}
                onClick={() => {
                  void triggerHotReloadRules();
                }}
              >
                热更规则
              </Button>
              <Button
                type="primary"
                onClick={() => {
                  setEditingRuleID("");
                  setRuleDraft(buildDraft(effectiveItems.length + 1));
                  setRuleModalOpen(true);
                }}
              >
                添加合成规则
              </Button>
              <Space
                size={6}
                className="rules-composed-reverse-switch"
              >
                <Switch
                  checked={currentGroup.mode === "direct"}
                  onChange={(checked) => updateCurrentGroupMode(checked)}
                />
                <Typography.Text>反转</Typography.Text>
                <Popover
                  trigger="click"
                  placement="rightTop"
                  title="配置说明"
                  content={
                    <div style={{ whiteSpace: "pre-line", maxWidth: 460, lineHeight: 1.5 }}>
                      {
                        "反转打开后，该分组所有基础规则支持反转的会反着执行，如原本代理的规则会变成直连，原本直连的规则会变成代理。（添加/编辑基础规则页面有*禁止反转*开关）"
                      }
                    </div>
                  }
                >
                  <QuestionCircleOutlined style={{ color: "#8c8c8c", cursor: "help" }} />
                </Popover>
              </Space>
            </Space>
          ),
        }}
        activeKey={currentGroup.id}
        onChange={(key) => {
          if (key === ADD_GROUP_KEY) {
            openAddGroupModal();
            return;
          }
          setOpenedGroupID(key);
          setSelectedRowKeys([]);
        }}
        items={[
          ...orderedGroups.map((group) => ({
            key: group.id,
            label: (
              <span
                className="group-tab-label"
                draggable
                onDragStart={handleGroupDragStart(group.id)}
                onDragOver={handleGroupDragOver(group.id)}
                onDrop={handleGroupDrop(group.id)}
                onDragEnd={() => {
                  setDraggingGroupID("");
                }}
              >
                {group.id !== activeGroupId ? (
                  <Button
                    type="primary"
                    size="small"
                    className="group-tab-activate-popover"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void onChange(normalizedGroups, group.id);
                    }}
                  >
                    激活
                  </Button>
                ) : null}
                <Typography.Text
                  className="group-tab-name"
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openEditGroupModal(group);
                  }}
                >
                  {group.name}
                </Typography.Text>
                {group.id === activeGroupId ? <span className="active-group-dot" /> : null}
                <Button
                  size="small"
                  type="text"
                  className="group-tab-close-btn"
                  icon={<CloseOutlined />}
                  disabled={orderedGroups.length <= 1}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    Modal.confirm({
                      title: `删除分组 ${group.name}?`,
                      content: `将删除该分组内 ${(group.items ?? []).length} 条合成规则。`,
                      okText: "删除",
                      cancelText: "取消",
                      onOk: () => {
                        const remainedIDs = effectiveGroupOrder.filter((groupID) => groupID !== group.id);
                        if (remainedIDs.length === 0) {
                          return;
                        }
                        setDraftDeletedGroupIDs((prev) =>
                          prev.includes(group.id) ? prev : [...prev, group.id],
                        );
                        setDraftItemsByGroup((prev) => {
                          const next = { ...prev };
                          delete next[group.id];
                          return next;
                        });
                        setDraftGroupOrder((prev) => {
                          if (!prev) {
                            return remainedIDs;
                          }
                          return prev.filter((item) => item !== group.id);
                        });
                        if (openedGroupID === group.id) {
                          setOpenedGroupID(remainedIDs[0] ?? "default");
                        }
                        setSelectedRowKeys([]);
                      },
                    });
                  }}
                />
              </span>
            ),
          })),
          {
            key: ADD_GROUP_KEY,
            label: (
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
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
            ),
          },
        ]}
      />

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
        <Table<ComposedRuleItem>
          className="rules-composed-table"
          rowKey="id"
          size="small"
          bordered
          pagination={false}
          columns={columns}
          dataSource={effectiveItems}
          rowSelection={{
            selectedRowKeys,
            columnWidth: 42,
            onChange: (keys) => {
              setSelectedRowKeys(keys.map((item) => String(item)));
            },
          }}
          onRow={(row) => ({
            draggable: true,
            onMouseEnter: () => {
              setHoveredRowID(row.id);
            },
            onMouseLeave: () => {
              setHoveredRowID((prev) => (prev === row.id ? "" : prev));
            },
            onDragStart: (event) => {
              const selected = selectedRowKeys.filter((id) => effectiveItems.some((item) => item.id === id));
              const moving = selected.length > 0 ? selected : [row.id];
              setDraggingIDs(moving);
              event.dataTransfer.effectAllowed = "move";
            },
            onDragOver: (event) => {
              if (draggingIDs.length === 0 || draggingIDs.includes(row.id)) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            },
            onDrop: (event) => {
              if (draggingIDs.length === 0 || draggingIDs.includes(row.id)) {
                return;
              }
              event.preventDefault();
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              const placeAfter = event.clientY >= rect.top + rect.height / 2;
              moveRows(draggingIDs, row.id, placeAfter);
              setDraggingIDs([]);
            },
            onDragEnd: () => {
              setDraggingIDs([]);
            },
          })}
        />
        {contextMenu ? (
          <Dropdown
            open
            trigger={[]}
            menu={{
              items: contextItems,
              onClick: handleContextMenuClick,
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
        title={groupModalMode === "edit" ? "编辑合成分组" : "添加合成分组"}
        open={addGroupOpen}
        okText="确定"
        cancelText="取消"
        onCancel={() => {
          setAddGroupOpen(false);
          setGroupModalMode("add");
          setEditingGroupID("");
          groupNameForm.resetFields();
        }}
        onOk={() => {
          void groupNameForm.validateFields().then((values) => {
            const name = String(values.name ?? "").trim();
            if (groupModalMode === "edit") {
              if (!editingGroupID) {
                setAddGroupOpen(false);
                setGroupModalMode("add");
                groupNameForm.resetFields();
                return;
              }
              const nextGroups = normalizedGroups.map((group) =>
                group.id === editingGroupID
                  ? {
                      ...group,
                      name: name || group.name || group.id,
                    }
                  : group,
              );
              void onChange(nextGroups, activeGroupId).then((saved) => {
                if (!saved) {
                  return;
                }
                setAddGroupOpen(false);
                setGroupModalMode("add");
                setEditingGroupID("");
                groupNameForm.resetFields();
              });
              return;
            }
            const nextID = `group-${Date.now()}`;
            const nextGroups = [
              ...normalizedGroups,
              {
                id: nextID,
                name: name || "新分组",
                mode: "proxy" as RuleApplyMode,
                items: [],
              },
            ];
            const nextActiveGroupID = nextGroups.some((item) => item.id === activeGroupId)
              ? activeGroupId
              : nextGroups[0].id;
            void onChange(nextGroups, nextActiveGroupID).then((saved) => {
              if (!saved) {
                return;
              }
              setAddGroupOpen(false);
              setGroupModalMode("add");
              setEditingGroupID("");
              groupNameForm.resetFields();
              setOpenedGroupID(nextID);
            });
          });
        }}
      >
        <Form
          form={groupNameForm}
          layout="vertical"
          requiredMark={false}
        >
          <Form.Item
            label={helpLabel(
              "分组名称",
              [
                "作用:",
                "- 作为合成规则 Tab 名称，便于区分不同规则方案。",
                "",
                "关联来源:",
                "- 基础规则右键“发送到合成规则”会显示这里的分组名称。",
              ].join("\n"),
            )}
            name="name"
            rules={[{ required: true, message: "请输入分组名称" }]}
          >
            <Input placeholder="例如：办公规则" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingRuleID ? "编辑合成规则" : "添加合成规则"}
        open={ruleModalOpen}
        okText="保存"
        cancelText="取消"
        onCancel={() => setRuleModalOpen(false)}
        onOk={() => {
          const nextItem: ComposedRuleItem = {
            id: ruleDraft.id.trim(),
            name: ruleDraft.name.trim(),
            baseRuleId: ruleDraft.baseRuleId.trim(),
            enabled: ruleDraft.enabled,
          };
          if (!nextItem.baseRuleId) {
            return;
          }
          let nextItems: ComposedRuleItem[] = [];
          if (editingRuleID) {
            nextItems = effectiveItems.map((item) => (item.id === editingRuleID ? nextItem : item));
          } else {
            nextItems = [...effectiveItems, nextItem];
          }
          commitGroupItems(currentGroup.id, nextItems);
          setEditingRuleID("");
          setRuleModalOpen(false);
        }}
      >
        <Form
          layout="vertical"
          requiredMark={false}
        >
          <Form.Item
            label={helpLabel(
              "名称（可选）",
              [
                "作用:",
                "- 用于覆盖显示名称；留空时自动使用基础规则名称。",
                "",
                "关联来源:",
                "- 关联“基础规则”字段，最终表格展示优先顺序：自定义名称 > 基础规则名称。",
              ].join("\n"),
            )}
          >
            <Input
              value={ruleDraft.name}
              onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })}
              placeholder="为空时使用基础规则名称"
            />
          </Form.Item>
          <Form.Item
            label={helpLabel(
              "基础规则",
              [
                "作用:",
                "- 选择一条基础规则作为当前合成规则引用对象。",
                "",
                "关联来源:",
                "- 关联“基础规则表”；若基础规则被删除，此处引用会失效。",
              ].join("\n"),
            )}
          >
            <Select
              value={ruleDraft.baseRuleId || undefined}
              options={baseRuleOptions}
              onChange={(value) => setRuleDraft({ ...ruleDraft, baseRuleId: String(value) })}
              placeholder="选择基础规则"
            />
          </Form.Item>
          <Form.Item
            label={helpLabel(
              "启用",
              [
                "作用:",
                "- 关闭后该行不参与最终规则生成。",
                "",
                "关联来源:",
                "- 仅对当前合成分组生效，不会改动基础规则本体。",
              ].join("\n"),
            )}
          >
            <Switch
              checked={ruleDraft.enabled}
              onChange={(checked) => setRuleDraft({ ...ruleDraft, enabled: checked })}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
