import { clipboard } from "electron";

import type { ClipboardWriteResult } from "../common/types";
import { parseClipboardTextFilePaths } from "../common/clipboardText";

function parseWindowsFileNameWBuffer(raw: Buffer): string[] {
  if (!raw || raw.length === 0) {
    return [];
  }
  const decoded = raw.toString("utf16le");
  const items = decoded
    .split("\u0000")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = item.replace(/\//g, "\\");
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

const writeResult: ClipboardWriteResult = {
  mode: "windows_file_object",
};

export function readClipboardFilePaths(): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const formats = clipboard.availableFormats();
  const hasFileNameW = formats.some((format) => format === "FileNameW");
  if (hasFileNameW) {
    const paths = parseWindowsFileNameWBuffer(clipboard.readBuffer("FileNameW"));
    for (const path of paths) {
      const key = path.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(path);
    }
  }
  const textPaths = parseClipboardTextFilePaths(clipboard.readText(), {
    isWindows: true,
  });
  for (const path of textPaths) {
    const key = path.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(path);
  }
  return result;
}

export function writeClipboardFile(filePath: string): ClipboardWriteResult {
  const payload = Buffer.from(`${filePath}\u0000`, "utf16le");
  clipboard.clear();
  clipboard.writeBuffer("FileNameW", payload);
  clipboard.writeText(filePath);
  return writeResult;
}
