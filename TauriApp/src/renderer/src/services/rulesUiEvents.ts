const rulesUiActionEventName = "wateray:rules-ui-action";
const rulesUiStateEventName = "wateray:rules-ui-state";

export type RulesUiAction = "open_add_group";

interface RulesUiActionDetail {
  action: RulesUiAction;
}

interface RulesUiStateDetail {
  activeGroupId?: string;
  activeGroupName?: string;
}

export function dispatchRulesUiAction(action: RulesUiAction): void {
  window.dispatchEvent(
    new CustomEvent<RulesUiActionDetail>(rulesUiActionEventName, {
      detail: { action },
    }),
  );
}

export function listenRulesUiAction(
  listener: (detail: RulesUiActionDetail) => void,
): () => void {
  const handleEvent = (event: Event) => {
    const customEvent = event as CustomEvent<RulesUiActionDetail>;
    if (!customEvent.detail?.action) {
      return;
    }
    listener(customEvent.detail);
  };
  window.addEventListener(rulesUiActionEventName, handleEvent as EventListener);
  return () => {
    window.removeEventListener(rulesUiActionEventName, handleEvent as EventListener);
  };
}

export function dispatchRulesUiState(detail: RulesUiStateDetail): void {
  window.dispatchEvent(
    new CustomEvent<RulesUiStateDetail>(rulesUiStateEventName, {
      detail,
    }),
  );
}

export function listenRulesUiState(
  listener: (detail: RulesUiStateDetail) => void,
): () => void {
  const handleEvent = (event: Event) => {
    const customEvent = event as CustomEvent<RulesUiStateDetail>;
    listener(customEvent.detail ?? {});
  };
  window.addEventListener(rulesUiStateEventName, handleEvent as EventListener);
  return () => {
    window.removeEventListener(rulesUiStateEventName, handleEvent as EventListener);
  };
}
