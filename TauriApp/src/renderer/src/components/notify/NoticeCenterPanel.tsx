import { Button, Typography } from "antd";
import { useEffect } from "react";

import { BiIcon } from "../icons/BiIcon";
import { useAppNoticeHistory } from "./AppNoticeProvider";

interface NoticeCenterPanelProps {
  open: boolean;
  variant?: "desktop" | "mobile";
  onClose: () => void;
}

function formatNoticeTime(value: number): string {
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "-";
  }
}

export function NoticeCenterPanel({
  open,
  variant = "mobile",
  onClose,
}: NoticeCenterPanelProps) {
  const noticeHistory = useAppNoticeHistory();

  useEffect(() => {
    if (!open) {
      return;
    }
    noticeHistory.markAllRead();
  }, [open, noticeHistory]);

  if (!open) {
    return null;
  }

  const overlayClassName =
    variant === "mobile"
      ? "notice-center-overlay notice-center-overlay-mobile"
      : "notice-center-overlay";
  const panelClassName =
    variant === "mobile"
      ? "notice-center-panel notice-center-panel-mobile"
      : "notice-center-panel";

  return (
    <div className={overlayClassName} onClick={onClose}>
      <div className={panelClassName} onClick={(event) => event.stopPropagation()}>
        <div className="notice-center-panel-header">
          <div>
            <div className="notice-center-panel-title">近期通知</div>
            <div className="notice-center-panel-subtitle">
              最近 {noticeHistory.recentItems.length} 条
            </div>
          </div>
          <Button
            type="text"
            size="small"
            className="task-center-panel-close"
            icon={<BiIcon name="x-lg" />}
            onClick={onClose}
          />
        </div>
        <div className="notice-center-panel-body">
          <div className="notice-center-list">
            {noticeHistory.recentItems.length > 0 ? (
              noticeHistory.recentItems.map((item) => (
                <div
                  key={item.id}
                  className={`notice-center-item notice-center-item-${item.level}`}
                >
                  <div className="notice-center-item-head">
                    <span className="notice-center-item-icon">
                      <BiIcon
                        name={item.level === "success"
                          ? "check-circle-fill"
                          : item.level === "warning"
                            ? "exclamation-triangle-fill"
                            : item.level === "error"
                              ? "x-circle-fill"
                              : "info-circle-fill"}
                      />
                    </span>
                    <div className="notice-center-item-main">
                      <div className="notice-center-item-title-row">
                        <Typography.Text strong>{item.title}</Typography.Text>
                        <Typography.Text type="secondary" className="notice-center-item-time">
                          {formatNoticeTime(item.createdAtMs)}
                        </Typography.Text>
                      </div>
                      <div className="notice-center-item-text">{item.content}</div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <Typography.Text type="secondary">暂无通知记录</Typography.Text>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
