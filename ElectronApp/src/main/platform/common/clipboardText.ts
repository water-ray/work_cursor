import { isAbsolute } from "node:path";

export function parseClipboardTextFilePaths(
  text: string,
  options?: {
    isWindows?: boolean;
  },
): string[] {
  const isWindows = options?.isWindows === true;
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let candidate = line;
    if (line.startsWith("file://")) {
      try {
        candidate = decodeURI(new URL(line).pathname);
      } catch {
        continue;
      }
      if (isWindows && /^\/[a-zA-Z]:/.test(candidate)) {
        candidate = candidate.slice(1);
      }
    }
    if (!isAbsolute(candidate)) {
      continue;
    }
    const normalized = isWindows ? candidate.replace(/\//g, "\\") : candidate;
    const key = isWindows ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
