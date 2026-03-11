import { useEffect } from "react";

interface UseDraftNavLockParams {
  lockClassName: string;
  enabled: boolean;
}

export function useDraftNavLock({ lockClassName, enabled }: UseDraftNavLockParams) {
  useEffect(() => {
    if (enabled) {
      document.body.classList.add(lockClassName);
    } else {
      document.body.classList.remove(lockClassName);
    }
    return () => {
      document.body.classList.remove(lockClassName);
    };
  }, [enabled, lockClassName]);
}
