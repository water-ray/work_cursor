import { ipcMain } from "electron";

import type { DaemonRequestPayload } from "../../shared/daemon";
import { ipcChannels } from "../../shared/ipc";
import { requestDaemon } from "../services/daemonClient";

export function registerDaemonIpc(): void {
  ipcMain.removeHandler(ipcChannels.daemonRequest);
  ipcMain.handle(
    ipcChannels.daemonRequest,
    async (_event, payload: DaemonRequestPayload) => {
      return requestDaemon(payload);
    },
  );
}
