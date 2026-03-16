import {
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DraftActionBar } from "../../components/draft/DraftActionBar";
import { BiIcon } from "../../components/icons/BiIcon";
import { HelpLabel } from "../../components/form/HelpLabel";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../hooks/useDraftNotice";
import { useAppUpdate } from "../../hooks/useAppUpdate";

import type { DaemonPageProps } from "../../app/types";
import {
  type CloseBehavior,
  readCloseBehavior,
  writeCloseBehavior,
} from "../../app/settings/uiPreferences";
import {
  bundledSingBoxVersion,
  bundledWaterayVersion,
} from "../../app/version/generatedKernelVersions";
import { getRuntimePlatform, isMobileRuntime } from "../../platform/runtimeStore";
import { daemonApi } from "../../services/daemonApi";
import type { DaemonSnapshot, RuleSetLocalStatus } from "../../../../shared/daemon";
import type { AppUpdateCandidate, AppUpdateStage } from "../../updates/types";
import { ProxySettingsPanel } from "../proxy/ProxySettingsPanel";
const geoIPRuleSetOptions = [
  { value: "cn", label: "cn（中国大陆）" },
  { value: "us", label: "us（美国）" },
  { value: "jp", label: "jp（日本）" },
  { value: "hk", label: "hk（中国香港）" },
  { value: "tw", label: "tw（中国台湾）" },
  { value: "sg", label: "sg（新加坡）" },
  { value: "kr", label: "kr（韩国）" },
  { value: "de", label: "de（德国）" },
  { value: "gb", label: "gb（英国）" },
  { value: "ru", label: "ru（俄罗斯）" },
] as const;
const geoSiteRuleSetOptions = [
  { value: "category-ads-all", label: "category-ads-all（广告拦截全量）" },
  { value: "category-ads", label: "category-ads（广告拦截）" },
  { value: "adguard", label: "adguard（AdGuard 广告域名）" },
  { value: "easylist", label: "easylist（EasyList 广告域名）" },
  { value: "cn", label: "cn（中国大陆域名）" },
  { value: "geolocation-!cn", label: "geolocation-!cn（非中国大陆域名）" },
  { value: "tld-cn", label: "tld-cn（中国大陆顶级域）" },
  { value: "google", label: "google" },
  { value: "google@cn", label: "google@cn" },
  { value: "apple", label: "apple" },
  { value: "apple@cn", label: "apple@cn" },
  { value: "telegram", label: "telegram" },
  { value: "youtube", label: "youtube" },
  { value: "github", label: "github" },
  { value: "category-games@cn", label: "category-games@cn（国区游戏）" },
  { value: "steam@cn", label: "steam@cn（Steam 国区）" },
] as const;

type RuleSetDownloadMode = "direct" | "proxy";
type RuleSetKind = "geoip" | "geosite";
type RuleSetTransientStatus = "idle" | "queued" | "downloading" | "failed";
const maxRuleSetBatchSize = 5;

function ruleSetStatusKey(kind: RuleSetKind, value: string): string {
  return `${kind}:${value}`.toLowerCase();
}

function formatRuleSetUpdatedTime(timestampMs?: number): string {
  if (!timestampMs || timestampMs <= 0) {
    return "";
  }
  return new Date(timestampMs).toLocaleString();
}

function formatUpdateCheckedTime(timestampMs?: number): string {
  if (!timestampMs || timestampMs <= 0) {
    return "";
  }
  return new Date(timestampMs).toLocaleString();
}

function describeUpdateInstallKind(kind: string): string {
  switch (kind) {
    case "portable-zip":
      return "便携整包";
    case "deb":
      return ".deb 安装包";
    case "appimage":
      return "AppImage";
    default:
      return "未完成";
  }
}

function describeUpdateAssetKind(kind: string): string {
  switch (kind) {
    case "portable-zip":
      return "便携整包";
    case "deb":
      return "Debian/Ubuntu 安装包";
    case "appimage":
      return "AppImage";
    default:
      return "未知";
  }
}

function describeUpdateStage(stage: AppUpdateStage): string {
  switch (stage) {
    case "checking":
      return "正在检查";
    case "available":
      return "可更新";
    case "no_update":
      return "已是最新";
    case "downloading":
      return "下载中";
    case "downloaded":
      return "已就绪";
    case "installing":
      return "安装中";
    case "unsupported":
      return "功能未完成";
    case "error":
      return "出现错误";
    default:
      return "待检查";
  }
}

function normalizeKernelVersionLabel(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (normalized === "" || /^(unknown|unlinked|libbox|daemon)$/i.test(normalized)) {
    return "-";
  }
  return normalized;
}

function resolveKernelVersionLabel(
  runtimeValue: string | null | undefined,
  fallbackValue: string | null | undefined,
): string {
  const runtimeLabel = normalizeKernelVersionLabel(runtimeValue);
  if (runtimeLabel !== "-") {
    return runtimeLabel;
  }
  return normalizeKernelVersionLabel(fallbackValue);
}

export function SettingsPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const isMobile = isMobileRuntime();
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const appUpdate = useAppUpdate();
  const [appliedCloseBehavior, setAppliedCloseBehavior] = useState<CloseBehavior>(() =>
    readCloseBehavior(),
  );
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>(() =>
    readCloseBehavior(),
  );
  const [settingsDraftTouched, setSettingsDraftTouched] = useState<boolean>(false);
  const [applyingSettingsDraft, setApplyingSettingsDraft] = useState(false);
  const [ruleSetModalOpen, setRuleSetModalOpen] = useState(false);
  const [selectedGeoIPRuleSets, setSelectedGeoIPRuleSets] = useState<string[]>([]);
  const [selectedGeoSiteRuleSets, setSelectedGeoSiteRuleSets] = useState<string[]>([]);
  const [ruleSetDownloadMode, setRuleSetDownloadMode] = useState<RuleSetDownloadMode>("direct");
  const [ruleSetStatuses, setRuleSetStatuses] = useState<Record<string, RuleSetLocalStatus>>({});
  const [ruleSetTransientStatuses, setRuleSetTransientStatuses] = useState<
    Record<string, RuleSetTransientStatus>
  >({});
  const [ruleSetDownloadProgress, setRuleSetDownloadProgress] = useState<{
    total: number;
    completed: number;
    success: number;
    failed: number;
  } | null>(null);
  const [loadingRuleSetStatuses, setLoadingRuleSetStatuses] = useState(false);
  const [updatingRuleSets, setUpdatingRuleSets] = useState(false);
  const [exemptingLoopback, setExemptingLoopback] = useState(false);
  const [mobileVersionLabels, setMobileVersionLabels] = useState<{
    wateray: string;
    singbox: string;
  } | null>(null);

  const settingsDraftDirty = !isMobile && closeBehavior !== appliedCloseBehavior;

  useEffect(() => {
    const initialCloseBehavior = readCloseBehavior();
    setAppliedCloseBehavior(initialCloseBehavior);
    setCloseBehavior(initialCloseBehavior);
  }, []);

  useEffect(() => {
    if (!snapshot || settingsDraftTouched) {
      return;
    }
    const currentCloseBehavior = readCloseBehavior();
    setAppliedCloseBehavior(currentCloseBehavior);
    setCloseBehavior(currentCloseBehavior);
  }, [snapshot, settingsDraftTouched]);

  useDraftNavLock({
    lockClassName: "settings-draft-nav-lock",
    enabled: settingsDraftDirty,
  });

  useEffect(() => {
    if (!settingsDraftDirty && settingsDraftTouched) {
      setSettingsDraftTouched(false);
    }
  }, [settingsDraftDirty, settingsDraftTouched]);

  useEffect(() => {
    if (!isMobile) {
      setMobileVersionLabels(null);
      return;
    }
    let cancelled = false;
    const mobileHost = getRuntimePlatform().mobileHost;
    if (!mobileHost) {
      setMobileVersionLabels(null);
      return;
    }
    void mobileHost
      .getVersions()
      .then((versions) => {
        if (cancelled) {
          return;
        }
        setMobileVersionLabels({
          wateray: versions.waterayVersion,
          singbox: versions.singBoxVersion,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setMobileVersionLabels(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isMobile]);

  const canApplySettingsDraft = useMemo(
    () => settingsDraftDirty && !applyingSettingsDraft,
    [settingsDraftDirty, applyingSettingsDraft],
  );
  const canRevertSettingsDraft = useMemo(
    () => settingsDraftDirty && !applyingSettingsDraft,
    [settingsDraftDirty, applyingSettingsDraft],
  );
  const selectedRuleSetCount = useMemo(
    () => selectedGeoIPRuleSets.length + selectedGeoSiteRuleSets.length,
    [selectedGeoIPRuleSets, selectedGeoSiteRuleSets],
  );
  const systemType = (snapshot?.systemType ?? "").toLowerCase();
  const isWindowsSystem = systemType === "windows";
  const runtimeAdmin = snapshot?.runtimeAdmin === true;
  const canExemptLoopback = isWindowsSystem && runtimeAdmin && !exemptingLoopback;
  const updateState = appUpdate.state;
  const updateCandidate = updateState.candidate;
  const updateBusy =
    updateState.stage === "checking" ||
    updateState.stage === "downloading" ||
    updateState.stage === "installing";
  const canCheckAppUpdate = updateState.supported && !updateBusy;
  const canDownloadAppUpdate =
    updateState.supported &&
    updateCandidate !== null &&
    updateState.stage !== "downloading" &&
    updateState.stage !== "installing" &&
    updateState.stage !== "downloaded";
  const canInstallAppUpdate =
    updateState.supported &&
    updateCandidate !== null &&
    updateState.stage === "downloaded";
  const canCancelAppUpdate = updateState.stage === "downloading";
  const allGeoIPRuleSetValues = useMemo(
    () => geoIPRuleSetOptions.map((option) => option.value),
    [],
  );
  const allGeoSiteRuleSetValues = useMemo(
    () => geoSiteRuleSetOptions.map((option) => option.value),
    [],
  );
  const ruleSetProgressPercent = useMemo(() => {
    if (!ruleSetDownloadProgress || ruleSetDownloadProgress.total <= 0) {
      return 0;
    }
    return Math.min(
      100,
      Math.round((ruleSetDownloadProgress.completed / ruleSetDownloadProgress.total) * 100),
    );
  }, [ruleSetDownloadProgress]);
  const appUpdateProgressPercent = useMemo(
    () => Math.min(100, Math.max(0, Math.round(updateState.downloadProgressPercent ?? 0))),
    [updateState.downloadProgressPercent],
  );
  const waterayKernelVersionLabel = useMemo(() => {
    if (isMobile) {
      return resolveKernelVersionLabel(
        mobileVersionLabels?.wateray ?? snapshot?.coreVersion,
        bundledWaterayVersion,
      );
    }
    return resolveKernelVersionLabel(snapshot?.coreVersion, bundledWaterayVersion);
  }, [isMobile, mobileVersionLabels?.wateray, snapshot?.coreVersion]);
  const singboxKernelVersionLabel = useMemo(() => {
    if (isMobile) {
      return resolveKernelVersionLabel(
        mobileVersionLabels?.singbox ?? snapshot?.proxyVersion,
        bundledSingBoxVersion,
      );
    }
    return resolveKernelVersionLabel(snapshot?.proxyVersion, bundledSingBoxVersion);
  }, [isMobile, mobileVersionLabels?.singbox, snapshot?.proxyVersion]);

  const applySettingsDraft = async () => {
    if (!settingsDraftDirty) {
      return;
    }
    setApplyingSettingsDraft(true);
    try {
      if (closeBehavior !== appliedCloseBehavior) {
        writeCloseBehavior(closeBehavior);
        setAppliedCloseBehavior(closeBehavior);
      }
      setSettingsDraftTouched(false);
      draftNotice.notifySaveSuccess("设置草稿");
    } catch (error) {
      draftNotice.notifySaveFailed("设置草稿", error);
    } finally {
      setApplyingSettingsDraft(false);
    }
  };

  const revertSettingsDraft = () => {
    const currentCloseBehavior = readCloseBehavior();
    setAppliedCloseBehavior(currentCloseBehavior);
    setCloseBehavior(currentCloseBehavior);
    setSettingsDraftTouched(false);
    draftNotice.notifyDraftReverted("设置");
  };

  const refreshRuleSetStatuses = useCallback(
    async (silent = false) => {
      setLoadingRuleSetStatuses(true);
      try {
        const statusResult = await daemonApi.getRuleSetStatuses({
          geoip: allGeoIPRuleSetValues,
          geosite: allGeoSiteRuleSetValues,
        });
        const nextStatusMap: Record<string, RuleSetLocalStatus> = {};
        for (const item of statusResult.statuses) {
          if (item.kind !== "geoip" && item.kind !== "geosite") {
            continue;
          }
          nextStatusMap[ruleSetStatusKey(item.kind, item.value)] = item;
        }
        setRuleSetStatuses(nextStatusMap);
      } catch (error) {
        if (!silent) {
          notice.error(error instanceof Error ? error.message : "读取规则集状态失败");
        }
      } finally {
        setLoadingRuleSetStatuses(false);
      }
    },
    [allGeoIPRuleSetValues, allGeoSiteRuleSetValues, notice],
  );

  const parseRuleSetTagToKey = useCallback((tag: string): string | null => {
    const match = /^wateray-(geoip|geosite)-(.+)$/i.exec(String(tag).trim());
    if (!match) {
      return null;
    }
    return ruleSetStatusKey(match[1].toLowerCase() as RuleSetKind, match[2]);
  }, []);

  const renderRuleSetStatus = useCallback(
    (kind: RuleSetKind, value: string) => {
      const key = ruleSetStatusKey(kind, value);
      const transientStatus = ruleSetTransientStatuses[key] ?? "idle";
      const localStatus = ruleSetStatuses[key];
      if (transientStatus === "downloading") {
        return (
          <Typography.Text type="warning">
            <BiIcon name="arrow-repeat" spin /> 正在下载
          </Typography.Text>
        );
      }
      if (transientStatus === "queued") {
        return (
          <Typography.Text type="secondary">
            <BiIcon name="hourglass-split" /> 等待下载
          </Typography.Text>
        );
      }
      if (transientStatus === "failed") {
        return (
          <Typography.Text type="danger">
            <BiIcon
              name="x-circle-fill"
              style={{ color: "#ff4d4f" }}
            />{" "}
            下载失败
          </Typography.Text>
        );
      }
      if (localStatus?.exists) {
        const updatedText = formatRuleSetUpdatedTime(localStatus.updatedAtMs);
        return (
          <Typography.Text style={{ color: "#52c41a" }}>
            <BiIcon
              name="check-circle-fill"
              style={{ color: "#52c41a" }}
            />{" "}
            {updatedText || "已下载"}
          </Typography.Text>
        );
      }
      if (loadingRuleSetStatuses) {
        return (
          <Typography.Text type="secondary">
            <BiIcon name="arrow-repeat" spin /> 检查中
          </Typography.Text>
        );
      }
      return (
        <Typography.Text type="secondary">
          <BiIcon
            name="x-circle-fill"
            style={{ color: "#ff4d4f" }}
          />{" "}
          未下载
        </Typography.Text>
      );
    },
    [loadingRuleSetStatuses, ruleSetStatuses, ruleSetTransientStatuses],
  );

  const openRuleSetModal = () => {
    setRuleSetTransientStatuses((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (next[key] === "failed") {
          next[key] = "idle";
        }
      }
      return next;
    });
    setRuleSetDownloadProgress(null);
    setRuleSetModalOpen(true);
  };

  const closeRuleSetModal = () => {
    if (updatingRuleSets) {
      return;
    }
    setRuleSetDownloadProgress(null);
    setRuleSetModalOpen(false);
  };

  const updateSingBoxRuleSets = async () => {
    if (selectedRuleSetCount <= 0) {
      notice.warning("请至少选择一个 GeoIP 或 GeoSite 规则集");
      return;
    }
    const selectedItems = [
      ...selectedGeoIPRuleSets.map((value) => ({
        kind: "geoip" as RuleSetKind,
        value,
        key: ruleSetStatusKey("geoip", value),
      })),
      ...selectedGeoSiteRuleSets.map((value) => ({
        kind: "geosite" as RuleSetKind,
        value,
        key: ruleSetStatusKey("geosite", value),
      })),
    ];
    const selectedKeys = selectedItems.map((item) => item.key);
    setRuleSetTransientStatuses((current) => {
      const next = { ...current };
      for (const key of selectedKeys) {
        next[key] = "queued";
      }
      return next;
    });
    setRuleSetDownloadProgress({
      total: selectedItems.length,
      completed: 0,
      success: 0,
      failed: 0,
    });
    setUpdatingRuleSets(true);
    try {
      let latestSnapshot: DaemonSnapshot | null = null;
      const failedItems: string[] = [];
      const runtimeApplyIssues: string[] = [];
      const queue = [...selectedItems];
      let completedCount = 0;
      let successCount = 0;
      let failedCount = 0;

      const pushRuntimeApplyIssue = (text?: string) => {
        const issue = String(text ?? "").trim();
        if (!issue) {
          return;
        }
        if (!runtimeApplyIssues.includes(issue)) {
          runtimeApplyIssues.push(issue);
        }
      };
      const refreshProgress = () => {
        setRuleSetDownloadProgress({
          total: selectedItems.length,
          completed: completedCount,
          success: successCount,
          failed: failedCount,
        });
      };
      const consumeOneItem = async () => {
        while (true) {
          const nextItem = queue.shift();
          if (!nextItem) {
            return;
          }
          setRuleSetTransientStatuses((current) => ({
            ...current,
            [nextItem.key]: "downloading",
          }));
          try {
            const updateResult = await daemonApi.updateRuleSets({
              geoip: nextItem.kind === "geoip" ? [nextItem.value] : [],
              geosite: nextItem.kind === "geosite" ? [nextItem.value] : [],
              downloadMode: ruleSetDownloadMode,
            });
            latestSnapshot = updateResult.snapshot;

            const successKeys = new Set<string>();
            for (const tag of updateResult.summary.updatedTags ?? []) {
              const key = parseRuleSetTagToKey(tag);
              if (key) {
                successKeys.add(key);
              }
            }
            const downloadedSuccessfully =
              successKeys.has(nextItem.key) ||
              (updateResult.summary.success > 0 && updateResult.summary.failed === 0);

            if (downloadedSuccessfully) {
              successCount += 1;
            } else {
              failedCount += 1;
              failedItems.push(
                updateResult.summary.failedItems?.[0] ??
                  updateResult.error ??
                  `${nextItem.kind}:${nextItem.value} 更新失败`,
              );
            }

            if (updateResult.error && downloadedSuccessfully) {
              pushRuntimeApplyIssue(updateResult.error);
            }
            setRuleSetTransientStatuses((current) => ({
              ...current,
              [nextItem.key]: downloadedSuccessfully ? "idle" : "failed",
            }));
          } catch (error) {
            failedCount += 1;
            failedItems.push(error instanceof Error ? error.message : "下载请求失败");
            setRuleSetTransientStatuses((current) => ({
              ...current,
              [nextItem.key]: "failed",
            }));
          } finally {
            completedCount += 1;
            refreshProgress();
          }
        }
      };

      const workerCount = Math.min(maxRuleSetBatchSize, queue.length);
      const workers = Array.from({ length: workerCount }, () => consumeOneItem());
      await Promise.all(workers);

      if (latestSnapshot) {
        const snapshotToApply = latestSnapshot;
        await runAction(async () => snapshotToApply);
      }
      await refreshRuleSetStatuses(true);
      const summaryText = `共 ${selectedItems.length} 个，成功 ${successCount} 个，失败 ${failedCount} 个`;
      if (failedCount > 0) {
        const firstIssue = failedItems[0];
        notice.error(`${summaryText}。${firstIssue ?? "存在下载失败项"}`);
        return;
      }
      if (runtimeApplyIssues.length > 0) {
        notice.warning(`${summaryText}。下载成功，但有运行时刷新告警：${runtimeApplyIssues[0]}`);
        setRuleSetModalOpen(false);
        return;
      }
      notice.success(`规则集更新完成：${summaryText}`);
      setRuleSetModalOpen(false);
    } catch (error) {
      setRuleSetTransientStatuses((current) => {
        const next = { ...current };
        for (const key of selectedKeys) {
          next[key] = "failed";
        }
        return next;
      });
      notice.error(error instanceof Error ? error.message : "更新规则集失败");
    } finally {
      setUpdatingRuleSets(false);
    }
  };

  const exemptWindowsLoopback = async () => {
    setExemptingLoopback(true);
    try {
      const result = await daemonApi.exemptWindowsLoopback();
      await runAction(async () => result.snapshot);
      const summary = `共 ${result.result.total} 项，成功 ${result.result.succeeded} 项，失败 ${result.result.failed} 项`;
      if (result.error) {
        notice.warning(`解除回环限制部分失败：${summary}。${result.error}`);
      } else {
        notice.success(`解除回环限制完成：${summary}`);
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "解除回环限制失败");
    } finally {
      setExemptingLoopback(false);
    }
  };

  const confirmInstallAppUpdate = useCallback(
    (candidate: AppUpdateCandidate) => {
      Modal.confirm({
        title: `立即更新到 ${candidate.version} 吗？`,
        content:
          updateState.installKind === "deb"
            ? "将调用系统安装链更新 .deb 包，并在完成后自动重启客户端。"
            : updateState.installKind === "appimage"
              ? "将切换到新的 AppImage 文件，并在完成后自动重启客户端。"
              : "将退出当前客户端并自动替换到新的便携整包版本。",
        okText: "立即更新",
        cancelText: "稍后",
        onOk: async () => {
          try {
            await appUpdate.install();
          } catch (error) {
            notice.error(error instanceof Error ? error.message : "安装更新失败");
          }
        },
      });
    },
    [appUpdate, notice, updateState.installKind],
  );

  const checkAppUpdate = useCallback(async () => {
    try {
      const next = await appUpdate.check();
      if (next.stage === "no_update") {
        notice.info(`当前已是最新版本 ${next.currentVersion}`);
      } else if (next.stage === "available" && next.candidate) {
        notice.success(`发现新版本 ${next.candidate.version}`);
      } else if (next.stage === "downloaded" && next.candidate) {
        notice.success(`新版本 ${next.candidate.version} 已下载完成，可立即安装`);
      } else if (next.stage === "unsupported") {
        notice.info(next.statusMessage || "当前平台更新功能未完成");
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "检查更新失败");
    }
  }, [appUpdate, notice]);

  const downloadAppUpdate = useCallback(async () => {
    try {
      const next = await appUpdate.download();
      if (next.stage === "downloaded" && next.candidate) {
        notice.success(`更新包 ${next.candidate.assetName} 已下载完成`);
        confirmInstallAppUpdate(next.candidate);
      }
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "下载更新失败");
    }
  }, [appUpdate, confirmInstallAppUpdate, notice]);

  const installAppUpdate = useCallback(() => {
    if (!updateCandidate) {
      return;
    }
    confirmInstallAppUpdate(updateCandidate);
  }, [confirmInstallAppUpdate, updateCandidate]);

  const cancelAppUpdate = useCallback(async () => {
    try {
      await appUpdate.cancel();
      notice.info("正在取消更新下载");
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "取消更新失败");
    }
  }, [appUpdate, notice]);

  useEffect(() => {
    void refreshRuleSetStatuses(true);
  }, [refreshRuleSetStatuses]);

  useEffect(() => {
    if (!ruleSetModalOpen) {
      return;
    }
    void refreshRuleSetStatuses(true);
  }, [ruleSetModalOpen, refreshRuleSetStatuses]);

  return (
    <Card
      loading={loading}
    >
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <DraftActionBar
          visible={settingsDraftDirty}
          apply={{
            title: "保存设置草稿",
            label: "保存",
            icon: <BiIcon name="check-lg" />,
            disabled: !canApplySettingsDraft,
            loading: applyingSettingsDraft,
            onClick: () => {
              void applySettingsDraft();
            },
          }}
          discard={{
            title: "取消设置草稿",
            label: "取消",
            icon: <BiIcon name="x-lg" />,
            disabled: !canRevertSettingsDraft,
            onClick: revertSettingsDraft,
          }}
        />
        {isMobile ? (
          <Card size="small">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Collapse
                className="proxy-settings-collapse"
                defaultActiveKey={[]}
                items={[
                  {
                    key: "mobile-proxy-settings",
                    label: "代理设置",
                    children: (
                      <div className="proxy-settings-panel-body">
                        <ProxySettingsPanel snapshot={snapshot} loading={loading} runAction={runAction} />
                      </div>
                    ),
                  },
                ]}
              />
            </Space>
          </Card>
        ) : null}
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text strong>内核版本</Typography.Text>
          <Space size={8} wrap>
            <Tag color="blue">Wateray: {waterayKernelVersionLabel}</Tag>
            <Tag color="geekblue">sing-box: {singboxKernelVersionLabel}</Tag>
          </Space>
        </Space>
        {!isMobile ? (
          <>
            <Typography.Text strong>系统</Typography.Text>
            <Space
              direction="vertical"
              size={8}
              style={{ width: "100%" }}
            >
              <HelpLabel
                label="关闭按钮行为"
                helpContent={{
                  scene: "定义点击窗口右上角关闭按钮后的默认行为。",
                  effect: "可在询问/最小化托盘/仅关闭面板/完全退出之间切换。",
                  caution: "选择“完全退出”会同时关闭内核；如需后台持续代理，建议用托盘或仅关闭面板。",
                }}
              />
              <Radio.Group
                value={closeBehavior}
                onChange={(event) => {
                  setCloseBehavior(event.target.value as CloseBehavior);
                  setSettingsDraftTouched(true);
                }}
              >
                <Space direction="vertical">
                  <Radio value="ask_every_time">每次弹出提示（默认）</Radio>
                  <Radio value="minimize_to_tray">最小化到托盘</Radio>
                  <Radio value="close_panel_keep_core">后台运行（仅关闭面板程序）</Radio>
                  <Radio value="exit_all">完全退出（关闭面板程序 + 内核程序）</Radio>
                </Space>
              </Radio.Group>
            </Space>
            <Space
              size={10}
              align="center"
              wrap
            >
              <Button
                type="primary"
                loading={exemptingLoopback}
                disabled={!canExemptLoopback}
                onClick={() => {
                  void exemptWindowsLoopback();
                }}
              >
                解除回环限制
              </Button>
              <HelpLabel
                label="回环豁免说明"
                helpContent={{
                  scene: "UWP/商店应用在代理场景中出现回环受限时。",
                  effect: "调用系统能力为 AppContainer SID 配置回环豁免。",
                  caution: "仅 Windows 且内核进程具备管理员权限时可执行；其他平台或权限不足时按钮会禁用。",
                }}
              />
            </Space>
          </>
        ) : null}
        <Divider style={{ margin: "4px 0 2px" }} />
        <HelpLabel
          label={<Typography.Text strong>版本与更新</Typography.Text>}
          helpContent={{
            scene: "检查客户端更新并执行桌面端自动安装。",
            effect:
              "Windows 使用整包自替换；Linux .deb 走系统安装链；Linux AppImage 会切换到新的发布文件并自动重启客户端。",
            caution: "开发模式、未适配的平台或未支持的运行来源只显示提示，不会执行自动更新。",
          }}
        />
        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Typography.Text>
            当前版本：<Typography.Text code>{updateState.currentVersion || "未知"}</Typography.Text>
          </Typography.Text>
          <Typography.Text type="secondary">
            当前平台：{updateState.currentPlatform || "unknown"} / 安装方式：
            {describeUpdateInstallKind(updateState.installKind)}
          </Typography.Text>
          <Typography.Text type="secondary">
            当前状态：{describeUpdateStage(updateState.stage)}
          </Typography.Text>
          {updateCandidate ? (
            <Typography.Text>
              可用版本：<Typography.Text code>{updateCandidate.version}</Typography.Text> / 包类型：
              {describeUpdateAssetKind(updateCandidate.assetKind)}
            </Typography.Text>
          ) : null}
          <Typography.Text type={updateState.stage === "error" ? "danger" : "secondary"}>
            {updateState.statusMessage ||
              (updateState.supported
                ? "点击“检查更新”获取最新版本信息。"
                : "当前平台更新功能未完成。")}
          </Typography.Text>
          {updateState.lastCheckedAtMs > 0 ? (
            <Typography.Text type="secondary">
              上次检查：{formatUpdateCheckedTime(updateState.lastCheckedAtMs)}
            </Typography.Text>
          ) : null}
          {(updateState.stage === "downloading" || updateState.stage === "downloaded") &&
          updateState.totalBytes > 0 ? (
            <Space
              direction="vertical"
              size={6}
              style={{ width: "100%" }}
            >
              <Progress
                percent={appUpdateProgressPercent}
                size="small"
                status={updateState.stage === "downloading" ? "active" : "success"}
              />
              <Typography.Text type="secondary">
                已下载 {updateState.downloadedBytes}/{updateState.totalBytes} 字节。
              </Typography.Text>
            </Space>
          ) : null}
          <Space
            size={8}
            wrap
          >
            {updateState.supported ? (
              <>
                <Button
                  type="primary"
                  loading={updateState.stage === "checking"}
                  disabled={!canCheckAppUpdate}
                  onClick={() => {
                    void checkAppUpdate();
                  }}
                >
                  检查更新
                </Button>
                {updateCandidate && updateState.stage !== "downloaded" ? (
                  <Button
                    loading={updateState.stage === "downloading"}
                    disabled={!canDownloadAppUpdate}
                    onClick={() => {
                      void downloadAppUpdate();
                    }}
                  >
                    下载更新
                  </Button>
                ) : null}
                {canInstallAppUpdate ? (
                  <Button
                    type="primary"
                    onClick={installAppUpdate}
                  >
                    立即安装
                  </Button>
                ) : null}
                {canCancelAppUpdate ? (
                  <Button
                    onClick={() => {
                      void cancelAppUpdate();
                    }}
                  >
                    取消下载
                  </Button>
                ) : null}
              </>
            ) : (
              <Button disabled>功能未完成</Button>
            )}
          </Space>
        </Space>

        <HelpLabel
          label={<Typography.Text strong>规则</Typography.Text>}
          helpContent={{
            scene: "按地域/域名分类增强分流能力（GeoIP/GeoSite）。",
            effect: "下载并维护本地规则集，供路由规则引用。",
            caution: "规则文件保存在用户配置目录 `wateray/rule-set`；建议按实际需求选择，避免无效下载。",
          }}
        />
        <Space size={8}>
          <Button
            type="primary"
            onClick={() => {
              openRuleSetModal();
            }}
          >
            更新规则集
          </Button>
        </Space>
      </Space>
      <Modal
        title="更新规则集"
        open={ruleSetModalOpen}
        onCancel={closeRuleSetModal}
        footer={null}
        maskClosable={!updatingRuleSets}
        destroyOnClose={false}
      >
        <Space
          direction="vertical"
          size={14}
          style={{ width: "100%" }}
        >
          <Space
            align="center"
            wrap
          >
            <Typography.Text strong>GeoIP 规则集</Typography.Text>
            <Button
              size="small"
              type="link"
              disabled={updatingRuleSets}
              onClick={() => setSelectedGeoIPRuleSets(allGeoIPRuleSetValues)}
            >
              全选
            </Button>
            <Button
              size="small"
              type="link"
              disabled={updatingRuleSets}
              onClick={() =>
                setSelectedGeoIPRuleSets(
                  allGeoIPRuleSetValues.filter((value) => !selectedGeoIPRuleSets.includes(value)),
                )
              }
            >
              反选
            </Button>
          </Space>
          <Checkbox.Group
            value={selectedGeoIPRuleSets}
            disabled={updatingRuleSets}
            onChange={(values) => {
              setSelectedGeoIPRuleSets(values as string[]);
            }}
          >
            <Space direction="vertical" size={6}>
              {geoIPRuleSetOptions.map((option) => (
                <Checkbox
                  key={option.value}
                  value={option.value}
                >
                  <Space
                    size={8}
                    wrap
                  >
                    <span>{option.label}</span>
                    {renderRuleSetStatus("geoip", option.value)}
                  </Space>
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>

          <Divider style={{ margin: 0 }} />

          <Space
            align="center"
            wrap
          >
            <Typography.Text strong>GeoSite 规则集</Typography.Text>
            <Button
              size="small"
              type="link"
              disabled={updatingRuleSets}
              onClick={() => setSelectedGeoSiteRuleSets(allGeoSiteRuleSetValues)}
            >
              全选
            </Button>
            <Button
              size="small"
              type="link"
              disabled={updatingRuleSets}
              onClick={() =>
                setSelectedGeoSiteRuleSets(
                  allGeoSiteRuleSetValues.filter(
                    (value) => !selectedGeoSiteRuleSets.includes(value),
                  ),
                )
              }
            >
              反选
            </Button>
          </Space>
          <Checkbox.Group
            value={selectedGeoSiteRuleSets}
            disabled={updatingRuleSets}
            onChange={(values) => {
              setSelectedGeoSiteRuleSets(values as string[]);
            }}
          >
            <Space direction="vertical" size={6}>
              {geoSiteRuleSetOptions.map((option) => (
                <Checkbox
                  key={option.value}
                  value={option.value}
                >
                  <Space
                    size={8}
                    wrap
                  >
                    <span>{option.label}</span>
                    {renderRuleSetStatus("geosite", option.value)}
                  </Space>
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>

          <Space
            align="center"
            wrap
          >
            <Typography.Text>下载方式</Typography.Text>
            <Select<RuleSetDownloadMode>
              style={{ width: 180 }}
              value={ruleSetDownloadMode}
              disabled={updatingRuleSets}
              onChange={(value) => {
                setRuleSetDownloadMode(value);
              }}
              options={[
                { value: "direct", label: "使用直连下载" },
                { value: "proxy", label: "使用代理下载" },
              ]}
            />
            <Button
              type="primary"
              loading={updatingRuleSets}
              disabled={selectedRuleSetCount <= 0 || updatingRuleSets}
              onClick={() => {
                void updateSingBoxRuleSets();
              }}
            >
              更新规则集
            </Button>
          </Space>

          {ruleSetDownloadProgress ? (
            <Space
              direction="vertical"
              size={6}
              style={{ width: "100%" }}
            >
              <Progress
                percent={ruleSetProgressPercent}
                size="small"
                status={updatingRuleSets ? "active" : (ruleSetDownloadProgress.failed > 0 ? "exception" : "success")}
              />
              <Typography.Text type="secondary">
                下载进度：{ruleSetDownloadProgress.completed}/{ruleSetDownloadProgress.total}，成功{" "}
                {ruleSetDownloadProgress.success}，失败 {ruleSetDownloadProgress.failed}。
              {updatingRuleSets ? "（最多 5 个并发下载）" : ""}
              </Typography.Text>
            </Space>
          ) : null}

          <Typography.Text type="secondary">
            已选择 {selectedRuleSetCount} 个规则集（GeoIP {selectedGeoIPRuleSets.length}，GeoSite{" "}
            {selectedGeoSiteRuleSets.length}）。
          </Typography.Text>
        </Space>
      </Modal>
    </Card>
  );
}
