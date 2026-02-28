import {
  App as AntdApp,
  Button,
  Card,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import type { ProxyMode } from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { daemonApi } from "../../services/daemonApi";

type SelectableProxyMode = Exclude<ProxyMode, "off">;

const defaultSniffTimeoutMs = 1000;

const proxyModeOptions: Array<{ value: SelectableProxyMode; label: string }> = [
  { value: "system", label: "系统代理" },
  { value: "tun", label: "虚拟网卡" },
];

export function ProxyPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const { message } = AntdApp.useApp();
  const [proxyEnabled, setProxyEnabled] = useState<boolean>(true);
  const [proxyMode, setProxyMode] = useState<SelectableProxyMode>("system");
  const [localProxyPort, setLocalProxyPort] = useState<number>(1088);
  const [allowExternalConnections, setAllowExternalConnections] =
    useState<boolean>(false);
  const [modeDirty, setModeDirty] = useState(false);
  const [listenDirty, setListenDirty] = useState(false);
  const [sniffEnabled, setSniffEnabled] = useState<boolean>(true);
  const [sniffOverrideDestination, setSniffOverrideDestination] =
    useState<boolean>(true);
  const [sniffTimeoutMs, setSniffTimeoutMs] = useState<number>(
    defaultSniffTimeoutMs,
  );
  const [sniffDirty, setSniffDirty] = useState(false);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (!modeDirty) {
      setProxyEnabled(snapshot.proxyMode !== "off");
      setProxyMode(snapshot.proxyMode === "tun" ? "tun" : "system");
    }
    if (!listenDirty) {
      setLocalProxyPort(snapshot.localProxyPort);
      setAllowExternalConnections(snapshot.allowExternalConnections);
    }
    if (!sniffDirty) {
      setSniffEnabled(snapshot.sniffEnabled ?? true);
      setSniffOverrideDestination(snapshot.sniffOverrideDestination ?? true);
      setSniffTimeoutMs(snapshot.sniffTimeoutMs ?? defaultSniffTimeoutMs);
    }
  }, [snapshot, modeDirty, listenDirty, sniffDirty]);

  const effectiveListenAddress = allowExternalConnections ? "0.0.0.0" : "127.0.0.1";
  const modeToSave: ProxyMode = proxyEnabled ? proxyMode : "off";
  const isSystemDraftMode = proxyMode === "system";
  const canApplyMode = modeDirty;
  const canApplyListen = listenDirty;
  const canApplySniff =
    sniffDirty && sniffTimeoutMs >= 100 && sniffTimeoutMs <= 10000;

  const modeDescription = useMemo(() => {
    if (!proxyEnabled) {
      return "代理开关关闭后，会停用当前代理模式。";
    }
    switch (proxyMode) {
      case "system":
        return "系统代理：启动本地代理监听，并设置系统 HTTP/HTTPS 代理。";
      case "tun":
        return "虚拟网卡：通过 TUN 接管流量（通常需要管理员权限）。";
      default:
        return "";
    }
  }, [proxyEnabled, proxyMode]);

  const applyProxyMode = async () => {
    try {
      const next = await runAction(() =>
        daemonApi.setSettings({
          proxyMode: modeToSave,
        }),
      );

      if (!proxyEnabled) {
        await runAction(() => daemonApi.stopConnection());
        setModeDirty(false);
        message.success("已关闭代理");
        return;
      }

      if (!next.selectedNodeId) {
        setModeDirty(false);
        message.warning("代理模式已保存，请先在订阅页面选择节点后再连接");
        return;
      }

      if (next.connectionStage !== "connected") {
        await runAction(() => daemonApi.startConnection());
      }
      setModeDirty(false);
      message.success("代理模式已应用");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "应用代理模式失败");
    }
  };

  const applyListenSettings = async () => {
    try {
      await runAction(() =>
        daemonApi.setSettings({
          localProxyPort,
          allowExternalConnections,
        }),
      );
      setListenDirty(false);
      message.success("监听配置已更新");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "修改监听失败");
    }
  };

  const applySniffSettings = async () => {
    if (sniffTimeoutMs < 100 || sniffTimeoutMs > 10000) {
      message.warning("嗅探超时需在 100~10000ms 之间");
      return;
    }
    try {
      await runAction(() =>
        daemonApi.setSettings({
          sniffEnabled,
          sniffOverrideDestination,
          sniffTimeoutMs,
        }),
      );
      setSniffDirty(false);
      message.success("嗅探配置已应用");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "应用嗅探配置失败");
    }
  };

  return (
    <Card
      loading={loading}
    >
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <Space size={8}>
          <Typography.Text strong>当前状态</Typography.Text>
          <Tag color={snapshot?.connectionStage === "connected" ? "green" : "blue"}>
            {snapshot?.connectionStage ?? "idle"}
          </Tag>
        </Space>

        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Space size={12}>
            <Typography.Text>启用代理</Typography.Text>
            <Switch
              checked={proxyEnabled}
              onChange={(checked) => {
                setProxyEnabled(checked);
                setModeDirty(true);
              }}
            />
          </Space>
          <Typography.Text>代理模式</Typography.Text>
          <Select<SelectableProxyMode>
            value={proxyMode}
            options={proxyModeOptions}
            style={{ width: 260 }}
            onChange={(value) => {
              setProxyMode(value);
              setModeDirty(true);
            }}
          />
          <Typography.Text type="secondary">{modeDescription}</Typography.Text>
          <Button
            type="primary"
            disabled={!canApplyMode}
            onClick={() => void applyProxyMode()}
          >
            应用模式
          </Button>
        </Space>

        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Typography.Text>本地监听端口</Typography.Text>
          <InputNumber
            min={1}
            max={65535}
            value={localProxyPort}
            style={{ width: 260 }}
            disabled={!proxyEnabled || !isSystemDraftMode}
            onChange={(value) => {
              setLocalProxyPort(value ?? 1088);
              setListenDirty(true);
            }}
          />
          <Typography.Text type="secondary">
            当前监听：{effectiveListenAddress}:{localProxyPort}
          </Typography.Text>
        </Space>

        <Space size={12}>
          <Typography.Text>允许外部设备连接</Typography.Text>
          <Switch
            checked={allowExternalConnections}
            disabled={!proxyEnabled || !isSystemDraftMode}
            onChange={(checked) => {
              setAllowExternalConnections(checked);
              setListenDirty(true);
            }}
          />
        </Space>

        <Space size={8}>
          <Button
            type="primary"
            disabled={!canApplyListen}
            onClick={() => void applyListenSettings()}
          >
            修改监听
          </Button>
        </Space>

        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Typography.Text strong>连接嗅探</Typography.Text>
          <Space size={12}>
            <Typography.Text>启用嗅探</Typography.Text>
            <Switch
              checked={sniffEnabled}
              onChange={(checked) => {
                setSniffEnabled(checked);
                setSniffDirty(true);
              }}
            />
          </Space>
          <Space size={12}>
            <Typography.Text>覆盖目标地址（sniff_override_destination）</Typography.Text>
            <Switch
              checked={sniffOverrideDestination}
              disabled={!sniffEnabled}
              onChange={(checked) => {
                setSniffOverrideDestination(checked);
                setSniffDirty(true);
              }}
            />
          </Space>
          <Typography.Text>嗅探超时（毫秒）</Typography.Text>
          <InputNumber
            min={100}
            max={10000}
            value={sniffTimeoutMs}
            style={{ width: 260 }}
            onChange={(value) => {
              setSniffTimeoutMs(value ?? defaultSniffTimeoutMs);
              setSniffDirty(true);
            }}
          />
          <Typography.Text type="secondary">
            建议值 500~2000ms。覆盖目标开启后，命中到域名时会优先按域名路由。
          </Typography.Text>
          <Button
            type="primary"
            disabled={!canApplySniff}
            onClick={() => void applySniffSettings()}
          >
            应用嗅探
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
