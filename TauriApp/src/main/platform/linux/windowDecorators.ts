import type { BrowserWindow } from "electron";

import { applyWindowProcessIcon } from "../../services/appIcon";

export function decorateMainWindow(window: BrowserWindow): void {
  void applyWindowProcessIcon(window);
}
