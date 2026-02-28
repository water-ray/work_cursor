export const uiPreferenceKeys = {
  dragScrollEnabled: "wateray.ui.dragScrollEnabled.v1",
} as const;

export const uiPreferenceChangedEventName = "wateray:ui-preference-changed";

export interface UIPreferenceChangedEventDetail {
  key: keyof typeof uiPreferenceKeys;
  value: boolean;
}

export function readDragScrollEnabled(): boolean {
  const raw = window.localStorage.getItem(uiPreferenceKeys.dragScrollEnabled);
  if (raw == null) {
    return true;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

export function writeDragScrollEnabled(value: boolean): void {
  window.localStorage.setItem(uiPreferenceKeys.dragScrollEnabled, value ? "1" : "0");
  window.dispatchEvent(
    new CustomEvent<UIPreferenceChangedEventDetail>(uiPreferenceChangedEventName, {
      detail: {
        key: "dragScrollEnabled",
        value,
      },
    }),
  );
}
