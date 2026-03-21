import { useCallback, useEffect, useSyncExternalStore } from "react";

import { fileIconStore, normalizeFileIconSize } from "../services/fileIconStore";

export function useFileIcon(path: string, sizePx?: number) {
  const normalizedPath = String(path ?? "").trim();
  const normalizedSize = normalizeFileIconSize(sizePx);
  const getSnapshot = useCallback(
    () => fileIconStore.getSnapshot(normalizedPath, normalizedSize),
    [normalizedPath, normalizedSize],
  );
  const snapshot = useSyncExternalStore(fileIconStore.subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (normalizedPath === "") {
      return;
    }
    fileIconStore.ensure(normalizedPath, normalizedSize);
  }, [normalizedPath, normalizedSize]);

  return snapshot;
}
