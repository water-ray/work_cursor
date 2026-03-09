import { Alert, Button, Card, Descriptions, Space, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";

import { apiClient } from "../api/client";
import { bridgeAvailable, reportClientDebugNotice, requestBridge } from "../bridge/clientBridge";
import type { UserConfigData } from "../types";

interface ExportClientConfigResult {
  content: string;
}

interface ImportClientConfigResult {
  applied: boolean;
  queued?: boolean;
}

function formatContentSize(content: string): string {
  const sizeBytes = new TextEncoder().encode(content).length;
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${sizeBytes} B`;
}

export function ConfigPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [configData, setConfigData] = useState<UserConfigData | null>(null);
  const [error, setError] = useState("");

  const loadCloudConfig = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const config = await apiClient.getUserConfig();
      setConfigData(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取云端配置失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCloudConfig();
  }, [loadCloudConfig]);

  const embeddedMode = bridgeAvailable();

  return (
    <Card
      title="配置云端管理"
      extra={
        <Button onClick={() => void loadCloudConfig()} loading={loading}>
          刷新云端状态
        </Button>
      }
    >
      {!embeddedMode ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前不在客户端内嵌模式，无法直接操作本地 VPN 客户端配置"
        />
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={error}
        />
      ) : null}

      <Descriptions bordered column={1} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="云端版本">
          {configData ? String(configData.version) : "暂无"}
        </Descriptions.Item>
        <Descriptions.Item label="最后更新时间">
          {configData ? new Date(configData.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "暂无"}
        </Descriptions.Item>
      </Descriptions>

      <Space wrap>
        <Button
          type="primary"
          loading={saving}
          disabled={!embeddedMode}
          onClick={async () => {
            setSaving(true);
            try {
              await reportClientDebugNotice({
                level: "info",
                title: "云端配置",
                content: "开始导出当前客户端配置，准备上传到云端",
              });
              const result = await requestBridge<ExportClientConfigResult>("exportClientConfig");
              if (!result.content || result.content.trim() === "") {
                throw new Error("客户端当前配置为空");
              }
              await reportClientDebugNotice({
                level: "info",
                title: "云端配置",
                content: `桥接导出成功，准备上传到云端（大小 ${formatContentSize(result.content)}）`,
              });
              await apiClient.uploadUserConfig(result.content);
              await loadCloudConfig();
              await reportClientDebugNotice({
                level: "success",
                title: "云端配置",
                content: "云端配置保存成功",
              });
              message.success("已上传当前客户端配置到云端");
            } catch (err) {
              await reportClientDebugNotice({
                level: "error",
                title: "云端配置",
                content: `上传云端配置失败：${err instanceof Error ? err.message : "上传配置失败"}`,
              });
              message.error(err instanceof Error ? err.message : "上传配置失败");
            } finally {
              setSaving(false);
            }
          }}
        >
          上传当前 VPN 客户端配置到云端
        </Button>

        <Button
          loading={applying}
          disabled={!embeddedMode}
          onClick={async () => {
            setApplying(true);
            try {
              await reportClientDebugNotice({
                level: "info",
                title: "云端配置",
                content: "开始读取云端配置，准备覆盖当前客户端配置",
              });
              const cloudConfig = await apiClient.getUserConfig();
              if (!cloudConfig || !cloudConfig.content || cloudConfig.content.trim() === "") {
                throw new Error("云端暂无可下载配置");
              }
              await reportClientDebugNotice({
                level: "info",
                title: "云端配置",
                content: `云端配置读取成功，准备写回客户端（大小 ${formatContentSize(cloudConfig.content)}）`,
              });
              const bridgeResult = await requestBridge<ImportClientConfigResult>("importClientConfig", {
                content: cloudConfig.content,
              });
              if (bridgeResult.queued) {
                await reportClientDebugNotice({
                  level: "warning",
                  title: "云端配置",
                  content: "导入任务已进入队列，需等待代理服务停止后自动执行",
                });
                message.warning("导入任务已进入队列；若代理服务正在运行，请先停止代理后自动执行。");
              } else {
                await reportClientDebugNotice({
                  level: "success",
                  title: "云端配置",
                  content: "云端配置已提交客户端覆盖并热更",
                });
                message.success("已覆盖当前客户端配置并提交热更");
              }
            } catch (err) {
              await reportClientDebugNotice({
                level: "error",
                title: "云端配置",
                content: `下载并覆盖失败：${err instanceof Error ? err.message : "下载并覆盖失败"}`,
              });
              message.error(err instanceof Error ? err.message : "下载并覆盖失败");
            } finally {
              setApplying(false);
            }
          }}
        >
          下载云端配置并覆盖当前客户端配置
        </Button>
      </Space>

      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
        上传会保存完整当前配置快照（含规则与节点池）；覆盖操作由内核执行热更并持久化。
      </Typography.Paragraph>
    </Card>
  );
}
