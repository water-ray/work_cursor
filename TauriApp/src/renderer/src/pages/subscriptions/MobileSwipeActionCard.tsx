import { Button } from "antd";
import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

const mobileSwipeActionWidthPx = 64;
const mobileSwipeOpenThresholdPx = 36;

export interface MobileSwipeActionItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  autoTriggerOnOpen?: boolean;
  onClick: () => void;
}

interface MobileSwipeActionCardProps {
  leadingActions?: MobileSwipeActionItem[];
  trailingActions?: MobileSwipeActionItem[];
  children: ReactNode;
}

export function MobileSwipeActionCard({
  leadingActions = [],
  trailingActions = [],
  children,
}: MobileSwipeActionCardProps) {
  const enabledLeadingActions = useMemo(
    () => leadingActions.filter((action) => !action.disabled),
    [leadingActions],
  );
  const enabledTrailingActions = useMemo(
    () => trailingActions.filter((action) => !action.disabled),
    [trailingActions],
  );
  const leadingMaxOffset = enabledLeadingActions.length * mobileSwipeActionWidthPx;
  const trailingMaxOffset = enabledTrailingActions.length * mobileSwipeActionWidthPx;
  const [offsetX, setOffsetX] = useState(0);
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startOffset: 0,
    dragging: false,
  });
  const suppressClickRef = useRef(false);

  const closeActions = () => {
    setOffsetX(0);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (leadingMaxOffset <= 0 && trailingMaxOffset <= 0)
    ) {
      return;
    }
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offsetX,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !dragRef.current.active ||
      (leadingMaxOffset <= 0 && trailingMaxOffset <= 0)
    ) {
      return;
    }
    const deltaX = event.clientX - dragRef.current.startX;
    const deltaY = event.clientY - dragRef.current.startY;
    if (!dragRef.current.dragging) {
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        return;
      }
      dragRef.current.dragging = Math.abs(deltaX) > 6;
    }
    if (!dragRef.current.dragging) {
      return;
    }
    const nextOffset = Math.min(
      leadingMaxOffset,
      Math.max(-trailingMaxOffset, dragRef.current.startOffset + deltaX),
    );
    setOffsetX(nextOffset);
  };

  const handlePointerEnd = () => {
    if (!dragRef.current.active) {
      return;
    }
    const wasDragging = dragRef.current.dragging;
    dragRef.current.active = false;
    dragRef.current.dragging = false;
    if (wasDragging) {
      suppressClickRef.current = true;
      window.requestAnimationFrame(() => {
        suppressClickRef.current = false;
      });
    }
    if (leadingMaxOffset <= 0 && trailingMaxOffset <= 0) {
      setOffsetX(0);
      return;
    }
    setOffsetX((current) => {
      if (current >= mobileSwipeOpenThresholdPx && leadingMaxOffset > 0) {
        if (
          enabledLeadingActions.length === 1 &&
          enabledLeadingActions[0]?.autoTriggerOnOpen
        ) {
          window.requestAnimationFrame(() => {
            enabledLeadingActions[0]?.onClick();
          });
          return 0;
        }
        return leadingMaxOffset;
      }
      if (current <= -mobileSwipeOpenThresholdPx && trailingMaxOffset > 0) {
        return -trailingMaxOffset;
      }
      return 0;
    });
  };

  return (
    <div
      className={`mobile-swipe-action-card${offsetX !== 0 ? " is-open" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        className="mobile-swipe-action-card-actions is-leading"
        style={{ width: leadingMaxOffset }}
      >
        {enabledLeadingActions.map((action) => (
          <Button
            key={action.key}
            type="text"
            danger={action.danger}
            className={`mobile-swipe-action-card-action${action.danger ? " is-danger" : ""}`}
            icon={action.icon}
            onClick={() => {
              closeActions();
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
      <div
        className="mobile-swipe-action-card-actions is-trailing"
        style={{ width: trailingMaxOffset }}
      >
        {enabledTrailingActions.map((action) => (
          <Button
            key={action.key}
            type="text"
            danger={action.danger}
            className={`mobile-swipe-action-card-action${action.danger ? " is-danger" : ""}`}
            icon={action.icon}
            onClick={() => {
              closeActions();
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
      <div
        className="mobile-swipe-action-card-content"
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: dragRef.current.dragging ? "none" : "transform 0.18s ease",
        }}
      >
        {children}
      </div>
    </div>
  );
}
