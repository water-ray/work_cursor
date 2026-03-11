import { clipboard } from "electron";

import type { ClipboardWriteResult } from "../common/types";
import { parseClipboardTextFilePaths } from "../common/clipboardText";

const writeResult: ClipboardWriteResult = {
  mode: "path_text_fallback",
};

export function readClipboardFilePaths(): string[] {
  return parseClipboardTextFilePaths(clipboard.readText());
}

export function writeClipboardFile(filePath: string): ClipboardWriteResult {
  clipboard.writeText(filePath);
  return writeResult;
}
