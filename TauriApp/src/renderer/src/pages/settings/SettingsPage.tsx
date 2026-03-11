import {
  Button,
  Card,
  Checkbox,
  Divider,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DraftActionBar } from "../../components/draft/DraftActionBar";
import { BiIcon } from "../../components/icons/BiIcon";
import { SwitchWithLabel } from "../../components/form/SwitchWithLabel";
import { HelpLabel } from "../../components/form/HelpLabel";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { useDraftNavLock } from "../../hooks/useDraftNavLock";
import { useDraftNotice } from "../../hooks/useDraftNotice";

import type { DaemonPageProps } from "../../app/types";
import {
  type CloseBehavior,
  readCloseBehavior,
  readDragScrollEnabled,
  writeCloseBehavior,
  writeDragScrollEnabled,
} from "../../app/settings/uiPreferences";
import { daemonApi } from "../../services/daemonApi";
import type { DaemonSnapshot, RuleSetLocalStatus } from "../../../../shared/daemon";
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
type LinuxServiceBusyAction = "refresh" | "install" | "uninstall";
type LinuxServiceStatusValue = Awaited<
  ReturnType<Window["waterayDesktop"]["system"]["linuxService"]["getStatus"]>
>;
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

export function SettingsPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const notice = useAppNotice();
  const draftNotice = useDraftNotice();
  const [appliedDragScrollEnabled, setAppliedDragScrollEnabled] = useState<boolean>(() =>
    readDragScrollEnabled(),
  );
  const [dragScrollEnabled, setDragScrollEnabled] = useState<boolean>(() =>
    readDragScrollEnabled(),
  );
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
  const [linuxServiceStatus, setLinuxServiceStatus] = useState<LinuxServiceStatusValue | null>(
    null,
  );
  const [loadingLinuxServiceStatus, setLoadingLinuxServiceStatus] = useState(false);
  const [linuxServiceBusyAction, setLinuxServiceBusyAction] =
    useState<LinuxServiceBusyAction | null>(null);

  const settingsDraftDirty =
    dragScrollEnabled !== appliedDragScrollEnabled ||
    closeBehavior !== appliedCloseBehavior;

  useEffect(() => {
    const initialDragScroll = readDragScrollEnabled();
    const initialCloseBehavior = readCloseBehavior();
    setAppliedDragScrollEnabled(initialDragScroll);
    setDragScrollEnabled(initialDragScroll);
    setAppliedCloseBehavior(initialCloseBehavior);
    setCloseBehavior(initialCloseBehavior);
  }, []);

  useEffect(() => {
    if (!snapshot || settingsDraftTouched) {
      return;
    }
    const currentDragScroll = readDragScrollEnabled();
    const currentCloseBehavior = readCloseBehavior();
    setAppliedDragScrollEnabled(currentDragScroll);
    setDragScrollEnabled(currentDragScroll);
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
  const isLinuxSystem = systemType === "linux";
  const isWindowsSystem = systemType === "windows";
  const runtimeAdmin = snapshot?.runtimeAdmin === true;
  const canExemptLoopback = isWindowsSystem && runtimeAdmin && !exemptingLoopback;
  const linuxServiceBusy = linuxServiceBusyAction !== null;
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

  const applySettingsDraft = async () => {
    if (!settingsDraftDirty) {
      return;
    }
    setApplyingSettingsDraft(true);
    try {
      if (dragScrollEnabled !== appliedDragScrollEnabled) {
        writeDragScrollEnabled(dragScrollEnabled);
        setAppliedDragScrollEnabled(dragScrollEnabled);
      }
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
    const currentDragScroll = readDragScrollEnabled();
    const currentCloseBehavior = readCloseBehavior();
    setAppliedDragScrollEnabled(currentDragScroll);
    setDragScrollEnabled(currentDragScroll);
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

  const refreshLinuxServiceStatus = useCallback(
    async (silent = false) => {
      if (!isLinuxSystem) {
        setLinuxServiceStatus(null);
        return;
      }
      setLoadingLinuxServiceStatus(true);
      if (!silent) {
        setLinuxServiceBusyAction("refresh");
      }
      try {
        const status = await window.waterayDesktop.system.linuxService.getStatus();
        setLinuxServiceStatus(status);
      } catch (error) {
        if (!silent) {
          notice.error(error instanceof Error ? error.message : "读取 Linux 服务状态失败");
        }
      } finally {
        setLoadingLinuxServiceStatus(false);
        if (!silent) {
          setLinuxServiceBusyAction(null);
        }
      }
    },
    [isLinuxSystem, notice],
  );

  const installOrRepairLinuxService = async () => {
    if (!isLinuxSystem) {
      return;
    }
    setLinuxServiceBusyAction("install");
    try {
      const status = await window.waterayDesktop.system.linuxService.installOrRepair();
      setLinuxServiceStatus(status);
      if (status.daemonReachable) {
        await runAction(() => daemonApi.getState());
      }
      notice.success(
        status.mode === "dev" ? "Linux 开发服务已安装/修复" : "Linux 系统服务已安装/修复",
      );
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "安装或修复 Linux 服务失败");
    } finally {
      setLinuxServiceBusyAction(null);
      void refreshLinuxServiceStatus(true);
    }
  };

  const uninstallLinuxService = async () => {
    if (!isLinuxSystem) {
      return;
    }
    setLinuxServiceBusyAction("uninstall");
    try {
      const status = await window.waterayDesktop.system.linuxService.uninstall();
      setLinuxServiceStatus(status);
      notice.success(
        status.mode === "dev" ? "Linux 开发服务已卸载" : "Linux 系统服务已卸载",
      );
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "卸载 Linux 服务失败");
    } finally {
      setLinuxServiceBusyAction(null);
      void refreshLinuxServiceStatus(true);
    }
  };

  useEffect(() => {
    void refreshRuleSetStatuses(true);
  }, [refreshRuleSetStatuses]);

  useEffect(() => {
    if (!isLinuxSystem) {
      setLinuxServiceStatus(null);
      return;
    }
    void refreshLinuxServiceStatus(true);
  }, [isLinuxSystem, refreshLinuxServiceStatus]);

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
        <Typography.Text strong>系统</Typography.Text>
        <Space
          direction="vertical"
          size={8}
          style={{ width: "100%" }}
        >
          <Space
            size={8}
            align="center"
          >
            <SwitchWithLabel
              checked={dragScrollEnabled}
              onChange={(checked) => {
                setDragScrollEnabled(checked);
                setSettingsDraftTouched(true);
              }}
              label="移动端手势"
              helpContent={{
                scene: "节点表较长、需要快速上下浏览时。",
                effect: "支持在主内容区按住鼠标左键拖动滚动，获得接近移动端的滑动体验。",
                caution: "仅影响面板交互，不影响代理链路与内核配置。",
              }}
            />
          </Space>
          <Divider style={{ margin: "4px 0 2px" }} />
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
          {isLinuxSystem ? (
            <>
              <Divider style={{ margin: "4px 0 2px" }} />
              <HelpLabel
                label="Linux 系统服务"
                helpContent={{
                  scene: "Linux 下需要由 systemd 承载 waterayd 服务。",
                  effect: "可查看当前服务状态，并执行安装/修复、卸载与刷新操作。",
                  caution:
                    "安装、修复、卸载都可能触发管理员授权；卸载后仅会暂停本次会话内的自动修复，后续重新启动客户端时，如需继续使用 VPN，仍可能提示重新安装服务。",
                }}
              />
              <Space
                direction="vertical"
                size={6}
                style={{ width: "100%" }}
              >
                <Typography.Text type="secondary">
                  当前模式：
                  {linuxServiceStatus?.mode === "dev"
                    ? " 开发态服务（waterayd-dev.service）"
                    : " 正式服务（waterayd.service）"}
                </Typography.Text>
                <Space
                  wrap
                  size={12}
                >
                  <Typography.Text type={linuxServiceStatus?.installed ? undefined : "secondary"}>
                    <BiIcon
                      name={loadingLinuxServiceStatus ? "arrow-repeat" : (linuxServiceStatus?.installed ? "check-circle-fill" : "x-circle-fill")}
                      spin={loadingLinuxServiceStatus}
                    />{" "}
                    服务{loadingLinuxServiceStatus ? "检查中" : (linuxServiceStatus?.installed ? "已安装" : "未安装")}
                  </Typography.Text>
                  <Typography.Text type={linuxServiceStatus?.enabled ? undefined : "secondary"}>
                    <BiIcon name={linuxServiceStatus?.enabled ? "check-circle-fill" : "x-circle-fill"} />{" "}
                    开机启动{linuxServiceStatus?.enabled ? "已启用" : "未启用"}
                  </Typography.Text>
                  <Typography.Text type={linuxServiceStatus?.active ? undefined : "secondary"}>
                    <BiIcon name={linuxServiceStatus?.active ? "check-circle-fill" : "x-circle-fill"} />{" "}
                    服务进程{linuxServiceStatus?.active ? "运行中" : "未运行"}
                  </Typography.Text>
                  <Typography.Text type={linuxServiceStatus?.daemonReachable ? undefined : "secondary"}>
                    <BiIcon
                      name={linuxServiceStatus?.daemonReachable ? "check-circle-fill" : "x-circle-fill"}
                    />{" "}
                    控制面{linuxServiceStatus?.daemonReachable ? "已就绪" : "未就绪"}
                  </Typography.Text>
                </Space>
                {linuxServiceStatus ? (
                  <Typography.Text type="secondary">
                    systemd：{linuxServiceStatus.unitFileState || "unknown"} /{" "}
                    {linuxServiceStatus.activeState || "unknown"} /{" "}
                    {linuxServiceStatus.subState || "unknown"}
                  </Typography.Text>
                ) : null}
                {!linuxServiceStatus?.manageSupported ? (
                  <Typography.Text type="secondary">
                    当前环境未找到可用的 Linux 服务脚本，暂时无法从前端管理服务。
                  </Typography.Text>
                ) : null}
                <Space
                  wrap
                  size={8}
                >
                  <Button
                    type="primary"
                    loading={linuxServiceBusyAction === "install"}
                    disabled={linuxServiceBusy || !linuxServiceStatus?.manageSupported}
                    onClick={() => {
                      void installOrRepairLinuxService();
                    }}
                  >
                    {linuxServiceStatus?.installed ? "安装/修复服务" : "安装并启动服务"}
                  </Button>
                  <Button
                    danger
                    loading={linuxServiceBusyAction === "uninstall"}
                    disabled={
                      linuxServiceBusy ||
                      !linuxServiceStatus?.manageSupported ||
                      !linuxServiceStatus?.installed
                    }
                    onClick={() => {
                      void uninstallLinuxService();
                    }}
                  >
                    卸载服务
                  </Button>
                  <Button
                    loading={linuxServiceBusyAction === "refresh" || loadingLinuxServiceStatus}
                    disabled={linuxServiceBusyAction === "install" || linuxServiceBusyAction === "uninstall"}
                    onClick={() => {
                      void refreshLinuxServiceStatus(false);
                    }}
                  >
                    刷新状态
                  </Button>
                </Space>
              </Space>
            </>
          ) : null}
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
