import {
  Card,
  Empty,
  Pagination,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import type { LogLevel, RuntimeLogEntry } from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { SwitchWithLabel } from "../../components/form/SwitchWithLabel";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { daemonApi } from "../../services/daemonApi";

type LogTabKey = "proxy" | "core" | "ui";
const logPageSizeBytes = 10 * 1024;
const textEncoder = new TextEncoder();

const levelOptions: Array<{ value: LogLevel; label: string }> = [
  { value: "none", label: "none" },
  { value: "error", label: "error" },
  { value: "warn", label: "warn" },
  { value: "info", label: "info" },
  { value: "debug", label: "debug" },
  { value: "trace", label: "trace" },
];

function levelTagColor(level: LogLevel): string {
  switch (level) {
    case "error":
      return "red";
    case "warn":
      return "orange";
    case "info":
      return "blue";
    case "debug":
      return "purple";
    case "trace":
      return "default";
    default:
      return "default";
  }
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

function estimateLogEntryBytes(entry: RuntimeLogEntry): number {
  const line = `${formatTimestamp(entry.timestampMs)} [${entry.level}] ${entry.message}\n`;
  return textEncoder.encode(line).length;
}

function splitLogPages(logs: RuntimeLogEntry[], maxBytesPerPage: number): RuntimeLogEntry[][] {
  if (logs.length === 0) {
    return [];
  }
  const pages: RuntimeLogEntry[][] = [];
  let current: RuntimeLogEntry[] = [];
  let currentBytes = 0;
  for (const entry of logs) {
    const entryBytes = estimateLogEntryBytes(entry);
    if (current.length > 0 && currentBytes+entryBytes > maxBytesPerPage) {
      pages.push(current);
      current = [entry];
      currentBytes = entryBytes;
      continue;
    }
    current.push(entry);
    currentBytes += entryBytes;
  }
  if (current.length > 0) {
    pages.push(current);
  }
  return pages;
}

export function LogsPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const notice = useAppNotice();
  const [activeTab, setActiveTab] = useState<LogTabKey>("proxy");
  const [activePage, setActivePage] = useState<number>(1);
  const [proxyLevelDraft, setProxyLevelDraft] = useState<LogLevel>("info");
  const [coreLevelDraft, setCoreLevelDraft] = useState<LogLevel>("info");
  const [uiLevelDraft, setUiLevelDraft] = useState<LogLevel>("info");
  const [updatingLevel, setUpdatingLevel] = useState(false);
  const [updatingRecordToFile, setUpdatingRecordToFile] = useState(false);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setProxyLevelDraft(snapshot.proxyLogLevel);
    setCoreLevelDraft(snapshot.coreLogLevel);
    setUiLevelDraft(snapshot.uiLogLevel);
  }, [snapshot]);

  const activeLogs = useMemo<RuntimeLogEntry[]>(() => {
    if (!snapshot) {
      return [];
    }
    const proxyLogs = snapshot.proxyLogs ?? [];
    const coreLogs = snapshot.coreLogs ?? [];
    const uiLogs = snapshot.uiLogs ?? [];
    switch (activeTab) {
      case "proxy":
        return [...proxyLogs].reverse();
      case "core":
        return [...coreLogs].reverse();
      case "ui":
        return [...uiLogs].reverse();
      default:
        return [];
    }
  }, [snapshot, activeTab]);

  const activeLevelDraft = useMemo<LogLevel>(() => {
    switch (activeTab) {
      case "proxy":
        return proxyLevelDraft;
      case "core":
        return coreLevelDraft;
      case "ui":
        return uiLevelDraft;
      default:
        return "info";
    }
  }, [activeTab, proxyLevelDraft, coreLevelDraft, uiLevelDraft]);

  const activeRecordToFile = useMemo<boolean>(() => {
    if (!snapshot) {
      return true;
    }
    const fallback = snapshot.recordLogsToFile ?? true;
    switch (activeTab) {
      case "proxy":
        return snapshot.proxyRecordLogsToFile ?? fallback;
      case "core":
        return snapshot.coreRecordLogsToFile ?? fallback;
      case "ui":
        return snapshot.uiRecordLogsToFile ?? fallback;
      default:
        return fallback;
    }
  }, [snapshot, activeTab]);

  const logPages = useMemo(
    () => splitLogPages(activeLogs, logPageSizeBytes),
    [activeLogs],
  );
  const totalPages = Math.max(1, logPages.length);
  const currentPage = Math.min(activePage, totalPages);
  const pagedLogs = logPages[currentPage - 1] ?? [];

  useEffect(() => {
    setActivePage(1);
  }, [activeTab]);

  useEffect(() => {
    if (activePage <= totalPages) {
      return;
    }
    setActivePage(totalPages);
  }, [activePage, totalPages]);

  const applyLevelInstant = async (tab: LogTabKey, level: LogLevel) => {
    if (updatingLevel) {
      return;
    }
    setUpdatingLevel(true);
    try {
      switch (tab) {
        case "proxy":
          await runAction(() =>
            daemonApi.setSettings({
              proxyLogLevel: level,
            }),
          );
          break;
        case "core":
          await runAction(() =>
            daemonApi.setSettings({
              coreLogLevel: level,
            }),
          );
          break;
        case "ui":
          await runAction(() =>
            daemonApi.setSettings({
              uiLogLevel: level,
            }),
          );
          break;
        default:
          break;
      }
      notice.success("日志等级已更新");
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "更新日志等级失败");
      if (snapshot) {
        setProxyLevelDraft(snapshot.proxyLogLevel);
        setCoreLevelDraft(snapshot.coreLogLevel);
        setUiLevelDraft(snapshot.uiLogLevel);
      }
    } finally {
      setUpdatingLevel(false);
    }
  };

  const updateRecordLogsToFile = async (tab: LogTabKey, enabled: boolean) => {
    if (updatingRecordToFile) {
      return;
    }
    setUpdatingRecordToFile(true);
    try {
      switch (tab) {
        case "proxy":
          await runAction(() =>
            daemonApi.setSettings({
              proxyRecordLogsToFile: enabled,
            }),
          );
          notice.success(enabled ? "已开启代理日志保存" : "已关闭代理日志保存");
          break;
        case "core":
          await runAction(() =>
            daemonApi.setSettings({
              coreRecordLogsToFile: enabled,
            }),
          );
          notice.success(enabled ? "已开启内核日志保存" : "已关闭内核日志保存");
          break;
        case "ui":
          await runAction(() =>
            daemonApi.setSettings({
              uiRecordLogsToFile: enabled,
            }),
          );
          notice.success(enabled ? "已开启UI日志保存" : "已关闭UI日志保存");
          break;
        default:
          break;
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "更新日志文件记录开关失败");
    } finally {
      setUpdatingRecordToFile(false);
    }
  };

  return (
    <Card
      loading={loading}
    >
      <Space
        direction="vertical"
        size={12}
        style={{ width: "100%" }}
      >
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as LogTabKey)}
          items={[
            { key: "proxy", label: "代理日志" },
            { key: "core", label: "内核日志" },
            { key: "ui", label: "UI日志" },
          ]}
        />

        <Space size={8}>
          <Typography.Text>日志等级</Typography.Text>
          <Select<LogLevel>
            value={activeLevelDraft}
            style={{ width: 150 }}
            options={levelOptions}
            disabled={updatingLevel}
            onChange={(value) => {
              switch (activeTab) {
                case "proxy":
                  setProxyLevelDraft(value);
                  void applyLevelInstant("proxy", value);
                  break;
                case "core":
                  setCoreLevelDraft(value);
                  void applyLevelInstant("core", value);
                  break;
                case "ui":
                  setUiLevelDraft(value);
                  void applyLevelInstant("ui", value);
                  break;
                default:
                  break;
              }
            }}
          />
          <SwitchWithLabel
            checked={activeRecordToFile}
            loading={updatingRecordToFile}
            onChange={(checked) => {
              void updateRecordLogsToFile(activeTab, checked);
            }}
            label="保存日志"
          />
          
        </Space>

        {activeLogs.length === 0 ? (
          <Empty description="暂无日志数据" />
        ) : (
          <div>
            <div
              style={{
                marginBottom: 8,
              }}
            >
              <Pagination
                current={currentPage}
                total={Math.max(logPages.length, 1)}
                pageSize={1}
                showSizeChanger={false}
                onChange={(page) => setActivePage(page)}
                showTotal={(total) => `第 ${currentPage}/${total} 页（每页最多 10KB）`}
              />
            </div>
            <div
              style={{
                maxHeight: 520,
                overflowY: "auto",
                border: "1px solid #eceef2",
                borderRadius: 8,
                padding: 10,
                background: "#fff",
              }}
            >
              <Space
                direction="vertical"
                size={8}
                style={{ width: "100%" }}
              >
                {pagedLogs.map((entry, index) => (
                  <div
                    key={`${entry.timestampMs}-${index}`}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "#f7f8fa",
                    }}
                  >
                    <Space
                      wrap
                      size={8}
                    >
                      <Typography.Text type="secondary">
                        {formatTimestamp(entry.timestampMs)}
                      </Typography.Text>
                      <Tag color={levelTagColor(entry.level)}>{entry.level}</Tag>
                      <Typography.Text>{entry.message}</Typography.Text>
                    </Space>
                  </div>
                ))}
              </Space>
            </div>
          </div>
        )}
      </Space>
    </Card>
  );
}
