export const ipcChannels = {
  daemonRequest: "wateray:daemon:request",
  daemonPush: "wateray:daemon:push",
  windowMinimize: "wateray:window:minimize",
  windowToggleMaximize: "wateray:window:toggle-maximize",
  windowClose: "wateray:window:close",
  windowIsMaximized: "wateray:window:is-maximized",
  windowMaximizedChanged: "wateray:window:maximized-changed",
} as const;
