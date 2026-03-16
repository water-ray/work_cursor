import { Button, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

import type { DaemonSnapshot } from "../../../../shared/daemon";
import { BiIcon } from "../../components/icons/BiIcon";
import {
  dispatchRulesUiAction,
  listenRulesUiState,
} from "../../services/rulesUiEvents";

interface MobileRulesQuickBarProps {
  snapshot: DaemonSnapshot | null;
}

function resolveSnapshotActiveRuleGroupName(snapshot: DaemonSnapshot | null): string {
  const groups = snapshot?.ruleConfigV2?.groups ?? [];
  if (groups.length === 0) {
    return "未设置";
  }
  const activeGroupId = String(snapshot?.ruleConfigV2?.activeGroupId ?? "").trim();
  const activeGroup =
    groups.find((group) => group.id === activeGroupId) ??
    groups[0];
  return String(activeGroup?.name ?? activeGroup?.id ?? "").trim() || "未设置";
}

export function MobileRulesQuickBar({ snapshot }: MobileRulesQuickBarProps) {
  const snapshotActiveGroupName = useMemo(
    () => resolveSnapshotActiveRuleGroupName(snapshot),
    [snapshot],
  );
  const [uiActiveGroupName, setUiActiveGroupName] = useState("");

  useEffect(() => {
    return listenRulesUiState((detail) => {
      setUiActiveGroupName(String(detail.activeGroupName ?? "").trim());
    });
  }, []);

  const activeGroupName = uiActiveGroupName || snapshotActiveGroupName;

  return (
    <div className="mobile-proxy-control-secondary-row mobile-proxy-control-secondary-row-rules">
      <div className="mobile-proxy-control-secondary-title-wrap">
        <Typography.Text strong className="mobile-proxy-control-secondary-title">
          [规则] {activeGroupName}
        </Typography.Text>
      </div>
      <Tooltip title="添加规则分组">
        <Button
          type="text"
          className="mobile-proxy-control-secondary-icon-btn"
          icon={<BiIcon name="plus-circle" />}
          onClick={() => {
            dispatchRulesUiAction("open_add_group");
          }}
        />
      </Tooltip>
    </div>
  );
}
