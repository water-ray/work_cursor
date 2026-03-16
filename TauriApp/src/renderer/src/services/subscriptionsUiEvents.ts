const subscriptionsUiEventName = "wateray:subscriptions-ui-action";

export type SubscriptionsUiAction = "open_add_group";

interface SubscriptionsUiActionDetail {
  action: SubscriptionsUiAction;
}

export function dispatchSubscriptionsUiAction(action: SubscriptionsUiAction): void {
  window.dispatchEvent(
    new CustomEvent<SubscriptionsUiActionDetail>(subscriptionsUiEventName, {
      detail: { action },
    }),
  );
}

export function listenSubscriptionsUiAction(
  listener: (detail: SubscriptionsUiActionDetail) => void,
): () => void {
  const handleEvent = (event: Event) => {
    const customEvent = event as CustomEvent<SubscriptionsUiActionDetail>;
    if (!customEvent.detail?.action) {
      return;
    }
    listener(customEvent.detail);
  };
  window.addEventListener(subscriptionsUiEventName, handleEvent as EventListener);
  return () => {
    window.removeEventListener(subscriptionsUiEventName, handleEvent as EventListener);
  };
}
