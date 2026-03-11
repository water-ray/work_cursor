import { ipcMain } from "electron";

import type { DaemonRequestPayload } from "../../shared/daemon";
import { ipcChannels } from "../../shared/ipc";
import {
  abortDaemonRequestsForWebContents,
} from "../services/daemonClient";
import { daemonTransportManager } from "../services/daemonTransportManager";

const boundWebContentsIDs = new Set<number>();

function bindDaemonRequestCleanup(webContents: Electron.WebContents): void {
  if (boundWebContentsIDs.has(webContents.id)) {
    return;
  }
  boundWebContentsIDs.add(webContents.id);
  webContents.once("destroyed", () => {
    boundWebContentsIDs.delete(webContents.id);
    abortDaemonRequestsForWebContents(webContents.id);
  });
}

export function registerDaemonIpc(): void {
  ipcMain.removeHandler(ipcChannels.daemonRequest);
  ipcMain.removeHandler(ipcChannels.daemonAbortPendingRequests);
  ipcMain.removeHandler(ipcChannels.daemonGetTransportStatus);
  ipcMain.handle(
    ipcChannels.daemonRequest,
    async (event, payload: DaemonRequestPayload) => {
      bindDaemonRequestCleanup(event.sender);
      return daemonTransportManager.request(payload, { webContentsId: event.sender.id });
    },
  );
  ipcMain.handle(ipcChannels.daemonAbortPendingRequests, async (event) => {
    abortDaemonRequestsForWebContents(
      event.sender.id,
      "当前页面已取消等待，已中止挂起的内核请求",
    );
  });
  ipcMain.handle(ipcChannels.daemonGetTransportStatus, async () => {
    return daemonTransportManager.getStatus();
  });
}
