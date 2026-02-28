import {
  Button,
  Form,
  Input,
  Modal,
  Popover,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type { RulePolicyGroup, RuleNodeSelectStrategy, VpnNode } from "../../../../../shared/daemon";

interface NodePoolTableProps {
  value: RulePolicyGroup[];
  activeNodes: VpnNode[];
  onChange: (next: RulePolicyGroup[]) => Promise<boolean>;
}

type NodeRefType = "index" | "country" | "name";

interface NodePoolDraft {
  id: string;
  name: string;
  nodeSelectStrategy: RuleNodeSelectStrategy;
  refType: NodeRefType;
  nodesText: string;
}

const strictRefTypeOptions: Array<{ value: NodeRefType; label: string }> = [
  { value: "index", label: "序号" },
  { value: "country", label: "国家" },
  { value: "name", label: "名称" },
];

function helpLabel(label: string, helpText: string): ReactNode {
  return (
    <Space size={6}>
      <span>{label}</span>
      <Popover
        trigger="click"
        placement="rightTop"
        title="配置说明"
        content={
          <div style={{ whiteSpace: "pre-line", maxWidth: 420, lineHeight: 1.5 }}>
            {helpText}
          </div>
        }
      >
        <QuestionCircleOutlined style={{ color: "#8c8c8c", cursor: "help" }} />
      </Popover>
    </Space>
  );
}

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
      return "index";
  }
}

function inferDraftRefType(nodes: Array<{ type: string; node: string }>): NodeRefType {
  if (nodes.length === 0) {
    return "index";
  }
  return normalizeRefType(nodes[0]?.type ?? "index");
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
    nodeSelectStrategy: item.nodePool?.nodeSelectStrategy === "first" ? "first" : "fastest",
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
    nodeSelectStrategy: "fastest",
    refType: "index",
    nodesText: "",
  };
}

function toDraft(item: RulePolicyGroup): NodePoolDraft {
  const refs = item.nodePool?.nodes ?? [];
  const refType = inferDraftRefType(refs);
  return {
    id: item.id,
    name: item.name,
    nodeSelectStrategy: item.nodePool?.nodeSelectStrategy ?? "fastest",
    refType,
    nodesText: refs
      .map((ref) => ref.node.trim())
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

function valueHelpTextByType(refType: NodeRefType): string {
  switch (refType) {
    case "country":
      return [
        "通用说明:",
        "- 若“节点数组”留空，将默认使用当前激活订阅分组的全部节点。",
        "",
        "国家类型说明:",
        "- 每行一个国家代码或国家名。",
        "- 取值来源: 订阅/节点表格的“国家”列。",
        "- 示例: HK / JP / CN",
        "- 推荐填写大写国家缩写。",
      ].join("\n");
    case "name":
      return [
        "通用说明:",
        "- 若“节点数组”留空，将默认使用当前激活订阅分组的全部节点。",
        "",
        "名称类型说明:",
        "- 每行一个名称关键词，按“名称包含”匹配。",
        "- 取值来源: 订阅/节点表格的“名称”列。",
        "- 示例: 高级节点01 / 测试节点 / abc节点",
      ].join("\n");
    default:
      return [
        "通用说明:",
        "- 若“节点数组”留空，将默认使用当前激活订阅分组的全部节点。",
        "",
        "序号类型说明:",
        "- 每行一个节点序号（从 1 开始）。",
        "- 取值来源: 订阅/节点表格的“序号”列。",
        "- 示例: 1 / 2 / 03",
      ].join("\n");
  }
}

function valuePlaceholderByType(refType: NodeRefType): string {
  switch (refType) {
    case "country":
      return "HK\nJP\nCN";
    case "name":
      return "高级节点01\n测试节点\nabc节点";
    default:
      return "1\n2\n03";
  }
}

export function NodePoolTable({ value, activeNodes, onChange }: NodePoolTableProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingID, setEditingID] = useState<string>("");
  const [draft, setDraft] = useState<NodePoolDraft>(() => buildEmptyDraft());

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

  const replacePools = (nextPools: RulePolicyGroup[]): Promise<boolean> => {
    return onChange(mergeNodePoolsIntoGroups(value, nextPools));
  };

  const columns: ColumnsType<RulePolicyGroup> = [
    {
      title: "策略组ID",
      dataIndex: "id",
      key: "id",
      width: 220,
    },
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 220,
    },
    {
      title: "节点选择策略",
      key: "strategy",
      width: 140,
      render: (_value, record) =>
        record.nodePool?.nodeSelectStrategy === "first" ? "first" : "fastest",
    },
    {
      title: "节点池内容",
      key: "refs",
      render: (_value, record) => {
        const refs = record.nodePool?.nodes ?? [];
        if (refs.length === 0) {
          return <Typography.Text type="secondary">未配置</Typography.Text>;
        }
        return (
          <Space size={[4, 4]} wrap>
            {refs.slice(0, 6).map((ref, index) => (
              <Tag key={`${record.id}-${index}`}>{`${ref.type}:${ref.node}`}</Tag>
            ))}
            {refs.length > 6 ? <Tag>+{refs.length - 6}</Tag> : null}
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
              setDraftNodePools((prev) => prev.filter((item) => item.id !== record.id));
              setDraftTouched(true);
            }}
          >
            <Button
              type="link"
              danger
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const saveDraft = () => {
    const name = draft.name.trim();
    if (!name) {
      message.error("策略组名称不能为空");
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
      const preferredID = name;
      if (preferredID !== "" && !usedIDs.has(preferredID.toLowerCase())) {
        id = preferredID;
      } else {
        id = buildRandomPoolID(usedIDs);
        if (preferredID !== "") {
          message.info("策略组名称不可直接作为ID，已自动生成随机ID");
        }
      }
    }
    if (!id) {
      id = buildRandomPoolID(usedIDs);
    }
    if (usedIDs.has(id.toLowerCase())) {
      message.error("策略组ID已存在（大小写不区分），且不能与内置策略组重名");
      return;
    }
    const refs = splitNodeLines(draft.nodesText).map((item) => ({
      type: draft.refType,
      node: item,
    }));
    const nextItem: RulePolicyGroup = {
      id,
      name,
      type: "node_pool",
      nodePool: {
        nodeSelectStrategy: draft.nodeSelectStrategy,
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

  return (
    <Space
      direction="vertical"
      size={12}
      style={{ width: "100%" }}
    >
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Typography.Text strong>节点池(策略组)管理</Typography.Text>
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
      {hasDraftChanges ? (
        <Space style={{ width: "100%", justifyContent: "center" }} size={10}>
          <Button
            type="primary"
            onClick={() => {
              void replacePools(draftNodePools).then((saved) => {
                if (!saved) {
                  return;
                }
                setDraftTouched(false);
                message.success("节点池修改已提交");
              });
            }}
          >
            提交修改
          </Button>
          <Button
            onClick={() => {
              setDraftNodePools(snapshotNodePools);
              setDraftTouched(false);
              message.info("已取消节点池草稿修改");
            }}
          >
            取消修改
          </Button>
        </Space>
      ) : null}
      <Typography.Text type="secondary">
        当前活动分组节点数：{activeNodes.length}。节点池可按序号(index)、国家(country)、名称(name)从活动分组筛选候选节点。
      </Typography.Text>
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
          <Space
            size={12}
            style={{ width: "100%" }}
          >
            <Form.Item
              label={helpLabel(
                "策略组ID",
                [
                  "要求与作用:",
                  "- 新增时在点击“保存”后自动生成，作为规则 targetPolicy 引用键。",
                  "- 优先使用“策略组名称”原文作为ID（支持中文/符号）。",
                  "- 如名称不可用（冲突/保留字），自动生成随机英文+数字ID。",
                  "- 全局唯一（大小写不区分）。",
                  "- 不能与内置策略组重名：direct / proxy / reject。",
                  "",
                  "建议:",
                  "- 添加后保持稳定，不随意修改。",
                ].join("\n"),
              )}
              style={{ flex: 1 }}
            >
              <Input
                value={editingID ? draft.id : "保存时自动生成"}
                disabled
                placeholder="自动生成"
              />
            </Form.Item>
            <Form.Item
              label={helpLabel(
                "策略组名称",
                [
                  "作用:",
                  "- 用于页面展示和识别，不参与内核匹配。",
                  "",
                  "建议:",
                  "- 使用业务语义命名，如 美国节点池。",
                ].join("\n"),
              )}
              style={{ flex: 1 }}
            >
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="例如: 美国节点池"
              />
            </Form.Item>
            <Form.Item
              label={helpLabel(
                "节点选择策略",
                [
                  "作用:",
                  "- fastest: 候选中优先选择当前更优节点。",
                  "- first: 固定选择候选列表第一个节点。",
                ].join("\n"),
              )}
              style={{ width: 200 }}
            >
              <Select<RuleNodeSelectStrategy>
                value={draft.nodeSelectStrategy}
                options={[
                  { value: "fastest", label: "fastest" },
                  { value: "first", label: "first" },
                ]}
                onChange={(value) => setDraft({ ...draft, nodeSelectStrategy: value })}
              />
            </Form.Item>
          </Space>

          <Form.Item
            label={helpLabel(
              "节点类型",
              [
                "选择一类匹配方式后，第三行按该类型逐行填写值。",
                "",
                "- 序号: 使用订阅/节点表格“序号”的行号（从1开始）。",
                "- 国家: 使用订阅/节点表格“国家”简称（如 HK / JP / CN）。",
                "- 名称: 使用订阅/节点表格“名称”列关键词，按包含匹配。",
              ].join("\n"),
            )}
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
            label={helpLabel("节点数组（每行一个节点）", valueHelpTextByType(draft.refType))}
          >
            <Input.TextArea
              rows={8}
              value={draft.nodesText}
              onChange={(event) => setDraft({ ...draft, nodesText: event.target.value })}
              placeholder={valuePlaceholderByType(draft.refType)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
