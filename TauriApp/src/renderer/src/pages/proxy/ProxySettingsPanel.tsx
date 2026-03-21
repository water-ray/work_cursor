import {
  Alert,
  AutoComplete,
  Button,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import type {
  ConfigCatalog,
  ConfigCatalogEntry,
  ImportConfigSummary,
  ProxyMode,
  ProxyTunStack,
  TrafficMonitorIntervalSec,
} from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { DraftActionBar } from "../../components/draft/DraftActionBar";
import { HelpLabel } from "../../components/form/HelpLabel";
import { SwitchWithLabel } from "../../components/form/SwitchWithLabel";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../hooks/useDraftNotice";
import { daemonApi } from "../../services/daemonApi";
import { useSharedServiceActionState } from "../../services/sharedServiceAction";
import { syncLinuxSystemProxyWithFeedback } from "../../services/serviceControl";
import { BiIcon } from "../../components/icons/BiIcon";
import { isMobileRuntime } from "../../platform/runtimeStore";
import {
  getProxyPagePlatformAdapter,
  getProxyPagePlatformConfig,
  resolveProxyConfiguredMode,
} from "./proxyPagePlatform";

const defaultSniffTimeoutMs = 1000;
const defaultTunMtu = 1420;
const minTunMtu = 576;
const maxTunMtu = 9000;

const tunMtuPresetOptions: Array<{ value: string }> = [
  { value: "9000" },
  { value: "1460" },
  { value: "1420" },
  { value: "1400" },
  { value: "1360" },
  { value: "1280" },
];

const tunStackOptions: Array<{ value: ProxyTunStack; label: string }> = [
  { value: "system", label: "system（默认）" },
  { value: "mixed", label: "mixed" },
  { value: "gvisor", label: "gvisor" },
];

const trafficMonitorIntervalOptions: Array<{
  value: TrafficMonitorIntervalSec;
  label: string;
}> = [
  { value: 0, label: "关闭（0）" },
  { value: 1, label: "1 秒" },
  { value: 2, label: "2 秒" },
  { value: 5, label: "5 秒" },
];

type ConfigExportMode = "save_file" | "copy_file" | "copy_text";
type ConfigImportMode = "select_file" | "clipboard_file" | "clipboard_text";

function formatBytesToReadable(value: number | undefined): string {
  const normalized = Math.max(0, Math.trunc(Number(value ?? 0)));
  if (normalized >= 1024 * 1024) {
    return `${(normalized / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (normalized >= 1024) {
    return `${(normalized / 1024).toFixed(1)} KB`;
  }
  return `${normalized} B`;
}

function formatDateTime(value: number | undefined): string {
  const normalized = Number(value ?? 0);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "-";
  }
  return new Date(normalized).toLocaleString();
}

function defaultBackupFileName(): string {
  const now = new Date();
  const pad2 = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `wateray_${date}-${time}.json`;
}

function buildCatalogEntryLabel(entry: ConfigCatalogEntry): string {
  const sourceLabel =
    entry.source === "current_state"
      ? "[当前]"
      : entry.source === "system_default" || entry.source === "system_backup"
        ? "[系统]"
        : "[用户]";
  const description =
    (entry.description ?? "").trim() ||
    (entry.source === "current_state" ? "当前配置" : (entry.name ?? "").trim() || "未命名备份");
  const size = formatBytesToReadable(entry.sizeBytes);
  const time = formatDateTime(entry.updatedAtMs);
  return `${sourceLabel} ${description} [${time}] [${size}]`;
}

function buildConfigMergeSuccessMessage(
  prefix: string,
  summary: ImportConfigSummary | undefined,
): string {
  const parts: string[] = [];
  if ((summary?.addedSubscriptions ?? 0) > 0) {
    parts.push(`追加订阅 ${summary?.addedSubscriptions ?? 0}`);
  }
  if ((summary?.addedGroups ?? 0) > 0) {
    parts.push(`追加分组 ${summary?.addedGroups ?? 0}`);
  }
  if ((summary?.addedRuleGroups ?? 0) > 0) {
    parts.push(`追加规则分组 ${summary?.addedRuleGroups ?? 0}`);
  }
  if ((summary?.addedRules ?? 0) > 0) {
    parts.push(`追加规则 ${summary?.addedRules ?? 0}`);
  }
  if ((summary?.addedRulePolicyGroups ?? 0) > 0) {
    parts.push(`追加节点池 ${summary?.addedRulePolicyGroups ?? 0}`);
  }
  if ((summary?.addedRuleSetProviders ?? 0) > 0) {
    parts.push(`追加规则集 ${summary?.addedRuleSetProviders ?? 0}`);
  }
  if (parts.length === 0) {
    return prefix;
  }
  return `${prefix}（${parts.join("，")}）`;
}

function resolveTrafficMonitorIntervalSec(
  value: number | null | undefined,
): TrafficMonitorIntervalSec {
  if (value === 1 || value === 2 || value === 5) {
    return value;
  }
  return 0;
}

function resolveTunMtu(value: number | null | undefined): number {
  if (Number.isFinite(value) && (value ?? 0) >= minTunMtu && (value ?? 0) <= maxTunMtu) {
    return Math.trunc(value as number);
  }
  return defaultTunMtu;
}

function resolveTunStack(value: ProxyTunStack | null | undefined): ProxyTunStack {
  if (value === "mixed" || value === "gvisor" || value === "system") {
    return value;
  }
  return "system";
}

function resolveStrictRoute(value: boolean | null | undefined): boolean {
  return value !== false;
}

function parseTunMtuInputValue(value: string): number | null {
  const text = value.trim();
  if (text === "") {
    return null;
  }
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

export interface ProxySettingsPanelProps extends DaemonPageProps {}

export function ProxySettingsPanel({
  snapshot,
  loading,
  runAction,
}: ProxySettingsPanelProps) {
  const proxyPagePlatform = getProxyPagePlatformConfig();
  const supportsSniffOverrideDestination = proxyPagePlatform.supportsSniffOverrideDestination;
  const configActionSupported = !isMobileRuntime();
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const sharedServiceAction = useSharedServiceActionState();
  const [configuredProxyMode, setConfiguredProxyMode] = useState<ProxyMode>("tun");
  const [clearDNSCacheOnRestart, setClearDNSCacheOnRestart] = useState(false);
  const [updatingConfiguredProxyMode, setUpdatingConfiguredProxyMode] = useState(false);
  const [localProxyPort, setLocalProxyPort] = useState(1088);
  const [tunMtu, setTunMtu] = useState<number>(defaultTunMtu);
  const [tunMtuInput, setTunMtuInput] = useState<string>(String(defaultTunMtu));
  const [tunStack, setTunStack] = useState<ProxyTunStack>("system");
  const [strictRoute, setStrictRoute] = useState(true);
  const [allowExternalConnections, setAllowExternalConnections] = useState(false);
  const [sniffEnabled, setSniffEnabled] = useState(true);
  const [sniffOverrideDestination, setSniffOverrideDestination] = useState(true);
  const [sniffTimeoutMs, setSniffTimeoutMs] = useState<number>(defaultSniffTimeoutMs);
  const [blockQuic, setBlockQuic] = useState(true);
  const [blockUdp, setBlockUdp] = useState(false);
  const [trafficMonitorIntervalSec, setTrafficMonitorIntervalSec] =
    useState<TrafficMonitorIntervalSec>(0);
  const [proxyDraftDirty, setProxyDraftDirty] = useState(false);
  const [applyingProxyDraft, setApplyingProxyDraft] = useState(false);
  const [configCatalog, setConfigCatalog] = useState<ConfigCatalog | null>(null);
  const [configCatalogLoading, setConfigCatalogLoading] = useState(false);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [backupDescription, setBackupDescription] = useState("");
  const [backupFileName, setBackupFileName] = useState(defaultBackupFileName());
  const [backupIncludeSubscriptions, setBackupIncludeSubscriptions] = useState(false);
  const [backupIncludedRuleGroupIds, setBackupIncludedRuleGroupIds] = useState<string[]>([]);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [selectedRestoreEntryID, setSelectedRestoreEntryID] = useState("");
  const [restoringConfig, setRestoringConfig] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [selectedExportEntryID, setSelectedExportEntryID] = useState("");
  const [exportMode, setExportMode] = useState<ConfigExportMode>("save_file");
  const [exportingConfig, setExportingConfig] = useState(false);
  const [exportPreview, setExportPreview] = useState<{
    sizeBytes: number;
    tooLarge: boolean;
    warningLabel: string;
  } | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importMode, setImportMode] = useState<ConfigImportMode>("select_file");
  const [importingConfig, setImportingConfig] = useState(false);
  const proxyMode = snapshot?.proxyMode ?? "off";
  const serviceActionBusy =
    updatingConfiguredProxyMode || sharedServiceAction.kind !== "idle";
  const isServiceTransitioning =
    snapshot?.connectionStage === "connecting" ||
    snapshot?.connectionStage === "disconnecting" ||
    sharedServiceAction.kind === "start" ||
    sharedServiceAction.kind === "stop";
  const isProxyDisabledMode = proxyMode === "off";
  useDraftNavLock({
    lockClassName: "proxy-draft-nav-lock",
    enabled: proxyDraftDirty,
  });

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setConfiguredProxyMode(resolveProxyConfiguredMode(snapshot.configuredProxyMode));
    if (proxyDraftDirty) {
      return;
    }
    setClearDNSCacheOnRestart(snapshot.clearDNSCacheOnRestart === true);
    setLocalProxyPort(snapshot.localProxyPort);
    const nextTunMtu = resolveTunMtu(snapshot.tunMtu);
    setTunMtu(nextTunMtu);
    setTunMtuInput(String(nextTunMtu));
    setTunStack(resolveTunStack(snapshot.tunStack));
    setStrictRoute(resolveStrictRoute(snapshot.strictRoute));
    setAllowExternalConnections(snapshot.allowExternalConnections);
    setSniffEnabled(snapshot.sniffEnabled ?? true);
    setSniffOverrideDestination(snapshot.sniffOverrideDestination ?? true);
    setSniffTimeoutMs(snapshot.sniffTimeoutMs ?? defaultSniffTimeoutMs);
    setBlockQuic(snapshot.blockQuic ?? true);
    setBlockUdp(snapshot.blockUdp ?? false);
    setTrafficMonitorIntervalSec(
      resolveTrafficMonitorIntervalSec(snapshot.trafficMonitorIntervalSec),
    );
  }, [proxyDraftDirty, snapshot]);

  useEffect(() => {
    if (!exportModalOpen || selectedExportEntryID.trim() === "") {
      setExportPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await daemonApi.exportConfigContent({
          entryId: selectedExportEntryID,
        });
        if (cancelled) {
          return;
        }
        setExportPreview({
          sizeBytes: Math.max(0, Number(result.sizeBytes ?? 0)),
          tooLarge: result.tooLarge === true,
          warningLabel: (result.warningLabel ?? "").trim(),
        });
      } catch {
        if (!cancelled) {
          setExportPreview(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exportModalOpen, selectedExportEntryID]);

  const proxyDraftValidationIssues = useMemo(() => {
    const issues: string[] = [];
    if (localProxyPort < 1 || localProxyPort > 65535) {
      issues.push("本地监听端口需在 1~65535 之间");
    }
    if (tunMtu < minTunMtu || tunMtu > maxTunMtu) {
      issues.push(`TUN MTU 需在 ${minTunMtu}~${maxTunMtu} 之间`);
    }
    if (sniffTimeoutMs < 100 || sniffTimeoutMs > 10000) {
      issues.push("嗅探超时需在 100~10000ms 之间");
    }
    return issues;
  }, [localProxyPort, sniffTimeoutMs, tunMtu]);

  const canSubmitProxyDraft =
    proxyDraftDirty &&
    proxyDraftValidationIssues.length === 0 &&
    !applyingProxyDraft &&
    !serviceActionBusy &&
    !isServiceTransitioning;
  const canRevertProxyDraft =
    proxyDraftDirty && !applyingProxyDraft && !serviceActionBusy && !isServiceTransitioning;

  const restoreEntryOptions = useMemo(
    () =>
      (configCatalog?.restoreItems ?? []).map((entry) => ({
        value: entry.id,
        label: buildCatalogEntryLabel(entry),
      })),
    [configCatalog?.restoreItems],
  );

  const exportEntryOptions = useMemo(
    () =>
      (configCatalog?.exportItems ?? []).map((entry) => ({
        value: entry.id,
        label: buildCatalogEntryLabel(entry),
      })),
    [configCatalog?.exportItems],
  );

  const selectedRestoreEntry =
    (configCatalog?.restoreItems ?? []).find((item) => item.id === selectedRestoreEntryID) ??
    null;

  const backupRuleGroupOptions = useMemo(
    () =>
      (snapshot?.ruleConfigV2?.groups ?? []).map((group) => {
        const ruleCount = group.rules?.length ?? 0;
        const activeSuffix =
          group.id === snapshot?.ruleConfigV2?.activeGroupId ? "，当前激活" : "";
        return {
          value: group.id,
          label: `${group.name || group.id}（${ruleCount} 条规则${activeSuffix}）`,
        };
      }),
    [snapshot],
  );

  const updateConfiguredMode = async (checked: boolean) => {
    const nextMode: ProxyMode = checked ? "tun" : "system";
    const previousMode = configuredProxyMode;
    const shouldApplyRuntime = snapshot?.connectionStage === "connected" && proxyMode !== "off";
    setConfiguredProxyMode(nextMode);
    setUpdatingConfiguredProxyMode(true);
    try {
      const nextSnapshot = await runAction(() =>
        daemonApi.setSettings({
          proxyMode: nextMode,
          applyRuntime: shouldApplyRuntime,
        }),
      );
      await syncLinuxSystemProxyWithFeedback({
        snapshot: nextSnapshot,
        notice,
        actionLabel: "切换启动模式",
      });
      notice.success(
        shouldApplyRuntime
          ? checked
            ? "已切换为虚拟网卡模式，并自动刷新当前服务"
            : "已切换为系统代理模式，并自动刷新当前服务"
          : checked
            ? "默认启动模式已切换为虚拟网卡"
            : "默认启动模式已切换为系统代理",
      );
    } catch (error) {
      setConfiguredProxyMode(previousMode);
      notice.error(error instanceof Error ? error.message : "更新启动模式失败");
    } finally {
      setUpdatingConfiguredProxyMode(false);
    }
  };

  const loadConfigCatalog = async (): Promise<ConfigCatalog | null> => {
    setConfigCatalogLoading(true);
    try {
      const catalog = await daemonApi.getConfigCatalog();
      setConfigCatalog(catalog);
      return catalog;
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "加载配置目录失败");
      return null;
    } finally {
      setConfigCatalogLoading(false);
    }
  };

  const openBackupModal = () => {
    setBackupDescription("");
    setBackupFileName(defaultBackupFileName());
    setBackupIncludeSubscriptions(false);
    setBackupIncludedRuleGroupIds([]);
    setBackupModalOpen(true);
  };

  const openRestoreModal = async () => {
    const catalog = await loadConfigCatalog();
    if (!catalog) {
      return;
    }
    setSelectedRestoreEntryID(catalog.restoreItems[0]?.id ?? "");
    setRestoreModalOpen(true);
  };

  const openExportModal = async () => {
    const catalog = await loadConfigCatalog();
    if (!catalog) {
      return;
    }
    if ((catalog.exportItems ?? []).length === 0) {
      notice.warning("没有可导出的备份，请先创建备份");
      return;
    }
    setSelectedExportEntryID(catalog.exportItems[0]?.id ?? "");
    setExportMode("save_file");
    setExportPreview(null);
    setExportModalOpen(true);
  };

  const openImportModal = () => {
    setImportMode("select_file");
    setImportModalOpen(true);
  };

  const submitCreateBackup = async () => {
    const description = backupDescription.trim();
    if (!description) {
      notice.warning("备份描述不能为空");
      return;
    }
    const fileName = backupFileName.trim();
    if (!fileName) {
      notice.warning("备份文件名不能为空");
      return;
    }
    setCreatingBackup(true);
    try {
      const entry = await daemonApi.createConfigBackup({
        description,
        fileName,
        includeSubscriptionGroups: backupIncludeSubscriptions,
        includedRuleGroupIds: backupIncludedRuleGroupIds,
      });
      notice.success(`备份完成：${entry.fileName}`);
      setBackupModalOpen(false);
      setBackupDescription("");
      setBackupFileName(defaultBackupFileName());
      await loadConfigCatalog();
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "创建备份失败");
    } finally {
      setCreatingBackup(false);
    }
  };

  const submitRestoreConfig = async () => {
    const entryID = selectedRestoreEntryID.trim();
    if (!entryID) {
      notice.warning("请选择要恢复的配置项");
      return;
    }
    setRestoringConfig(true);
    try {
      let summary: ImportConfigSummary | undefined;
      let queued = false;
      await runAction(async () => {
        const result = await daemonApi.restoreConfig({ entryId: entryID });
        summary = result.summary;
        if (result.task && !result.summary) {
          queued = true;
          notice.info("恢复任务已加入后台执行，请稍候查看后台任务结果");
        }
        return result.snapshot;
      });
      if (!queued) {
        notice.success(buildConfigMergeSuccessMessage("配置恢复成功", summary));
        setRestoreModalOpen(false);
        await loadConfigCatalog();
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "恢复配置失败");
    } finally {
      setRestoringConfig(false);
    }
  };

  const fetchExportContent = async () => {
    const entryID = selectedExportEntryID.trim();
    if (!entryID) {
      throw new Error("请选择要导出的配置项");
    }
    const result = await daemonApi.exportConfigContent({ entryId: entryID });
    setExportPreview({
      sizeBytes: Math.max(0, Number(result.sizeBytes ?? 0)),
      tooLarge: result.tooLarge === true,
      warningLabel: (result.warningLabel ?? "").trim(),
    });
    return result;
  };

  const submitExportConfig = async () => {
    setExportingConfig(true);
    try {
      const result = await fetchExportContent();
      if (exportMode === "save_file") {
        const path = await getProxyPagePlatformAdapter().system.openExportSaveDialog(
          result.fileName || "waterayd_state.json",
        );
        if (!path) {
          notice.info("已取消导出");
          return;
        }
        await getProxyPagePlatformAdapter().system.writeTextFile(path, result.content);
        notice.success(`导出成功：${path}`);
        setExportModalOpen(false);
        return;
      }
      if (exportMode === "copy_file") {
        const tempPath = await getProxyPagePlatformAdapter().system.writeTempTextFile(
          result.fileName || "waterayd_state.json",
          result.content,
        );
        const response = await getProxyPagePlatformAdapter().system.writeClipboardFile(tempPath);
        if (response.mode === "windows_file_object") {
          notice.success("已复制文件到剪贴板，可直接粘贴发送");
        } else {
          notice.success("当前平台已降级为复制文件路径到剪贴板");
        }
        setExportModalOpen(false);
        return;
      }
      await getProxyPagePlatformAdapter().system.writeClipboardText(result.content);
      notice.success("配置内容已复制到剪贴板");
      setExportModalOpen(false);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "导出配置失败");
    } finally {
      setExportingConfig(false);
    }
  };

  const submitImportConfig = async () => {
    setImportingConfig(true);
    try {
      let content = "";
      if (importMode === "select_file") {
        const path = await getProxyPagePlatformAdapter().system.openImportFileDialog();
        if (!path) {
          notice.info("已取消导入");
          return;
        }
        content = await getProxyPagePlatformAdapter().system.readTextFile(path);
      } else if (importMode === "clipboard_file") {
        const filePaths = await getProxyPagePlatformAdapter().system.readClipboardFilePaths();
        const selectedPath = filePaths.find((item) => item.trim() !== "");
        if (!selectedPath) {
          notice.warning("剪贴板中没有可导入的文件");
          return;
        }
        content = await getProxyPagePlatformAdapter().system.readTextFile(selectedPath);
      } else {
        content = await getProxyPagePlatformAdapter().system.readClipboardText();
      }

      if (!content.trim()) {
        notice.warning("导入内容为空");
        return;
      }

      let summary: ImportConfigSummary | undefined;
      let queued = false;
      await runAction(async () => {
        const result = await daemonApi.importConfigContent(content);
        summary = result.summary;
        if (result.task && !result.summary) {
          queued = true;
          notice.info("导入任务已加入后台执行，请稍候查看后台任务结果");
        }
        return result.snapshot;
      });
      if (!queued) {
        notice.success(buildConfigMergeSuccessMessage("导入配置成功", summary));
        setImportModalOpen(false);
        await loadConfigCatalog();
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "导入配置失败");
    } finally {
      setImportingConfig(false);
    }
  };

  const submitProxyDraft = async () => {
    if (!snapshot) {
      return;
    }
    if (serviceActionBusy || isServiceTransitioning) {
      notice.warning("代理服务状态切换中，请稍后提交配置");
      return;
    }
    if (proxyDraftValidationIssues.length > 0) {
      notice.warning(proxyDraftValidationIssues[0]);
      return;
    }
    const snapshotTunMtu = resolveTunMtu(snapshot.tunMtu);
    const snapshotTunStack = resolveTunStack(snapshot.tunStack);
    const snapshotStrictRoute = resolveStrictRoute(snapshot.strictRoute);
    const snapshotTrafficMonitorIntervalSec = resolveTrafficMonitorIntervalSec(
      snapshot.trafficMonitorIntervalSec,
    );
    const settingsInput: Parameters<typeof daemonApi.setSettings>[0] = {};
    let settingsChanged = false;

    if (localProxyPort !== snapshot.localProxyPort) {
      settingsInput.localProxyPort = localProxyPort;
      settingsChanged = true;
    }
    if (allowExternalConnections !== snapshot.allowExternalConnections) {
      settingsInput.allowExternalConnections = allowExternalConnections;
      settingsChanged = true;
    }
    if (tunMtu !== snapshotTunMtu) {
      settingsInput.tunMtu = tunMtu;
      settingsChanged = true;
    }
    if (tunStack !== snapshotTunStack) {
      settingsInput.tunStack = tunStack;
      settingsChanged = true;
    }
    if (strictRoute !== snapshotStrictRoute) {
      settingsInput.strictRoute = strictRoute;
      settingsChanged = true;
    }
    if (sniffEnabled !== (snapshot.sniffEnabled ?? true)) {
      settingsInput.sniffEnabled = sniffEnabled;
      settingsChanged = true;
    }
    if (
      supportsSniffOverrideDestination &&
      sniffOverrideDestination !== (snapshot.sniffOverrideDestination ?? true)
    ) {
      settingsInput.sniffOverrideDestination = sniffOverrideDestination;
      settingsChanged = true;
    }
    if (sniffTimeoutMs !== (snapshot.sniffTimeoutMs ?? defaultSniffTimeoutMs)) {
      settingsInput.sniffTimeoutMs = sniffTimeoutMs;
      settingsChanged = true;
    }
    if (blockQuic !== (snapshot.blockQuic ?? true)) {
      settingsInput.blockQuic = blockQuic;
      settingsChanged = true;
    }
    if (blockUdp !== (snapshot.blockUdp ?? false)) {
      settingsInput.blockUdp = blockUdp;
      settingsChanged = true;
    }
    if (trafficMonitorIntervalSec !== snapshotTrafficMonitorIntervalSec) {
      settingsInput.trafficMonitorIntervalSec = trafficMonitorIntervalSec;
      settingsChanged = true;
    }
    if (clearDNSCacheOnRestart !== (snapshot.clearDNSCacheOnRestart === true)) {
      settingsInput.clearDNSCacheOnRestart = clearDNSCacheOnRestart;
      settingsChanged = true;
    }

    if (!settingsChanged) {
      setProxyDraftDirty(false);
      notice.info("没有可提交的配置变更");
      return;
    }

    settingsInput.applyRuntime =
      snapshot.connectionStage === "connected" && snapshot.proxyMode !== "off";

    setApplyingProxyDraft(true);
    try {
      const nextSnapshot = await runAction(() => daemonApi.setSettings(settingsInput));
      await syncLinuxSystemProxyWithFeedback({
        snapshot: nextSnapshot,
        notice,
        actionLabel: "保存代理配置",
      });
      setProxyDraftDirty(false);
      draftNotice.notifySaveSuccess("代理配置", nextSnapshot);
    } catch (error) {
      draftNotice.notifySaveFailed("代理配置", error);
    } finally {
      setApplyingProxyDraft(false);
    }
  };

  const revertProxyDraft = () => {
    if (!snapshot) {
      return;
    }
    setLocalProxyPort(snapshot.localProxyPort);
    const nextTunMtu = resolveTunMtu(snapshot.tunMtu);
    setTunMtu(nextTunMtu);
    setTunMtuInput(String(nextTunMtu));
    setTunStack(resolveTunStack(snapshot.tunStack));
    setStrictRoute(resolveStrictRoute(snapshot.strictRoute));
    setAllowExternalConnections(snapshot.allowExternalConnections);
    setSniffEnabled(snapshot.sniffEnabled ?? true);
    setSniffOverrideDestination(snapshot.sniffOverrideDestination ?? true);
    setSniffTimeoutMs(snapshot.sniffTimeoutMs ?? defaultSniffTimeoutMs);
    setBlockQuic(snapshot.blockQuic ?? true);
    setBlockUdp(snapshot.blockUdp ?? false);
    setTrafficMonitorIntervalSec(resolveTrafficMonitorIntervalSec(snapshot.trafficMonitorIntervalSec));
    setClearDNSCacheOnRestart(snapshot.clearDNSCacheOnRestart === true);
    setProxyDraftDirty(false);
    draftNotice.notifyDraftReverted("代理");
  };

  return (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      <DraftActionBar
        visible={proxyDraftDirty}
        apply={{
          title: "保存代理配置",
          label: "保存",
          icon: <BiIcon name="check-lg" />,
          disabled: !canSubmitProxyDraft,
          loading: applyingProxyDraft,
          onClick: () => {
            void submitProxyDraft();
          },
        }}
        discard={{
          title: "取消代理配置草稿",
          label: "取消",
          icon: <BiIcon name="emoji-frown-fill" />,
          disabled: !canRevertProxyDraft,
          onClick: revertProxyDraft,
        }}
      />
      {proxyDraftValidationIssues.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={proxyDraftValidationIssues[0]}
          description={proxyDraftValidationIssues.slice(1).join("；")}
        />
      ) : null}
      <SwitchWithLabel
        checked={proxyPagePlatform.fixedTunMode ? true : configuredProxyMode === "tun"}
        disabled={proxyPagePlatform.fixedTunMode || !snapshot || loading || serviceActionBusy}
        onChange={(checked) => {
          void updateConfiguredMode(checked);
        }}
        label={proxyPagePlatform.modeSwitchLabel}
        helpContent={proxyPagePlatform.modeSwitchHelpContent}
      />
      <SwitchWithLabel
        checked={clearDNSCacheOnRestart}
        disabled={!snapshot || loading || serviceActionBusy || applyingProxyDraft}
        onChange={(checked) => {
          setClearDNSCacheOnRestart(checked);
          setProxyDraftDirty(true);
        }}
        label="重启时清理DNS缓存"
        helpContent={{
          effect: "执行“重启服务”时先清理 DNS 缓存，再继续重启代理运行时。",
          recommendation: "频繁切换节点或 DNS 策略后建议开启，降低旧缓存干扰。",
        }}
      />
      <div className="proxy-settings-action-grid">
        <Button
          className="proxy-settings-action-btn"
          icon={<BiIcon name="upload" />}
          disabled={!configActionSupported || serviceActionBusy || isServiceTransitioning}
          onClick={() => {
            void openImportModal();
          }}
        >
          导入配置
        </Button>
        <Button
          className="proxy-settings-action-btn"
          icon={<BiIcon name="download" />}
          disabled={!configActionSupported || serviceActionBusy || isServiceTransitioning}
          onClick={() => {
            void openExportModal();
          }}
        >
          导出配置
        </Button>
        <Button
          className="proxy-settings-action-btn"
          icon={<BiIcon name="archive" />}
          disabled={!configActionSupported || serviceActionBusy || isServiceTransitioning}
          onClick={openBackupModal}
        >
          备份配置
        </Button>
        <Button
          className="proxy-settings-action-btn"
          icon={<BiIcon name="arrow-counterclockwise" />}
          disabled={!configActionSupported || serviceActionBusy || isServiceTransitioning}
          onClick={() => {
            void openRestoreModal();
          }}
        >
          恢复配置
        </Button>
      </div>
      {!configActionSupported ? (
        <Typography.Text type="secondary">
          移动端导入/导出/备份/恢复能力暂未接入原生文件系统，按钮先保留在这里作为占位。
        </Typography.Text>
      ) : null}
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <HelpLabel
          label="流量监控"
          helpContent={{
            scene: "需要查看实时速度与节点流量动态时开启。",
            effect: "按 1/2/5 秒采样连接流量并驱动状态面板与节点速度显示。",
            recommendation: "常驻建议 2 秒或 5 秒；仅排障时临时用 1 秒。",
          }}
        />
        <Select<TrafficMonitorIntervalSec>
          value={trafficMonitorIntervalSec}
          options={trafficMonitorIntervalOptions}
          style={{ width: "100%" }}
          disabled={applyingProxyDraft}
          onChange={(value) => {
            setTrafficMonitorIntervalSec(value);
            setProxyDraftDirty(true);
          }}
        />
      </Space>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <HelpLabel
          label="本地监听端口"
          helpContent={{
            scene: "系统代理模式或虚拟网卡模式下，需要开放本地代理给本机/局域网设备使用时。",
            effect: "决定本机 HTTP/SOCKS 代理入口端口（mixed 入站）。",
            caution: "端口被占用会导致代理启动失败；常用范围 1024 以上。",
          }}
        />
        <InputNumber
          min={1}
          max={65535}
          value={localProxyPort}
          style={{ width: "100%" }}
          disabled={!isProxyDisabledMode || serviceActionBusy || applyingProxyDraft}
          onChange={(value) => {
            setLocalProxyPort(value ?? 1088);
            setProxyDraftDirty(true);
          }}
        />
      </Space>
      <SwitchWithLabel
        checked={allowExternalConnections}
        disabled={!isProxyDisabledMode || serviceActionBusy || applyingProxyDraft}
        onChange={(checked) => {
          setAllowExternalConnections(checked);
          setProxyDraftDirty(true);
        }}
        label="允许外部设备连接"
        helpContent={{
          scene: "需要让局域网内其他设备通过本机代理上网。",
          effect: "监听地址从 127.0.0.1 扩展到 0.0.0.0。",
          caution: "会暴露代理入口，建议仅在受信任网络开启并配合防火墙策略。",
        }}
      />
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <HelpLabel
          label={<Typography.Text strong>虚拟网卡（TUN）</Typography.Text>}
          helpContent={{
            scene: "需要在 TUN 模式下优化吞吐、兼容性或稳定性。",
            effect: "控制 tun 入站的 mtu 与 stack 参数。",
            caution: "仅在虚拟网卡模式运行时生效；保存草稿后若当前代理正在运行，会自动刷新服务强制生效。",
          }}
        />
        <HelpLabel
          label="MTU"
          helpContent={{
            scene: "遇到网页卡住、TLS 握手慢、或大包路径不稳定时调优。",
            effect: "控制 TUN 数据包大小上限。",
            recommendation: "默认 1420，如果允许 QUIC(HTTP/3) 协议，可以适当降低到 1300。",
          }}
        />
        <AutoComplete
          options={tunMtuPresetOptions}
          value={tunMtuInput}
          style={{ width: "100%" }}
          placeholder="输入或选择 MTU"
          disabled={applyingProxyDraft}
          onChange={(value) => {
            setTunMtuInput(value);
            const text = value.trim();
            if (text === "") {
              setTunMtu(defaultTunMtu);
              setProxyDraftDirty(true);
              return;
            }
            const parsed = parseTunMtuInputValue(value);
            if (parsed === null) {
              return;
            }
            setTunMtu(parsed);
            setProxyDraftDirty(true);
          }}
          onSelect={(value) => {
            setTunMtuInput(value);
            const parsed = parseTunMtuInputValue(value);
            if (parsed === null) {
              return;
            }
            setTunMtu(parsed);
            setProxyDraftDirty(true);
          }}
          onBlur={() => {
            setTunMtuInput(String(tunMtu));
          }}
        />
        <HelpLabel
          label="协议栈（stack）"
          helpContent={{
            scene: "不同平台/网络环境下兼容性与性能调优。",
            effect: "指定 tun.stack（mixed/system/gvisor）。",
            recommendation: "默认使用 system；若需要折中兼容可试 mixed；遇到特定兼容问题可尝试 gvisor。",
          }}
        />
        <Select<ProxyTunStack>
          value={tunStack}
          options={tunStackOptions}
          style={{ width: "100%" }}
          disabled={applyingProxyDraft}
          onChange={(value) => {
            setTunStack(value);
            setProxyDraftDirty(true);
          }}
        />
        <SwitchWithLabel
          checked={strictRoute}
          disabled={applyingProxyDraft}
          onChange={(checked) => {
            setStrictRoute(checked);
            setProxyDraftDirty(true);
          }}
          label="严格路由（strict_route）"
          helpContent={{
            scene: "虚拟网卡模式下，希望严格由 tun 接管流量路由。",
            effect: "写入 tun.strict_route=true/false，减少部分流量绕过或回流异常。",
            recommendation: "默认开启；仅在特定网络环境兼容性异常时再尝试关闭。",
          }}
        />
      </Space>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <HelpLabel
          label={<Typography.Text strong>连接嗅探</Typography.Text>}
          helpContent={{
            scene: "希望按域名/协议做更准确分流（例如 SNI/Host 识别）。",
            effect: "解析连接早期特征，用于更精确的路由匹配。",
            caution: "会有少量性能开销；部分应用可能对嗅探更敏感。",
          }}
        />
        <SwitchWithLabel
          checked={sniffEnabled}
          disabled={applyingProxyDraft}
          onChange={(checked) => {
            setSniffEnabled(checked);
            setProxyDraftDirty(true);
          }}
          label="启用嗅探"
          helpContent={{
            scene: "规则依赖域名/协议信息时建议开启。",
            effect: "提取 TLS/HTTP/QUIC 等协议信息参与路由匹配。",
            caution: "关闭后很多基于域名的精细规则会退化。",
          }}
        />
        {supportsSniffOverrideDestination ? (
          <SwitchWithLabel
            checked={sniffOverrideDestination}
            disabled={!sniffEnabled || applyingProxyDraft}
            onChange={(checked) => {
              setSniffOverrideDestination(checked);
              setProxyDraftDirty(true);
            }}
            label="覆盖目标地址（sniff_override_destination）"
            helpContent={{
              scene: "目标地址是 IP 但实际请求有域名（SNI/Host）时。",
              effect: "用嗅探到的域名覆盖目标地址，提升域名规则命中率。",
              caution: "个别应用可能依赖原始目标地址，遇兼容性问题可尝试关闭。",
            }}
          />
        ) : (
          <Typography.Text type="secondary">
            当前桌面运行时暂不支持目标地址覆盖；桌面端仅保留嗅探与嗅探超时设置。
          </Typography.Text>
        )}
        <HelpLabel
          label="嗅探超时（毫秒）"
          helpContent={{
            scene: "平衡“规则命中准确性”和“首包速度”。",
            effect: "控制等待嗅探信息的时间窗口。",
            recommendation: "建议 500~2000ms；过小可能嗅探不全，过大可能增加首包延迟。",
          }}
        />
        <InputNumber
          min={100}
          max={10000}
          value={sniffTimeoutMs}
          style={{ width: "100%" }}
          disabled={applyingProxyDraft}
          onChange={(value) => {
            setSniffTimeoutMs(value ?? defaultSniffTimeoutMs);
            setProxyDraftDirty(true);
          }}
        />
      </Space>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <HelpLabel
          label={<Typography.Text strong>传输协议限制</Typography.Text>}
          helpContent={{
            scene: "优先保证网页稳定性，降低 QUIC/UDP 导致的抖动或复用残留问题。",
            effect: "在路由层注入高优先级拦截规则。",
            caution: "限制越强，兼容性越稳但实时性业务影响越大。",
          }}
        />
        <SwitchWithLabel
          checked={blockQuic}
          disabled={applyingProxyDraft}
          onChange={(checked) => {
            setBlockQuic(checked);
            setProxyDraftDirty(true);
          }}
          label="屏蔽 QUIC（默认开）"
          helpContent={{
            scene: "浏览器开启 HTTP/3（QUIC）后访问不稳定、节点 UDP 能力弱、切节点后出现窗口表现不一致。",
            effect: "优先拦截 QUIC 流量，强制回落到 TCP 路径，提升网页加载一致性。",
            caution: "启用后会影响依赖 QUIC 的业务（例如部分低延迟 UDP 业务）。",
          }}
        />
        <SwitchWithLabel
          checked={blockUdp}
          disabled={applyingProxyDraft}
          onChange={(checked) => {
            setBlockUdp(checked);
            setProxyDraftDirty(true);
          }}
          label="屏蔽 UDP（默认关）"
          helpContent={{
            scene: "需要最高稳定性优先，且可接受牺牲 UDP 业务。",
            effect: "直接阻断所有 UDP 流量（包括 UDP/443），可彻底规避 QUIC/UDP 相关不稳定问题。",
            caution: "会影响游戏、语音、部分实时应用；开启后通常无需再单独依赖“屏蔽 QUIC”。",
          }}
        />
      </Space>

      <Modal
        title="备份配置"
        open={backupModalOpen}
        onCancel={() => {
          if (creatingBackup) {
            return;
          }
          setBackupModalOpen(false);
        }}
        onOk={() => {
          void submitCreateBackup();
        }}
        okText="开始备份"
        cancelText="取消"
        confirmLoading={creatingBackup}
        destroyOnClose={false}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <Typography.Text strong>备份描述</Typography.Text>
            <Input
              value={backupDescription}
              maxLength={120}
              placeholder="请输入备份描述（必填）"
              disabled={creatingBackup}
              onChange={(event) => {
                setBackupDescription(event.target.value);
              }}
            />
          </div>
          <div>
            <Typography.Text strong>备份文件名</Typography.Text>
            <Input
              value={backupFileName}
              maxLength={200}
              placeholder="wateray_YYYYMMDD-HHmmss.json"
              disabled={creatingBackup}
              onChange={(event) => {
                setBackupFileName(event.target.value);
              }}
            />
          </div>
          <SwitchWithLabel
            checked={backupIncludeSubscriptions}
            disabled={creatingBackup}
            onChange={(checked) => {
              setBackupIncludeSubscriptions(checked);
            }}
            label="备份订阅分组"
            helpContent={{
              effect: "控制备份内容是否包含订阅源与订阅分组数据。",
              recommendation: "跨设备迁移建议开启；仅保留本地运行参数可关闭以减小备份体积。",
            }}
          />
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <Typography.Text strong>备份规则</Typography.Text>
              <Button
                size="small"
                disabled={creatingBackup || backupRuleGroupOptions.length === 0}
                onClick={() => {
                  setBackupIncludedRuleGroupIds(
                    backupRuleGroupOptions.map((item) => String(item.value)),
                  );
                }}
              >
                一键全选
              </Button>
            </div>
            <Select
              mode="multiple"
              allowClear
              showSearch
              value={backupIncludedRuleGroupIds}
              options={backupRuleGroupOptions}
              disabled={creatingBackup}
              placeholder="默认不备份规则；可多选规则分组"
              optionFilterProp="label"
              style={{ width: "100%" }}
              onChange={(value) => {
                setBackupIncludedRuleGroupIds(value);
              }}
            />
            <Typography.Text type="secondary">
              恢复/导入时，所选规则会按追加方式合并，规则 ID 会自动重生成避免冲突。
            </Typography.Text>
          </div>
        </Space>
      </Modal>

      <Modal
        title="恢复配置"
        open={restoreModalOpen}
        onCancel={() => {
          if (restoringConfig) {
            return;
          }
          setRestoreModalOpen(false);
        }}
        onOk={() => {
          void submitRestoreConfig();
        }}
        okText="恢复"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={restoringConfig}
        destroyOnClose={false}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Select
            showSearch
            value={selectedRestoreEntryID || undefined}
            options={restoreEntryOptions}
            loading={configCatalogLoading}
            placeholder="选择要恢复的配置"
            optionFilterProp="label"
            style={{ width: "100%" }}
            onChange={(value) => {
              setSelectedRestoreEntryID(value);
            }}
          />
          {!selectedRestoreEntry ? (
            <Typography.Text type="secondary">
              未找到可恢复项，请先创建备份。
            </Typography.Text>
          ) : null}
          <Typography.Text type="warning">
            恢复后会覆盖当前代理/DNS/订阅等配置；规则、规则分组、节点池与规则集采用追加合并，ID 自动重生成。
          </Typography.Text>
        </Space>
      </Modal>

      <Modal
        title="导出配置"
        open={exportModalOpen}
        onCancel={() => {
          if (exportingConfig) {
            return;
          }
          setExportModalOpen(false);
        }}
        onOk={() => {
          void submitExportConfig();
        }}
        okText="执行导出"
        cancelText="取消"
        confirmLoading={exportingConfig}
        destroyOnClose={false}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Select
            showSearch
            value={selectedExportEntryID || undefined}
            options={exportEntryOptions}
            loading={configCatalogLoading}
            placeholder="选择要导出的备份"
            optionFilterProp="label"
            style={{ width: "100%" }}
            onChange={(value) => {
              setSelectedExportEntryID(value);
            }}
          />
          <Radio.Group
            value={exportMode}
            onChange={(event) => {
              setExportMode(event.target.value as ConfigExportMode);
            }}
          >
            <Space direction="vertical">
              <Radio value="save_file">保存到本地文件</Radio>
              <Radio value="copy_file">复制文件到剪贴板</Radio>
              <Radio value="copy_text">复制配置内容</Radio>
            </Space>
          </Radio.Group>
          {exportPreview?.tooLarge ? (
            <Typography.Text type="danger">
              {exportPreview.warningLabel || "内容过大，不建议直接分享"}
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary">
            导出仅支持已创建的备份文件，不再支持当前配置的全量导出。
          </Typography.Text>
        </Space>
      </Modal>

      <Modal
        title="导入配置"
        open={importModalOpen}
        onCancel={() => {
          if (importingConfig) {
            return;
          }
          setImportModalOpen(false);
        }}
        onOk={() => {
          void submitImportConfig();
        }}
        okText="执行导入"
        cancelText="取消"
        confirmLoading={importingConfig}
        destroyOnClose={false}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Radio.Group
            value={importMode}
            onChange={(event) => {
              setImportMode(event.target.value as ConfigImportMode);
            }}
          >
            <Space direction="vertical">
              <Radio value="select_file">选择文件导入</Radio>
              <Radio value="clipboard_file">从复制文件导入</Radio>
              <Radio value="clipboard_text">从复制内容导入</Radio>
            </Space>
          </Radio.Group>
          <Typography.Text type="secondary">
            导入前会校验配置合法性；导入后默认覆盖当前配置，订阅分组与规则相关数据采用追加方式，ID 自动重生成。
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  );
}
