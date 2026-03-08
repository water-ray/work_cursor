type NoticeCallOptions = {
  title?: string;
  durationMs?: number;
  placement?: "top-right" | "top-center";
};

export type NoticeApiLike = {
  success: (content: string, options?: NoticeCallOptions | number) => void;
  warning: (content: string, options?: NoticeCallOptions | number) => void;
  error: (content: string, options?: NoticeCallOptions | number) => void;
  info: (content: string, options?: NoticeCallOptions | number) => void;
};

interface ConfigMessageOptions {
  restartRequired?: boolean;
  restartHint?: string;
}

interface StartPrecheckIssueLike {
  message?: string;
}

interface StartPrecheckResultLike {
  canStart?: boolean;
  warnings?: StartPrecheckIssueLike[];
  blockers?: StartPrecheckIssueLike[];
}

function collectIssueMessages(items: StartPrecheckIssueLike[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  (items ?? []).forEach((item) => {
    const text = String(item.message ?? "").trim();
    if (text === "") {
      return;
    }
    if (seen.has(text)) {
      return;
    }
    seen.add(text);
    result.push(text);
  });
  return result;
}

function summarizeIssueMessages(messages: string[], label: string): string {
  if (messages.length <= 1) {
    return messages[0] ?? `启动前检查${label}`;
  }
  const preview = messages.slice(0, 2).join("；");
  const remaining = messages.length - 2;
  if (remaining > 0) {
    return `启动前检查${label}（${messages.length}项）：${preview}；等${remaining}项`;
  }
  return `启动前检查${label}（${messages.length}项）：${preview}`;
}

export function notifyConfigSaved(
  messageApi: NoticeApiLike,
  target: string,
  options?: ConfigMessageOptions,
): void {
  messageApi.success(`${target}已保存`);
  if (options?.restartRequired) {
    messageApi.warning(options.restartHint ?? `${target}变更需重启代理服务后生效`);
  }
}

export function notifyConfigApplied(
  messageApi: NoticeApiLike,
  target: string,
  options?: ConfigMessageOptions,
): void {
  if (options?.restartRequired) {
    messageApi.warning(options.restartHint ?? `${target}已应用,需重启代理服务才生效`);
    return;
  }
  messageApi.success(`${target}已应用`);
}

export function notifyConfigActionFailed(
  messageApi: NoticeApiLike,
  target: string,
  error: unknown,
  fallbackAction = "保存失败",
): void {
  messageApi.error(error instanceof Error ? error.message : `${target}${fallbackAction}`);
}

export function notifyConfigDraftReverted(
  messageApi: NoticeApiLike,
  target: string,
): void {
  messageApi.info(`已撤销${target}草稿配置`);
}

export function notifyStartPrecheckResult(
  messageApi: NoticeApiLike,
  result: StartPrecheckResultLike,
): boolean {
  const blockerMessages = collectIssueMessages(result.blockers);
  const warningMessages = collectIssueMessages(result.warnings);
  const blockedByFlag = result.canStart === false;
  if (blockedByFlag || blockerMessages.length > 0) {
    const content =
      blockerMessages.length > 0
        ? summarizeIssueMessages(blockerMessages, "未通过")
        : "启动前检查未通过";
    messageApi.error(content);
    messageApi.info("已取消启动");
    return false;
  }
  if (warningMessages.length > 0) {
    messageApi.warning(summarizeIssueMessages(warningMessages, "告警"));
  }
  return true;
}
