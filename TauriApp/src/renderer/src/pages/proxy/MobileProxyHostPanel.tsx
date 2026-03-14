import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import type { WaterayMobileHostStatus } from "../../platform/mobileHost";

const storageKeyConfig = "wateray.mobile.debug.config";
const storageKeyProfileName = "wateray.mobile.debug.profileName";

const defaultProfileName = "Wateray Mobile";
const defaultDebugConfig = `{
  "log": {
    "level": "info"
  },
  "dns": {
    "servers": [
      {
        "tag": "cloudflare",
        "address": "https://1.1.1.1/dns-query",
        "detour": "direct"
      }
    ],
    "final": "cloudflare"
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "interface_name": "wateray-tun",
      "mtu": 1500,
      "address": [
        "172.19.0.1/30",
        "fdfe:dcba:9876::1/126"
      ],
      "auto_route": true,
      "strict_route": false,
      "stack": "system",
      "sniff": true
    }
  ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    },
    {
      "type": "block",
      "tag": "block"
    }
  ],
  "route": {
    "auto_detect_interface": true,
    "final": "direct"
  }
}`;

const emptyStatus: WaterayMobileHostStatus = {
  state: "idle",
  runtimeMode: "off",
  permissionGranted: false,
  systemDnsServers: [],
  serviceRunning: false,
  nativeReady: false,
  tunReady: false,
  profileName: null,
  configDigest: null,
  lastError: null,
  startedAtMs: null,
  updatedAtMs: 0,
};

function readLocalStorage(key: string, fallbackValue: string): string {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim() !== "" ? value : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage write failures on restricted WebView environments.
  }
}

function formatTimestamp(value: number | null | undefined): string {
  const timestamp = Number(value ?? 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "-";
  }
  return new Date(timestamp).toLocaleString("zh-CN");
}

function resolveStatusColor(state: WaterayMobileHostStatus["state"]): string {
  switch (state) {
    case "running":
      return "green";
    case "starting":
    case "stopping":
      return "blue";
    case "error":
      return "red";
    case "stopped":
      return "default";
    default:
      return "gold";
  }
}

export function MobileProxyHostPanel() {
  const notice = useAppNotice();
  const mobileHost = window.waterayPlatform.mobileHost;
  const [status, setStatus] = useState<WaterayMobileHostStatus>(emptyStatus);
  const [busy, setBusy] = useState(false);
  const [configJson, setConfigJson] = useState<string>(() =>
    readLocalStorage(storageKeyConfig, defaultDebugConfig),
  );
  const [profileName, setProfileName] = useState<string>(() =>
    readLocalStorage(storageKeyProfileName, defaultProfileName),
  );

  useEffect(() => {
    writeLocalStorage(storageKeyConfig, configJson);
  }, [configJson]);

  useEffect(() => {
    writeLocalStorage(storageKeyProfileName, profileName);
  }, [profileName]);

  useEffect(() => {
    if (!mobileHost) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void mobileHost
      .getStatus()
      .then((next) => {
        if (!disposed) {
          setStatus(next);
        }
      })
      .catch((error) => {
        if (!disposed) {
          notice.error(error instanceof Error ? error.message : "读取移动端宿主状态失败");
        }
      });

    void mobileHost.onStatusChanged((next) => {
      if (!disposed) {
        setStatus(next);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unsubscribe = dispose;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [mobileHost, notice]);

  const canOperate = mobileHost !== null && !busy;
  const trimmedConfigJson = configJson.trim();
  const statusText = useMemo(() => {
    switch (status.state) {
      case "running":
        return "运行中";
      case "starting":
        return "启动中";
      case "stopping":
        return "停止中";
      case "stopped":
        return "已停止";
      case "error":
        return "错误";
      default:
        return "待命";
    }
  }, [status.state]);

  const refreshStatus = async () => {
    if (!mobileHost) {
      return;
    }
    const next = await mobileHost.getStatus();
    setStatus(next);
  };

  const runBusyAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const handlePrepare = () => {
    if (!mobileHost) {
      return;
    }
    void runBusyAction(async () => {
      const result = await mobileHost.prepare();
      setStatus(result.status);
      if (result.granted) {
        notice.success("Android VPN 权限已就绪");
        return;
      }
      notice.info("Android VPN 权限尚未授权");
    });
  };

  const handleValidate = () => {
    if (!mobileHost) {
      return;
    }
    void runBusyAction(async () => {
      if (trimmedConfigJson === "") {
        notice.error("请先输入 sing-box 配置 JSON");
        return;
      }
      const result = await mobileHost.checkConfig(trimmedConfigJson);
      setStatus(result.status);
      notice.success(`配置校验通过，libbox 版本：${result.version}`);
    });
  };

  const handleStart = () => {
    if (!mobileHost) {
      return;
    }
    void runBusyAction(async () => {
      if (trimmedConfigJson === "") {
        notice.error("请先输入 sing-box 配置 JSON");
        return;
      }
      const nextStatus = await mobileHost.start({
        configJson: trimmedConfigJson,
        profileName: profileName.trim() || defaultProfileName,
      });
      setStatus(nextStatus);
      notice.success("移动端原生宿主已接收启动请求");
    });
  };

  const handleStop = () => {
    if (!mobileHost) {
      return;
    }
    void runBusyAction(async () => {
      const nextStatus = await mobileHost.stop();
      setStatus(nextStatus);
      notice.success("移动端原生宿主停止请求已发送");
    });
  };

  const handleRefresh = () => {
    void runBusyAction(async () => {
      await refreshStatus();
    });
  };

  if (!mobileHost) {
    return (
      <Alert
        type="error"
        showIcon
        message="当前运行环境没有移动端原生宿主桥"
      />
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="当前页面处于 Android 原生宿主调试模式"
        description="这一步先验证 libbox + VpnService + 前端桥是否正常工作。桌面端逻辑不受影响，后续再把节点/规则/订阅编排接到这个宿主。"
      />

      {status.lastError ? (
        <Alert
          type="warning"
          showIcon
          message="最近一次宿主错误"
          description={status.lastError}
        />
      ) : null}

      <Card title="移动端原生代理宿主">
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="状态">
              <Tag color={resolveStatusColor(status.state)}>{statusText}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="VPN 权限">
              {status.permissionGranted ? "已授权" : "未授权"}
            </Descriptions.Item>
            <Descriptions.Item label="native 就绪">
              {status.nativeReady ? "已接入" : "未接入"}
            </Descriptions.Item>
            <Descriptions.Item label="TUN 就绪">
              {status.tunReady ? "已建立" : "未建立"}
            </Descriptions.Item>
            <Descriptions.Item label="配置摘要">
              {status.configDigest || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="配置名">
              {status.profileName || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="启动时间">
              {formatTimestamp(status.startedAtMs)}
            </Descriptions.Item>
            <Descriptions.Item label="最后更新">
              {formatTimestamp(status.updatedAtMs)}
            </Descriptions.Item>
          </Descriptions>

          <Input
            value={profileName}
            onChange={(event) => {
              setProfileName(event.target.value);
            }}
            placeholder="移动端配置名称"
          />

          <Input.TextArea
            value={configJson}
            onChange={(event) => {
              setConfigJson(event.target.value);
            }}
            autoSize={{ minRows: 16, maxRows: 28 }}
            spellCheck={false}
            placeholder="在这里粘贴 sing-box JSON 配置"
            styles={{
              textarea: {
                fontFamily: "Consolas, Menlo, monospace",
              },
            }}
          />

          <Space wrap>
            <Button onClick={handleRefresh} disabled={!canOperate}>
              刷新状态
            </Button>
            <Button onClick={handlePrepare} disabled={!canOperate}>
              准备 VPN 权限
            </Button>
            <Button onClick={handleValidate} disabled={!canOperate}>
              校验配置
            </Button>
            <Button
              type="primary"
              onClick={handleStart}
              disabled={!canOperate || trimmedConfigJson === ""}
            >
              启动原生代理
            </Button>
            <Button
              danger
              onClick={handleStop}
              disabled={!canOperate}
            >
              停止
            </Button>
          </Space>

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            默认示例配置会把 Android VPN 流量经 `sing-box tun + direct` 直连转发，用来验证原生宿主链路是否成立。接入真实节点后，再把这里替换成正式生成的运行配置。
          </Typography.Paragraph>
        </Space>
      </Card>
    </Space>
  );
}
