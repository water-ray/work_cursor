import { Button, Tooltip } from "antd";
import type { DaemonSnapshot } from "../../../../shared/daemon";
import { ProxySmartOptimizeSelect } from "../../pages/proxy/ProxySmartOptimizeSelect";
import { BiIcon } from "../../components/icons/BiIcon";
import { dispatchSubscriptionsUiAction } from "../../services/subscriptionsUiEvents";

interface MobileSubscriptionsQuickBarProps {
  snapshot: DaemonSnapshot | null;
  loading: boolean;
}

export function MobileSubscriptionsQuickBar({
  snapshot,
  loading,
}: MobileSubscriptionsQuickBarProps) {
  return (
    <div className="mobile-proxy-control-secondary-row">
      <Tooltip title="扫码导入暂未接入">
        <Button
          type="text"
          className="mobile-proxy-control-secondary-icon-btn"
          icon={<BiIcon name="qr-code-scan" />}
          disabled
        />
      </Tooltip>
      <ProxySmartOptimizeSelect
        snapshot={snapshot}
        disabled={!snapshot || loading}
        className="mobile-proxy-control-secondary-select-wrap"
        selectClassName="proxy-startup-smart-optimize-select mobile-proxy-control-secondary-select"
        showHint={false}
      />
      <Tooltip title="添加订阅/普通分组">
        <Button
          type="text"
          className="mobile-proxy-control-secondary-icon-btn"
          icon={<BiIcon name="plus-circle" />}
          onClick={() => {
            dispatchSubscriptionsUiAction("open_add_group");
          }}
        />
      </Tooltip>
    </div>
  );
}
