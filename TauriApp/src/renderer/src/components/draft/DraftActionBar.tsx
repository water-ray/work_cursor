import { Button } from "antd";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface DraftActionButtonConfig {
  title: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

interface DraftActionBarProps {
  visible: boolean;
  apply: DraftActionButtonConfig;
  discard: DraftActionButtonConfig;
  portalRootId?: string;
}

export function DraftActionBar({
  visible,
  apply,
  discard,
  portalRootId = "app-bottom-overlay-root",
}: DraftActionBarProps) {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalRoot(document.getElementById(portalRootId));
  }, [portalRootId]);

  if (!visible || !portalRoot) {
    return null;
  }

  return createPortal(
    <div className="dns-draft-toolbar">
      <div className="dns-draft-toolbar-inner">
        <Button
          className="dns-draft-submit-btn"
          title={apply.title}
          disabled={apply.disabled}
          loading={apply.loading}
          onClick={apply.onClick}
        >
          <span className="dns-draft-btn-icon-wrap">{apply.icon}</span>
          <span className="dns-draft-btn-label">{apply.label}</span>
        </Button>
        <Button
          className="dns-draft-revert-btn"
          title={discard.title}
          disabled={discard.disabled}
          loading={discard.loading}
          onClick={discard.onClick}
        >
          <span className="dns-draft-btn-label">{discard.label}</span>
          <span className="dns-draft-btn-icon-wrap">{discard.icon}</span>
        </Button>
      </div>
    </div>,
    portalRoot,
  );
}
