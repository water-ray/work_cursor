import { Button, Card, Col, Row, Space, Statistic, Tag, Typography } from "antd";

import { daemonApi } from "../../services/daemonApi";
import type { DaemonPageProps } from "../../app/types";

export function DashboardPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const activeGroup =
    snapshot?.groups.find((group) => group.id === snapshot.activeGroupId) ?? null;
  const selectedNode =
    activeGroup?.nodes.find((node) => node.id === snapshot?.selectedNodeId) ?? null;
  const hasSelectedNode = Boolean(selectedNode || snapshot?.selectedNodeId);
  const listenAddress = snapshot?.allowExternalConnections ? "0.0.0.0" : "127.0.0.1";
  const listenPort = snapshot?.localProxyPort ?? 1088;
  const proxySummary =
    snapshot?.proxyMode === "tun"
      ? "代理模式：虚拟网卡（TUN）"
      : snapshot?.proxyMode === "off"
        ? "代理模式：已关闭"
        : `代理模式：系统代理（${listenAddress}:${listenPort}）`;

  return (
    <Space
      direction="vertical"
      size={16}
      style={{ width: "100%" }}
    >
      <Card
        loading={loading}
      >
        <Space size={12}>
          <Tag color={snapshot?.connectionStage === "connected" ? "green" : "blue"}>
            {snapshot?.connectionStage ?? "idle"}
          </Tag>
          <Button
            type="primary"
            disabled={!hasSelectedNode || snapshot?.proxyMode === "off"}
            onClick={() => void runAction(() => daemonApi.startConnection())}
          >
            连接
          </Button>
          <Button onClick={() => void runAction(() => daemonApi.stopConnection())}>
            断开
          </Button>
          <Typography.Text type="secondary">
            {proxySummary}
          </Typography.Text>
        </Space>
      </Card>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic
              title="当前生效分组"
              value={activeGroup?.name || snapshot?.activeGroupId || "-"}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="内核版本"
              value={snapshot?.coreVersion || "-"}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="运行标签"
              value={snapshot?.runtimeLabel || "-"}
            />
          </Card>
        </Col>
      </Row>
      <Card>
        <Typography.Text>
          {selectedNode?.name ?? snapshot?.selectedNodeId ?? "尚未选择节点"}
        </Typography.Text>
      </Card>
    </Space>
  );
}
