interface ActionRateLimiterOptions {
  windowMs: number;
  maxHits: number;
  minIntervalMs?: number;
  blockMs?: number;
}

interface ActionRateLimiterState {
  historyMs: number[];
  lastActionMs: number;
  blockedUntilMs: number;
}

export interface ActionRateLimiterResult {
  ok: boolean;
  retryAfterMs: number;
  reason: "ok" | "too_frequent" | "rate_limited";
}

export function createActionRateLimiter(options: ActionRateLimiterOptions) {
  const windowMs = Math.max(1000, Math.trunc(options.windowMs));
  const maxHits = Math.max(1, Math.trunc(options.maxHits));
  const minIntervalMs = Math.max(0, Math.trunc(options.minIntervalMs ?? 0));
  const blockMs = Math.max(windowMs, Math.trunc(options.blockMs ?? windowMs));
  const staleAfterMs = Math.max(windowMs, blockMs) * 2;
  const states = new Map<string, ActionRateLimiterState>();
  let lastCleanupMs = 0;

  const consume = (keyRaw: string): ActionRateLimiterResult => {
    const key = keyRaw.trim();
    if (key === "") {
      return { ok: false, retryAfterMs: blockMs, reason: "rate_limited" };
    }
    const now = Date.now();
    if (now - lastCleanupMs > 60_000) {
      for (const [stateKey, state] of states) {
        const recentHistory = state.historyMs.filter((timestamp) => now - timestamp <= staleAfterMs);
        const blockedActive = state.blockedUntilMs > now;
        if (!blockedActive && recentHistory.length === 0) {
          states.delete(stateKey);
          continue;
        }
        if (recentHistory.length !== state.historyMs.length) {
          state.historyMs = recentHistory;
          states.set(stateKey, state);
        }
      }
      lastCleanupMs = now;
    }

    const current = states.get(key) ?? {
      historyMs: [],
      lastActionMs: 0,
      blockedUntilMs: 0,
    };
    if (current.blockedUntilMs > now) {
      return {
        ok: false,
        retryAfterMs: current.blockedUntilMs - now,
        reason: "rate_limited",
      };
    }
    if (minIntervalMs > 0 && current.lastActionMs > 0 && now-current.lastActionMs < minIntervalMs) {
      return {
        ok: false,
        retryAfterMs: minIntervalMs - (now - current.lastActionMs),
        reason: "too_frequent",
      };
    }
    const historyMs = current.historyMs.filter((timestamp) => now - timestamp < windowMs);
    if (historyMs.length >= maxHits) {
      current.historyMs = historyMs;
      current.blockedUntilMs = now + blockMs;
      states.set(key, current);
      return {
        ok: false,
        retryAfterMs: blockMs,
        reason: "rate_limited",
      };
    }
    historyMs.push(now);
    current.historyMs = historyMs;
    current.lastActionMs = now;
    current.blockedUntilMs = 0;
    states.set(key, current);
    return {
      ok: true,
      retryAfterMs: 0,
      reason: "ok",
    };
  };

  return {
    consume,
  };
}
