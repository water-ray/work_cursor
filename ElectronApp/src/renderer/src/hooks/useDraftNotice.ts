import { useMemo } from "react";

import { useAppNotice } from "../components/notify/AppNoticeProvider";
import {
  notifyConfigActionFailed,
  notifyConfigApplied,
  notifyConfigDraftReverted,
  notifyConfigSaved,
} from "../services/configChangeMessage";
import type { DaemonSnapshot } from "../../../shared/daemon";

interface DraftNoticeApi {
  notifySaveSuccess: (target: string, snapshot?: DaemonSnapshot | null) => void;
  notifySaveFailed: (
    target: string,
    error: unknown,
    fallbackAction?: string,
  ) => void;
  notifyDraftReverted: (target: string) => void;
}

export function useDraftNotice(): DraftNoticeApi {
  const notice = useAppNotice();
  return useMemo(
    () => ({
      notifySaveSuccess: (target: string, snapshot?: DaemonSnapshot | null) => {
        const result = snapshot?.lastRuntimeApply?.result;
        if (result === "hot_applied") {
          notifyConfigApplied(notice, target);
          return;
        }
        if (result === "restart_required") {
          notifyConfigSaved(notice, target, {
            restartRequired: true,
          });
          return;
        }
        notifyConfigSaved(notice, target);
      },
      notifySaveFailed: (
        target: string,
        error: unknown,
        fallbackAction = "保存失败",
      ) => {
        notifyConfigActionFailed(notice, target, error, fallbackAction);
      },
      notifyDraftReverted: (target: string) => {
        notifyConfigDraftReverted(notice, target);
      },
    }),
    [notice],
  );
}
