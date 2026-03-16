import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { BiIcon } from "../icons/BiIcon";
import { isMobileRuntime } from "../../platform/runtimeStore";

type AppNoticeLevel = "success" | "warning" | "error" | "info";
export type AppNoticePlacement = "top-right" | "top-center";

interface AppNoticeItem {
  id: number;
  level: AppNoticeLevel;
  title: string;
  content: string;
  placement: AppNoticePlacement;
  createdAtMs: number;
}

interface NoticeTimerState {
  timeoutId: number | null;
  remainingMs: number;
  startedAtMs: number;
}

interface AppNoticeProviderProps {
  children: ReactNode;
}

export interface AppNoticeApi {
  success: (content: string, options?: AppNoticeOptions | number) => void;
  warning: (content: string, options?: AppNoticeOptions | number) => void;
  error: (content: string, options?: AppNoticeOptions | number) => void;
  info: (content: string, options?: AppNoticeOptions | number) => void;
}

export interface AppNoticeHistoryItem {
  id: number;
  level: AppNoticeLevel;
  title: string;
  content: string;
  placement: AppNoticePlacement;
  createdAtMs: number;
}

interface AppNoticeHistoryApi {
  recentItems: AppNoticeHistoryItem[];
  unreadCount: number;
  markAllRead: () => void;
}

export interface AppNoticeOptions {
  title?: string;
  durationMs?: number;
  placement?: AppNoticePlacement;
}

export interface AppExternalNoticeDetail {
  level: AppNoticeLevel;
  content: string;
  title?: string;
  durationMs?: number;
  placement?: AppNoticePlacement;
  toast?: boolean;
}

const appNoticeDurationMs: Record<AppNoticeLevel, number> = {
  success: 2600,
  warning: 3200,
  error: 3800,
  info: 2400,
};
const maxVisibleNoticesByPlacement: Record<AppNoticePlacement, number> = {
  "top-right": 4,
  "top-center": 2,
};
const maxRecentNoticeItems = 50;
export const appExternalNoticeEventName = "wateray:app-external-notice";

function resolveMaxVisibleNotices(placement: AppNoticePlacement): number {
  if (placement === "top-center" && isMobileNoticeRuntime()) {
    return 1;
  }
  return maxVisibleNoticesByPlacement[placement];
}

const AppNoticeContext = createContext<AppNoticeApi | null>(null);
const AppNoticeHistoryContext = createContext<AppNoticeHistoryApi | null>(null);

function isMobileNoticeRuntime(): boolean {
  try {
    return isMobileRuntime();
  } catch {
    return false;
  }
}

function levelIcon(level: AppNoticeLevel): string {
  switch (level) {
    case "success":
      return "check-circle-fill";
    case "warning":
      return "exclamation-triangle-fill";
    case "error":
      return "x-circle-fill";
    default:
      return "info-circle-fill";
  }
}

function levelTitle(level: AppNoticeLevel): string {
  switch (level) {
    case "success":
      return "成功";
    case "warning":
      return "提醒";
    case "error":
      return "失败";
    default:
      return "信息";
  }
}

function resolveNoticeOptions(
  level: AppNoticeLevel,
  options?: AppNoticeOptions | number,
): {
  title: string;
  durationMs: number;
  placement: AppNoticePlacement;
} {
  const mobilePlacement: AppNoticePlacement = "top-center";
  if (typeof options === "number") {
    if (Number.isFinite(options)) {
      return {
        title: levelTitle(level),
        durationMs: Math.max(0, Math.round(options * 1000)),
        placement: isMobileNoticeRuntime() ? mobilePlacement : "top-right",
      };
    }
    return {
      title: levelTitle(level),
      durationMs: appNoticeDurationMs[level],
      placement: isMobileNoticeRuntime() ? mobilePlacement : "top-right",
    };
  }
  const title = String(options?.title ?? "").trim() || levelTitle(level);
  const durationRaw = options?.durationMs;
  const durationMs =
    Number.isFinite(durationRaw) && (durationRaw ?? 0) >= 0
      ? Math.round(durationRaw as number)
      : appNoticeDurationMs[level];
  return {
    title,
    durationMs,
    placement: isMobileNoticeRuntime()
      ? mobilePlacement
      : (options?.placement === "top-center" ? "top-center" : "top-right"),
  };
}

export function AppNoticeProvider({ children }: AppNoticeProviderProps) {
  const portalRoot = typeof document === "undefined" ? null : document.body;
  const mobileNoticeRuntime = isMobileNoticeRuntime();
  const [notices, setNotices] = useState<AppNoticeItem[]>([]);
  const [recentItems, setRecentItems] = useState<AppNoticeHistoryItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const nextIdRef = useRef(1);
  const timerRef = useRef<Map<number, NoticeTimerState>>(new Map());

  const clearNoticeTimer = useCallback((id: number): void => {
    const timerState = timerRef.current.get(id);
    if (timerState?.timeoutId != null) {
      window.clearTimeout(timerState.timeoutId);
    }
    timerRef.current.delete(id);
  }, []);

  const removeNotice = useCallback(
    (id: number): void => {
      clearNoticeTimer(id);
      setNotices((previous) => previous.filter((item) => item.id !== id));
    },
    [clearNoticeTimer],
  );

  const scheduleNoticeTimer = useCallback(
    (id: number, delayMs: number): void => {
      const normalizedDelay = Math.max(0, Math.round(delayMs));
      if (normalizedDelay <= 0) {
        removeNotice(id);
        return;
      }
      clearNoticeTimer(id);
      const startedAtMs = Date.now();
      const timeoutId = window.setTimeout(() => {
        removeNotice(id);
      }, normalizedDelay);
      timerRef.current.set(id, {
        timeoutId,
        remainingMs: normalizedDelay,
        startedAtMs,
      });
    },
    [clearNoticeTimer, removeNotice],
  );

  const pauseNoticeTimer = useCallback((id: number): void => {
    const timerState = timerRef.current.get(id);
    if (!timerState || timerState.timeoutId == null) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - timerState.startedAtMs);
    const remainingMs = Math.max(0, timerState.remainingMs - elapsedMs);
    window.clearTimeout(timerState.timeoutId);
    timerRef.current.set(id, {
      timeoutId: null,
      remainingMs,
      startedAtMs: 0,
    });
  }, []);

  const resumeNoticeTimer = useCallback(
    (id: number): void => {
      const timerState = timerRef.current.get(id);
      if (!timerState || timerState.timeoutId != null) {
        return;
      }
      if (timerState.remainingMs <= 0) {
        removeNotice(id);
        return;
      }
      scheduleNoticeTimer(id, timerState.remainingMs);
    },
    [removeNotice, scheduleNoticeTimer],
  );

  useEffect(() => {
    return () => {
      timerRef.current.forEach((timerState) => {
        if (timerState.timeoutId != null) {
          window.clearTimeout(timerState.timeoutId);
        }
      });
      timerRef.current.clear();
    };
  }, []);

  const pushNotice = useCallback(
    (
      level: AppNoticeLevel,
      content: string,
      options?: AppNoticeOptions | number,
      toast = true,
    ): void => {
      const text = String(content ?? "").trim();
      if (text === "") {
        return;
      }
      const id = nextIdRef.current++;
      const resolved = resolveNoticeOptions(level, options);
      const createdAtMs = Date.now();
      if (toast && resolved.durationMs > 0) {
        scheduleNoticeTimer(id, resolved.durationMs);
      }
      setUnreadCount((previous) => previous + 1);
      setRecentItems((previous) => {
        const next = [
          {
            id,
            level,
            title: resolved.title,
            content: text,
            placement: resolved.placement,
            createdAtMs,
          },
          ...previous,
        ];
        return next.slice(0, maxRecentNoticeItems);
      });
      setNotices((previous) => {
        if (!toast) {
          return previous;
        }
        const next = [
          ...previous,
          {
            id,
            level,
            title: resolved.title,
            content: text,
            placement: resolved.placement,
            createdAtMs,
          },
        ];
        const samePlacementItems = next.filter((item) => item.placement === resolved.placement);
        const maxVisible = resolveMaxVisibleNotices(resolved.placement);
        if (samePlacementItems.length <= maxVisible) {
          return next;
        }
        const overflowIDs = new Set(
          samePlacementItems
            .slice(0, samePlacementItems.length - maxVisible)
            .map((item) => item.id),
        );
        overflowIDs.forEach((noticeID) => {
          clearNoticeTimer(noticeID);
        });
        return next.filter((item) => !overflowIDs.has(item.id));
      });
    },
    [clearNoticeTimer, scheduleNoticeTimer],
  );

  useEffect(() => {
    const onExternalNotice = (event: Event) => {
      const customEvent = event as CustomEvent<AppExternalNoticeDetail>;
      const detail = customEvent.detail;
      if (!detail) {
        return;
      }
      pushNotice(
        detail.level,
        detail.content,
        {
          title: detail.title,
          durationMs: detail.durationMs,
          placement: detail.placement,
        },
        detail.toast === true,
      );
    };
    window.addEventListener(appExternalNoticeEventName, onExternalNotice as EventListener);
    return () => {
      window.removeEventListener(appExternalNoticeEventName, onExternalNotice as EventListener);
    };
  }, [pushNotice]);

  const noticeApi = useMemo<AppNoticeApi>(
    () => ({
      success: (content: string, options?: AppNoticeOptions | number) =>
        pushNotice("success", content, options),
      warning: (content: string, options?: AppNoticeOptions | number) =>
        pushNotice("warning", content, options),
      error: (content: string, options?: AppNoticeOptions | number) =>
        pushNotice("error", content, options),
      info: (content: string, options?: AppNoticeOptions | number) =>
        pushNotice("info", content, options),
    }),
    [pushNotice],
  );

  const noticeHistoryApi = useMemo<AppNoticeHistoryApi>(
    () => ({
      recentItems,
      unreadCount,
      markAllRead: () => {
        setUnreadCount(0);
      },
    }),
    [recentItems, unreadCount],
  );

  const noticesByPlacement = useMemo(
    () => ({
      topRight: notices.filter((item) => item.placement === "top-right"),
      topCenter: notices.filter((item) => item.placement === "top-center"),
    }),
    [notices],
  );

  return (
    <AppNoticeContext.Provider value={noticeApi}>
      <AppNoticeHistoryContext.Provider value={noticeHistoryApi}>
        {children}
        {portalRoot
          ? createPortal(
              <div className="app-notice-layer">
                {noticesByPlacement.topRight.length > 0 ? (
                  <div
                    className={`app-notice-viewport app-notice-viewport-top-right${
                      mobileNoticeRuntime ? " app-notice-viewport-mobile" : ""
                    }`}
                  >
                    {noticesByPlacement.topRight.map((item) => (
                      <div
                        key={item.id}
                        className={`app-notice-card app-notice-card-${item.level}${
                          mobileNoticeRuntime ? " app-notice-card-mobile" : ""
                        }`}
                        role={item.level === "error" ? "alert" : "status"}
                        onMouseEnter={() => {
                          pauseNoticeTimer(item.id);
                        }}
                        onMouseLeave={() => {
                          resumeNoticeTimer(item.id);
                        }}
                      >
                        <span className="app-notice-card-icon">
                          <BiIcon name={levelIcon(item.level)} />
                        </span>
                        <div className="app-notice-card-main">
                          <div className="app-notice-card-title">{item.title}</div>
                          <div className="app-notice-card-text">{item.content}</div>
                        </div>
                        <button
                          type="button"
                          className="app-notice-close-btn"
                          onClick={() => {
                            removeNotice(item.id);
                          }}
                          aria-label="关闭通知"
                        >
                          <BiIcon name="x-lg" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {noticesByPlacement.topCenter.length > 0 ? (
                  <div
                    className={`app-notice-viewport app-notice-viewport-top-center${
                      mobileNoticeRuntime ? " app-notice-viewport-mobile" : ""
                    }`}
                  >
                    {noticesByPlacement.topCenter.map((item) => (
                      <div
                        key={item.id}
                        className={`app-notice-card app-notice-card-${item.level}${
                          mobileNoticeRuntime ? " app-notice-card-mobile" : ""
                        }`}
                        role={item.level === "error" ? "alert" : "status"}
                        onMouseEnter={() => {
                          pauseNoticeTimer(item.id);
                        }}
                        onMouseLeave={() => {
                          resumeNoticeTimer(item.id);
                        }}
                      >
                        <span className="app-notice-card-icon">
                          <BiIcon name={levelIcon(item.level)} />
                        </span>
                        <div className="app-notice-card-main">
                          <div className="app-notice-card-title">{item.title}</div>
                          <div className="app-notice-card-text">{item.content}</div>
                        </div>
                        <button
                          type="button"
                          className="app-notice-close-btn"
                          onClick={() => {
                            removeNotice(item.id);
                          }}
                          aria-label="关闭通知"
                        >
                          <BiIcon name="x-lg" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>,
              portalRoot,
            )
          : null}
      </AppNoticeHistoryContext.Provider>
    </AppNoticeContext.Provider>
  );
}

export function useAppNotice(): AppNoticeApi {
  const context = useContext(AppNoticeContext);
  if (!context) {
    throw new Error("useAppNotice must be used within AppNoticeProvider");
  }
  return context;
}

export function useAppNoticeHistory(): AppNoticeHistoryApi {
  const context = useContext(AppNoticeHistoryContext);
  if (!context) {
    throw new Error("useAppNoticeHistory must be used within AppNoticeProvider");
  }
  return context;
}

export function emitAppExternalNotice(detail: AppExternalNoticeDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AppExternalNoticeDetail>(appExternalNoticeEventName, {
      detail,
    }),
  );
}
