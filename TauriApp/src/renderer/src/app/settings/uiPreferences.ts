export const uiPreferenceKeys = {
  dragScrollEnabled: "wateray.ui.dragScrollEnabled.v1",
  closeBehavior: "wateray.ui.closeBehavior.v1",
  proxyStartupSmartOptimize: "wateray.ui.proxyStartupSmartOptimize.v1",
} as const;

export const uiPreferenceChangedEventName = "wateray:ui-preference-changed";

export type CloseBehavior =
  | "ask_every_time"
  | "minimize_to_tray"
  | "close_panel_keep_core"
  | "exit_all";

export type ProxyStartupSmartOptimizePreference =
  | "off"
  | "best"
  | `country:${string}`;

export interface UIPreferenceChangedEventDetail {
  key: keyof typeof uiPreferenceKeys;
  value: boolean | CloseBehavior | ProxyStartupSmartOptimizePreference;
}

export function readDragScrollEnabled(): boolean {
  const raw = window.localStorage.getItem(uiPreferenceKeys.dragScrollEnabled);
  if (raw == null) {
    return false;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

export function writeDragScrollEnabled(value: boolean): void {
  window.localStorage.setItem(uiPreferenceKeys.dragScrollEnabled, value ? "1" : "0");
  dispatchPreferenceChanged("dragScrollEnabled", value);
}

export function readCloseBehavior(): CloseBehavior {
  const raw = window.localStorage.getItem(uiPreferenceKeys.closeBehavior);
  switch (raw) {
    case "minimize_to_tray":
    case "close_panel_keep_core":
    case "exit_all":
      return raw;
    default:
      return "ask_every_time";
  }
}

export function writeCloseBehavior(value: CloseBehavior): void {
  window.localStorage.setItem(uiPreferenceKeys.closeBehavior, value);
  dispatchPreferenceChanged("closeBehavior", value);
}

function normalizeProxyStartupSmartOptimizePreference(
  value: string | null | undefined,
): ProxyStartupSmartOptimizePreference {
  const raw = (value ?? "").trim();
  if (raw === "off" || raw === "best") {
    return raw;
  }
  if (raw.startsWith("country:")) {
    const country = raw.slice("country:".length).trim();
    if (country !== "") {
      return `country:${country}`;
    }
  }
  return "off";
}

export function readProxyStartupSmartOptimizePreference(): ProxyStartupSmartOptimizePreference {
  return normalizeProxyStartupSmartOptimizePreference(
    window.localStorage.getItem(uiPreferenceKeys.proxyStartupSmartOptimize),
  );
}

export function writeProxyStartupSmartOptimizePreference(
  value: ProxyStartupSmartOptimizePreference,
): void {
  const normalized = normalizeProxyStartupSmartOptimizePreference(value);
  window.localStorage.setItem(uiPreferenceKeys.proxyStartupSmartOptimize, normalized);
  dispatchPreferenceChanged("proxyStartupSmartOptimize", normalized);
}

function dispatchPreferenceChanged(
  key: keyof typeof uiPreferenceKeys,
  value: boolean | CloseBehavior | ProxyStartupSmartOptimizePreference,
): void {
  window.dispatchEvent(
    new CustomEvent<UIPreferenceChangedEventDetail>(uiPreferenceChangedEventName, {
      detail: {
        key,
        value,
      },
    }),
  );
}
