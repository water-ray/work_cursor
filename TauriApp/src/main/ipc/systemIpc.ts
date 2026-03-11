import { promises as fsp } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
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
import { platformServices } from "../platform/common/platformServices";

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
    return platformServices.clipboard.readClipboardFilePaths();
  });

  ipcMain.handle(ipcChannels.systemWriteClipboardFile, async (_event, filePath: string) => {
    const targetPath = String(filePath ?? "").trim();
    if (!targetPath) {
      throw new Error("file path is required");
    }
    await ensureTextFile(targetPath);
    return platformServices.clipboard.writeClipboardFile(targetPath);
  });
}

