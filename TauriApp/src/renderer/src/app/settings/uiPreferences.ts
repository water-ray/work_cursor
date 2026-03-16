export const uiPreferenceKeys = {
  closeBehavior: "wateray.ui.closeBehavior.v1",
  proxyStartupSmartOptimize: "wateray.ui.proxyStartupSmartOptimize.v1",
} as const;

export type CloseBehavior =
  | "ask_every_time"
  | "minimize_to_tray"
  | "close_panel_keep_core"
  | "exit_all";

export type ProxyStartupSmartOptimizePreference =
  | "off"
  | "best"
  | `country:${string}`;

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
}
