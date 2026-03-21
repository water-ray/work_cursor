import { getPlatformAdapter } from "../platform/runtimeStore";

type Listener = () => void;

export interface FileIconSnapshot {
  key: string;
  path: string;
  sizePx: number;
  url: string | null;
  loading: boolean;
  resolved: boolean;
}

interface FileIconCacheEntry extends FileIconSnapshot {}

const listeners = new Set<Listener>();
const entries = new Map<string, FileIconCacheEntry>();
const placeholderEntries = new Map<string, FileIconCacheEntry>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function normalizeFileIconSize(sizePx?: number): number {
  const parsed = Number(sizePx ?? 20);
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(128, Math.max(16, Math.trunc(parsed)));
}

function normalizeFileIconPath(path: string): string {
  return String(path ?? "").trim();
}

function buildFileIconKey(path: string, sizePx?: number): string {
  return `${normalizeFileIconSize(sizePx)}::${normalizeFileIconPath(path)}`;
}

function buildSnapshot(path: string, sizePx?: number, entry?: FileIconCacheEntry): FileIconSnapshot {
  const normalizedPath = normalizeFileIconPath(path);
  const normalizedSize = normalizeFileIconSize(sizePx);
  if (entry) {
    return entry;
  }
  const key = buildFileIconKey(normalizedPath, normalizedSize);
  const placeholder = placeholderEntries.get(key);
  if (placeholder) {
    return placeholder;
  }
  const created: FileIconCacheEntry = {
    key,
    path: normalizedPath,
    sizePx: normalizedSize,
    url: null,
    loading: false,
    resolved: false,
  };
  placeholderEntries.set(key, created);
  return created;
}

async function loadFileIcon(path: string, sizePx?: number): Promise<void> {
  const normalizedPath = normalizeFileIconPath(path);
  const normalizedSize = normalizeFileIconSize(sizePx);
  if (normalizedPath === "") {
    return;
  }
  const key = buildFileIconKey(normalizedPath, normalizedSize);
  const current = entries.get(key);
  if (current?.loading || current?.resolved) {
    return;
  }
  placeholderEntries.delete(key);
  entries.set(key, {
    key,
    path: normalizedPath,
    sizePx: normalizedSize,
    url: current?.url ?? null,
    loading: true,
    resolved: false,
  });
  emit();
  try {
    const resolved = await getPlatformAdapter().system.getFileIconDataUrl(normalizedPath, normalizedSize);
    const normalizedUrl = String(resolved ?? "").trim();
    placeholderEntries.delete(key);
    entries.set(key, {
      key,
      path: normalizedPath,
      sizePx: normalizedSize,
      url: normalizedUrl === "" ? null : normalizedUrl,
      loading: false,
      resolved: true,
    });
    emit();
  } catch {
    placeholderEntries.delete(key);
    entries.set(key, {
      key,
      path: normalizedPath,
      sizePx: normalizedSize,
      url: null,
      loading: false,
      resolved: true,
    });
    emit();
  }
}

export const fileIconStore = {
  getSnapshot(path: string, sizePx?: number): FileIconSnapshot {
    const normalizedPath = normalizeFileIconPath(path);
    const normalizedSize = normalizeFileIconSize(sizePx);
    return buildSnapshot(
      normalizedPath,
      normalizedSize,
      entries.get(buildFileIconKey(normalizedPath, normalizedSize)),
    );
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  ensure(path: string, sizePx?: number): void {
    void loadFileIcon(path, sizePx);
  },
};
