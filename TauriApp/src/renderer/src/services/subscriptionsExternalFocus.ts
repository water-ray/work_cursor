export const subscriptionsExternalFocusEventName = "wateray:subscriptions-external-focus";

export interface SubscriptionsExternalFocusDetail {
  groupId: string;
  nodeId: string;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDetail(
  value: unknown,
): SubscriptionsExternalFocusDetail | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const groupId = normalizeText(record.groupId);
  const nodeId = normalizeText(record.nodeId);
  if (groupId === "" || nodeId === "") {
    return null;
  }
  return {
    groupId,
    nodeId,
  };
}

export function emitSubscriptionsExternalFocus(
  detail: SubscriptionsExternalFocusDetail,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const normalized = normalizeDetail(detail);
  if (!normalized) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<SubscriptionsExternalFocusDetail>(
      subscriptionsExternalFocusEventName,
      {
        detail: normalized,
      },
    ),
  );
}

export function listenSubscriptionsExternalFocus(
  listener: (detail: SubscriptionsExternalFocusDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onEvent = (event: Event) => {
    const customEvent = event as CustomEvent<SubscriptionsExternalFocusDetail>;
    const normalized = normalizeDetail(customEvent.detail);
    if (!normalized) {
      return;
    }
    listener(normalized);
  };
  window.addEventListener(
    subscriptionsExternalFocusEventName,
    onEvent as EventListener,
  );
  return () => {
    window.removeEventListener(
      subscriptionsExternalFocusEventName,
      onEvent as EventListener,
    );
  };
}
