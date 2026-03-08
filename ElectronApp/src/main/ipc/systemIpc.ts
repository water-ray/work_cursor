import { promises as fsp } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";

import { ipcChannels } from "../../shared/ipc";

const maxClipboardTextBytes = 16 * 1024 * 1024;

function resolveWindow(webContentsId: number): BrowserWindow | null {
  const candidate = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === webContentsId,
  );
  return candidate ?? null;
}

function normalizeFileName(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) {
    return "wateray_export.json";
  }
  const base = basename(text);
  if (!base) {
    return "wateray_export.json";
  }
  const extension = extname(base).toLowerCase();
  if (!extension) {
    return `${base}.json`;
  }
  return base;
}

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
    if (!isAbsolute(item)) {
      continue;
    }
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

function parseClipboardTextFilePaths(text: string): string[] {
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
      if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(candidate)) {
        candidate = candidate.slice(1);
      }
    }
    if (!isAbsolute(candidate)) {
      continue;
    }
    const normalized =
      process.platform === "win32"
        ? candidate.replace(/\//g, "\\")
        : candidate;
    const key =
      process.platform === "win32"
        ? normalized.toLowerCase()
        : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

async function ensureTextFile(path: string): Promise<void> {
  const stat = await fsp.stat(path);
  if (!stat.isFile()) {
    throw new Error("target path is not a file");
  }
}

export function registerSystemIpc(): void {
  ipcMain.removeHandler(ipcChannels.systemOpenImportFileDialog);
  ipcMain.removeHandler(ipcChannels.systemOpenExportSaveDialog);
  ipcMain.removeHandler(ipcChannels.systemReadTextFile);
  ipcMain.removeHandler(ipcChannels.systemWriteTextFile);
  ipcMain.removeHandler(ipcChannels.systemWriteTempTextFile);
  ipcMain.removeHandler(ipcChannels.systemReadClipboardText);
  ipcMain.removeHandler(ipcChannels.systemWriteClipboardText);
  ipcMain.removeHandler(ipcChannels.systemReadClipboardFilePaths);
  ipcMain.removeHandler(ipcChannels.systemWriteClipboardFile);

  ipcMain.handle(ipcChannels.systemOpenImportFileDialog, async (event) => {
    const window = resolveWindow(event.sender.id);
    const options: OpenDialogOptions = {
      title: "选择配置文件",
      properties: ["openFile"],
      filters: [
        { name: "配置文件", extensions: ["json", "json"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    ipcChannels.systemOpenExportSaveDialog,
    async (event, rawDefaultFileName: string | undefined) => {
      const window = resolveWindow(event.sender.id);
      const options: SaveDialogOptions = {
        title: "导出配置",
        defaultPath: normalizeFileName(rawDefaultFileName),
        filters: [
          { name: "配置文件", extensions: ["json"] },
          { name: "全部文件", extensions: ["*"] },
        ],
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return null;
      }
      return result.filePath;
    },
  );

  ipcMain.handle(
    ipcChannels.systemReadTextFile,
    async (_event, filePath: string) => {
      const targetPath = String(filePath ?? "").trim();
      if (!targetPath) {
        throw new Error("file path is required");
      }
      await ensureTextFile(targetPath);
      const buffer = await fsp.readFile(targetPath);
      if (buffer.length > maxClipboardTextBytes) {
        throw new Error("file content is too large");
      }
      return buffer.toString("utf-8");
    },
  );

  ipcMain.handle(
    ipcChannels.systemWriteTextFile,
    async (_event, payload: { path?: string; content?: string }) => {
      const targetPath = String(payload?.path ?? "").trim();
      if (!targetPath) {
        throw new Error("file path is required");
      }
      const content = String(payload?.content ?? "");
      await fsp.mkdir(dirname(targetPath), { recursive: true });
      await fsp.writeFile(targetPath, content, "utf-8");
      return targetPath;
    },
  );

  ipcMain.handle(
    ipcChannels.systemWriteTempTextFile,
    async (_event, payload: { fileName?: string; content?: string }) => {
      const fileName = normalizeFileName(payload?.fileName);
      const content = String(payload?.content ?? "");
      const exportDir = join(tmpdir(), "wateray", "config-export");
      await fsp.mkdir(exportDir, { recursive: true });
      const filePath = join(exportDir, fileName);
      await fsp.writeFile(filePath, content, "utf-8");
      return filePath;
    },
  );

  ipcMain.handle(ipcChannels.systemReadClipboardText, () => {
    return clipboard.readText();
  });

  ipcMain.handle(ipcChannels.systemWriteClipboardText, (_event, text: string) => {
    clipboard.writeText(String(text ?? ""));
  });

  ipcMain.handle(ipcChannels.systemReadClipboardFilePaths, () => {
    const result: string[] = [];
    const seen = new Set<string>();
    if (process.platform === "win32") {
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
    }
    const textPaths = parseClipboardTextFilePaths(clipboard.readText());
    for (const path of textPaths) {
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(path);
    }
    return result;
  });

  ipcMain.handle(ipcChannels.systemWriteClipboardFile, async (_event, filePath: string) => {
    const targetPath = String(filePath ?? "").trim();
    if (!targetPath) {
      throw new Error("file path is required");
    }
    await ensureTextFile(targetPath);
    if (process.platform === "win32") {
      const payload = Buffer.from(`${targetPath}\u0000`, "utf16le");
      clipboard.clear();
      clipboard.writeBuffer("FileNameW", payload);
      clipboard.writeText(targetPath);
      return { mode: "windows_file_object" };
    }
    clipboard.writeText(targetPath);
    return { mode: "path_text_fallback" };
  });
}

