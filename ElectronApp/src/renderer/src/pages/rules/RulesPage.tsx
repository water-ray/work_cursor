import { Card, Divider, Space, Typography, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BaseRuleItem,
  ComposedRuleGroup,
  RuleConfigV2,
  RulePolicyGroup,
} from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import { daemonApi } from "../../services/daemonApi";
import { BaseRulesTable } from "./components/BaseRulesTable";
import { ComposedRulesTabs } from "./components/ComposedRulesTabs";
import { NodePoolTable } from "./components/NodePoolTable";
import {
  createEmptyRuleConfig,
  ensureComposedRuleGroups,
  normalizeRuleConfigForEditor,
} from "./components/ruleEditorUtils";

const rulesPendingConfigStorageKey = "wateray.rules.pendingRuleConfigV2";

interface PendingRuleConfigCache {
  config: RuleConfigV2;
  baseRevision: number;
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

  const composedGroupState = useMemo(
    () =>
      ensureComposedRuleGroups(
        editingConfig.composedRuleGroups,
        editingConfig.composedRules,
        editingConfig.applyMode === "direct" ? "direct" : "proxy",
      ),
    [editingConfig.composedRuleGroups, editingConfig.composedRules, editingConfig.applyMode],
  );
  const activeComposedGroupID = useMemo(() => {
    const fromConfig = editingConfig.activeComposedRuleGroupId ?? "";
    if (composedGroupState.groups.some((group) => group.id === fromConfig)) {
      return fromConfig;
    }
    return composedGroupState.activeGroupId;
  }, [editingConfig.activeComposedRuleGroupId, composedGroupState]);

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
          return true;
        } catch (error) {
          if (saveVersion !== saveVersionRef.current) {
            return false;
          }
          const errorText = error instanceof Error ? error.message : "未知错误";
          message.error(`规则保存失败：${errorText}`);
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

  const replaceComposedGroups = (
    nextGroups: ComposedRuleGroup[],
    nextActiveGroupID: string,
  ): Promise<boolean> => {
    return updateConfig((prev) => {
      const normalized = ensureComposedRuleGroups(nextGroups, undefined, "proxy");
      const activeGroup = normalized.groups.find((group) => group.id === nextActiveGroupID) ?? normalized.groups[0];
      const mode = activeGroup.mode === "direct" ? "direct" : "proxy";
      return {
        ...prev,
        applyMode: mode,
        defaults: mode === "direct" ? { onMatch: "direct", onMiss: "proxy" } : { onMatch: "proxy", onMiss: "direct" },
        composedRuleGroups: normalized.groups,
        activeComposedRuleGroupId: activeGroup.id,
        composedRules: activeGroup.items ?? [],
      };
    });
  };

  const sendBaseRulesToComposedGroup = (groupID: string, baseRuleIDs: string[]): Promise<boolean> => {
    if (baseRuleIDs.length === 0) {
      return Promise.resolve(false);
    }
    const now = Date.now();
    return replaceComposedGroups(
      composedGroupState.groups.map((group) =>
        group.id === groupID
          ? {
              ...group,
              items: [
                ...(group.items ?? []),
                ...baseRuleIDs.map((baseRuleID, index) => ({
                  id: `composed-rule-${now}-${index + 1}`,
                  name: "",
                  baseRuleId: baseRuleID,
                  enabled: true,
                })),
              ],
            }
          : group,
      ),
      activeComposedGroupID,
    );
  };

  const hotReloadRules = async (): Promise<{ status: "updated" | "noop"; message: string }> => {
    try {
      await runAction(() => daemonApi.hotReloadRules());
      return {
        status: "updated",
        message: "规则已热更到内核",
      };
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "未知错误";
      if (errorText.includes("无需更新")) {
        return {
          status: "noop",
          message: "无需更新：活动规则数据与激活分组未变化",
        };
      }
      throw error;
    }
  };

  return (
    <Card loading={loading}>
      <Space
        direction="vertical"
        size={16}
        style={{ width: "100%" }}
      >
        <NodePoolTable
          value={editingConfig.policyGroups ?? []}
          activeNodes={activeGroupNodes}
          onChange={(next: RulePolicyGroup[]) =>
            updateConfig((prev) => ({
              ...prev,
              policyGroups: next,
            }))
          }
        />

        <Divider style={{ margin: "6px 0" }} />

        <BaseRulesTable
          value={editingConfig.baseRules ?? []}
          policyGroups={editingConfig.policyGroups ?? []}
          composedGroups={composedGroupState.groups}
          onSendToComposed={sendBaseRulesToComposedGroup}
          onChange={(next: BaseRuleItem[]) =>
            updateConfig((prev) => ({
              ...prev,
              baseRules: next,
            }))
          }
        />

        <Divider style={{ margin: "6px 0" }} />

        <ComposedRulesTabs
          groups={composedGroupState.groups}
          activeGroupId={activeComposedGroupID}
          baseRules={editingConfig.baseRules ?? []}
          onChange={replaceComposedGroups}
          onHotReloadRules={hotReloadRules}
        />

        <Typography.Text type="secondary">{dirty ? "存在未保存修改" : "已同步到当前快照"}</Typography.Text>
      </Space>
    </Card>
  );
}
