import { Card, Divider, Space, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DaemonSnapshot,
  RuleConfigV2,
  RuleGroup,
  RulePolicyGroup,
  VpnNode,
} from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import {
  notifyConfigActionFailed,
  notifyConfigApplied,
  notifyConfigSaved,
} from "../../services/configChangeMessage";
import { daemonApi } from "../../services/daemonApi";
import { ComposedRulesTabs } from "./components/ComposedRulesTabs";
import { NodePoolTable } from "./components/NodePoolTable";
import {
  createEmptyRuleConfig,
  ensureRuleGroups,
  normalizeRuleConfigForEditor,
} from "./components/ruleEditorUtils";

const rulesPendingConfigStorageKey = "wateray.rules.pendingRuleConfigV2";

interface PendingRuleConfigCache {
  config: RuleConfigV2;
  baseRevision: number;
}

function notifyRuleConfigResult(notice: ReturnType<typeof useAppNotice>, snapshot: DaemonSnapshot): void {
  const result = snapshot.lastRuntimeApply?.result;
  if (result === "hot_applied") {
    notifyConfigApplied(notice, "规则配置");
    return;
  }
  if (result === "restart_required") {
    notifyConfigSaved(notice, "规则配置", {
      restartRequired: true,
    });
    return;
  }
  notifyConfigSaved(notice, "规则配置");
}

function readPendingRuleConfig(): PendingRuleConfigCache | null {
  try {
    const raw = window.sessionStorage.getItem(rulesPendingConfigStorageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as
      | PendingRuleConfigCache
      | RuleConfigV2
      | null
      | undefined;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if ("config" in parsed) {
      const payload = parsed as PendingRuleConfigCache;
      return {
        config: normalizeRuleConfigForEditor(payload.config),
        baseRevision: Number(payload.baseRevision) || 0,
      };
    }
    return {
      config: normalizeRuleConfigForEditor(parsed as RuleConfigV2),
      baseRevision: 0,
    };
  } catch {
    return null;
  }
}

function writePendingRuleConfig(config: RuleConfigV2, baseRevision: number): void {
  try {
    window.sessionStorage.setItem(
      rulesPendingConfigStorageKey,
      JSON.stringify({
        config,
        baseRevision,
      } as PendingRuleConfigCache),
    );
  } catch {
    // Ignore storage failure, keep runtime save flow working.
  }
}

function clearPendingRuleConfig(): void {
  try {
    window.sessionStorage.removeItem(rulesPendingConfigStorageKey);
  } catch {
    // Ignore storage failure.
  }
}

export function RulesPage({ snapshot, loading, runAction }: DaemonPageProps) {
  const notice = useAppNotice();
  const initialPendingConfigRef = useRef<PendingRuleConfigCache | null>(readPendingRuleConfig());
  const [editingConfig, setEditingConfig] = useState<RuleConfigV2>(
    () => initialPendingConfigRef.current?.config ?? createEmptyRuleConfig(),
  );
  const [dirty, setDirty] = useState<boolean>(() => initialPendingConfigRef.current != null);
  const editingConfigRef = useRef<RuleConfigV2>(editingConfig);
  const latestSnapshotRevisionRef = useRef<number>(0);
  const saveVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    editingConfigRef.current = editingConfig;
  }, [editingConfig]);

  useEffect(() => {
    const revision = snapshot?.stateRevision ?? 0;
    if (revision > latestSnapshotRevisionRef.current) {
      latestSnapshotRevisionRef.current = revision;
    }
  }, [snapshot?.stateRevision]);

  const groupState = useMemo(
    () => ensureRuleGroups(editingConfig.groups, editingConfig.rules),
    [editingConfig.groups, editingConfig.rules],
  );
  const activeGroupID = useMemo(() => {
    const fromConfig = editingConfig.activeGroupId ?? "";
    if (groupState.groups.some((group) => group.id === fromConfig)) {
      return fromConfig;
    }
    return groupState.activeGroupId;
  }, [editingConfig.activeGroupId, groupState]);

  const activeGroupNodes = useMemo(() => {
    const groups = snapshot?.groups ?? [];
    if (!groups.length) {
      return [];
    }
    return groups.find((group) => group.id === snapshot?.activeGroupId)?.nodes ?? groups[0]?.nodes ?? [];
  }, [snapshot]);

  useEffect(() => {
    if (dirty) {
      return;
    }
    clearPendingRuleConfig();
    setEditingConfig(normalizeRuleConfigForEditor(snapshot?.ruleConfigV2));
  }, [snapshot, dirty]);

  const persistRuleConfig = (nextConfig: RuleConfigV2): Promise<boolean> => {
    const normalized = normalizeRuleConfigForEditor(nextConfig);
    saveVersionRef.current += 1;
    const saveVersion = saveVersionRef.current;
    writePendingRuleConfig(normalized, latestSnapshotRevisionRef.current);
    editingConfigRef.current = normalized;
    setEditingConfig(normalized);
    setDirty(true);

    const saveTask = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const nextSnapshot = await runAction(() => daemonApi.setRuleConfigV2(normalized));
          if (saveVersion !== saveVersionRef.current) {
            return false;
          }
          const committed = normalizeRuleConfigForEditor(nextSnapshot.ruleConfigV2);
          clearPendingRuleConfig();
          editingConfigRef.current = committed;
          setEditingConfig(committed);
          setDirty(false);
          notifyRuleConfigResult(notice, nextSnapshot);
          return true;
        } catch (error) {
          if (saveVersion !== saveVersionRef.current) {
            return false;
          }
          notifyConfigActionFailed(notice, "规则配置", error, "保存失败");
          setDirty(true);
          return false;
        }
      });
    saveQueueRef.current = saveTask.then(() => undefined, () => undefined);
    return saveTask;
  };

  const updateConfig = (updater: (prev: RuleConfigV2) => RuleConfigV2): Promise<boolean> => {
    const next = normalizeRuleConfigForEditor(updater(editingConfigRef.current));
    return persistRuleConfig(next);
  };

  useEffect(() => {
    if (!initialPendingConfigRef.current) {
      return;
    }
    if (!snapshot) {
      return;
    }
    const pending = initialPendingConfigRef.current;
    initialPendingConfigRef.current = null;
    const snapshotRevision = snapshot.stateRevision ?? 0;
    if (snapshotRevision > (pending.baseRevision || 0)) {
      clearPendingRuleConfig();
      setDirty(false);
      return;
    }
    void persistRuleConfig(pending.config);
  }, [snapshot]);

  const replaceGroups = (
    nextGroups: RuleGroup[],
    nextActiveGroupID: string,
  ): Promise<boolean> => {
    return updateConfig((prev) => {
      const normalized = ensureRuleGroups(nextGroups);
      const activeGroup =
        normalized.groups.find((group) => group.id === nextActiveGroupID) ??
        normalized.groups[0];
      return {
        ...prev,
        groups: normalized.groups,
        activeGroupId: activeGroup.id,
        rules: activeGroup.rules ?? [],
      };
    });
  };

  const probeActiveGroupRealConnect = useCallback(async (): Promise<VpnNode[]> => {
    if (!snapshot) {
      return [];
    }
    const groups = snapshot.groups ?? [];
    if (groups.length === 0) {
      return [];
    }
    const activeGroup =
      groups.find((group) => group.id === snapshot.activeGroupId) ?? groups[0];
    const targetNodeIDs = activeGroup.nodes.map((node) => node.id).filter(Boolean);
    if (!activeGroup.id || targetNodeIDs.length === 0) {
      return [];
    }
    const probeResult = await daemonApi.probeNodesWithSummary({
      groupId: activeGroup.id,
      nodeIds: targetNodeIDs,
      probeTypes: ["real_connect"],
    });
    const nextSnapshot = await runAction(async () => probeResult.snapshot);
    const nextGroups = nextSnapshot.groups ?? [];
    const nextActiveGroup =
      nextGroups.find((group) => group.id === nextSnapshot.activeGroupId) ??
      nextGroups.find((group) => group.id === activeGroup.id) ??
      nextGroups[0];
    return nextActiveGroup?.nodes ?? [];
  }, [snapshot, runAction]);

  return (
    <Card loading={loading}>
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <ComposedRulesTabs
          groups={groupState.groups}
          activeGroupId={activeGroupID}
          policyGroups={editingConfig.policyGroups ?? []}
          onChange={replaceGroups}
        />

        <Divider style={{ margin: "6px 0" }} />

        <NodePoolTable
          value={editingConfig.policyGroups ?? []}
          activeNodes={activeGroupNodes}
          onProbeActiveGroupRealConnect={probeActiveGroupRealConnect}
          onChange={(next: RulePolicyGroup[]) =>
            updateConfig((prev) => ({
              ...prev,
              policyGroups: next,
            }))
          }
        />

        {/* <Typography.Text type="secondary">{dirty ? "存在未保存修改" : "已同步到当前快照"}</Typography.Text> */}
      </Space>
    </Card>
  );
}
