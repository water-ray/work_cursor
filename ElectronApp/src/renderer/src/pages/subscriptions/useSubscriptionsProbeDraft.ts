import { useCallback, useEffect, useState } from "react";
import type { ProbeSettings } from "../../../../shared/daemon";

export const probeTimeoutSecOptions = [3, 5, 10, 15, 30, 60] as const;
export const probeIntervalMinOptions = [30, 60, 180, 300] as const;

export const probeRealConnectTestUrlOptions = [
  "https://www.google.com/generate_204",
  "https://www.gstatic.com/generate_204",
  "http://cp.cloudflare.com",
  "https://www.apple.com/library/test/success.html",
  "http://www.msftconnecttest.com/connecttest.txt",
  "https://time.tv.cctv.com/time.php"
];

export const probeNodeInfoQueryUrlOptions = [
  "https://api.ip.sb/geoip",
  "https://api-ipv4.ip.sb/geoip",
  "https://api-ipv6.ip.sb/geoip",
  "https://api.ipapi.is",
];

const defaultProbeSettingsValue: ProbeSettings = {
  concurrency: 5,
  timeoutSec: 5,
  probeIntervalMin: 180,
  realConnectTestUrl: probeRealConnectTestUrlOptions[0],
  nodeInfoQueryUrl: probeNodeInfoQueryUrlOptions[0],
  autoProbeOnActiveGroup: true,
};

function resolveProbeTimeoutSec(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (
    Number.isFinite(parsed) &&
    probeTimeoutSecOptions.includes(parsed as (typeof probeTimeoutSecOptions)[number])
  ) {
    return parsed;
  }
  return defaultProbeSettingsValue.timeoutSec;
}

function resolveProbeIntervalMin(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (
    Number.isFinite(parsed) &&
    probeIntervalMinOptions.includes(parsed as (typeof probeIntervalMinOptions)[number])
  ) {
    return parsed;
  }
  return defaultProbeSettingsValue.probeIntervalMin;
}

function normalizeProbeSettingsValue(value: ProbeSettings | undefined): ProbeSettings {
  const rawConcurrency = value?.concurrency;
  const normalizedConcurrency =
    typeof rawConcurrency === "number" && Number.isFinite(rawConcurrency)
      ? Math.max(1, Math.min(64, Math.round(rawConcurrency)))
      : defaultProbeSettingsValue.concurrency;
  const rawTimeoutSec = value?.timeoutSec;
  const normalizedTimeout =
    typeof rawTimeoutSec === "number" &&
    probeTimeoutSecOptions.includes(rawTimeoutSec as (typeof probeTimeoutSecOptions)[number])
      ? rawTimeoutSec
      : defaultProbeSettingsValue.timeoutSec;
  const rawProbeIntervalMin = value?.probeIntervalMin;
  const normalizedProbeIntervalMin =
    typeof rawProbeIntervalMin === "number" &&
    probeIntervalMinOptions.includes(rawProbeIntervalMin as (typeof probeIntervalMinOptions)[number])
      ? rawProbeIntervalMin
      : defaultProbeSettingsValue.probeIntervalMin;
  return {
    concurrency:
      typeof rawConcurrency === "number" && rawConcurrency > 0
        ? normalizedConcurrency
        : defaultProbeSettingsValue.concurrency,
    timeoutSec: normalizedTimeout,
    probeIntervalMin: normalizedProbeIntervalMin,
    realConnectTestUrl:
      value?.realConnectTestUrl?.trim() || defaultProbeSettingsValue.realConnectTestUrl,
    nodeInfoQueryUrl:
      value?.nodeInfoQueryUrl?.trim() || defaultProbeSettingsValue.nodeInfoQueryUrl,
    autoProbeOnActiveGroup: Boolean(value?.autoProbeOnActiveGroup),
  };
}

interface UseSubscriptionsProbeDraftParams {
  snapshotProbeSettings: ProbeSettings | undefined;
  snapshotStateRevision: number | undefined;
}

export function useSubscriptionsProbeDraft({
  snapshotProbeSettings,
  snapshotStateRevision,
}: UseSubscriptionsProbeDraftParams) {
  const [probeSettingsExpandedKeys, setProbeSettingsExpandedKeys] = useState<string[]>([]);
  const [probeSettingsDraft, setProbeSettingsDraft] = useState<ProbeSettings>(() =>
    normalizeProbeSettingsValue(snapshotProbeSettings),
  );
  const [probeTimeoutSecInput, setProbeTimeoutSecInput] = useState<string>(() =>
    String(normalizeProbeSettingsValue(snapshotProbeSettings).timeoutSec),
  );
  const [probeIntervalMinInput, setProbeIntervalMinInput] = useState<string>(() =>
    String(normalizeProbeSettingsValue(snapshotProbeSettings).probeIntervalMin),
  );
  const [probeSettingsDirty, setProbeSettingsDirty] = useState(false);

  useEffect(() => {
    if (probeSettingsDirty) {
      return;
    }
    const normalized = normalizeProbeSettingsValue(snapshotProbeSettings);
    setProbeSettingsDraft(normalized);
    setProbeTimeoutSecInput(String(normalized.timeoutSec));
    setProbeIntervalMinInput(String(normalized.probeIntervalMin));
  }, [snapshotStateRevision, snapshotProbeSettings, probeSettingsDirty]);

  const updateProbeSettingsDraft = useCallback((patch: Partial<ProbeSettings>) => {
    setProbeSettingsDraft((previous) => ({
      ...previous,
      ...patch,
    }));
    setProbeSettingsDirty(true);
  }, []);

  const markProbeSettingsDirty = useCallback(() => {
    setProbeSettingsDirty(true);
  }, []);

  const applyProbeTimeoutDraftFromValue = useCallback((value: string) => {
    const normalizedTimeout = resolveProbeTimeoutSec(value);
    setProbeSettingsDraft((previous) => ({
      ...previous,
      timeoutSec: normalizedTimeout,
    }));
    setProbeSettingsDirty(true);
  }, []);

  const commitProbeTimeoutInput = useCallback(() => {
    const normalizedTimeout = resolveProbeTimeoutSec(probeTimeoutSecInput);
    setProbeTimeoutSecInput(String(normalizedTimeout));
    setProbeSettingsDraft((previous) => ({
      ...previous,
      timeoutSec: normalizedTimeout,
    }));
    setProbeSettingsDirty(true);
  }, [probeTimeoutSecInput]);

  const applyProbeIntervalDraftFromValue = useCallback((value: string) => {
    const normalizedIntervalMin = resolveProbeIntervalMin(value);
    setProbeSettingsDraft((previous) => ({
      ...previous,
      probeIntervalMin: normalizedIntervalMin,
    }));
    setProbeSettingsDirty(true);
  }, []);

  const commitProbeIntervalInput = useCallback(() => {
    const normalizedIntervalMin = resolveProbeIntervalMin(probeIntervalMinInput);
    setProbeIntervalMinInput(String(normalizedIntervalMin));
    setProbeSettingsDraft((previous) => ({
      ...previous,
      probeIntervalMin: normalizedIntervalMin,
    }));
    setProbeSettingsDirty(true);
  }, [probeIntervalMinInput]);

  const getNormalizedProbeSettingsDraft = useCallback((): ProbeSettings => {
    return normalizeProbeSettingsValue({
      ...probeSettingsDraft,
      timeoutSec: resolveProbeTimeoutSec(probeTimeoutSecInput),
      probeIntervalMin: resolveProbeIntervalMin(probeIntervalMinInput),
    });
  }, [probeSettingsDraft, probeTimeoutSecInput, probeIntervalMinInput]);

  const applyProbeSettingsFromSnapshot = useCallback(
    (nextProbeSettings: ProbeSettings | undefined) => {
      const normalized = normalizeProbeSettingsValue(nextProbeSettings);
      setProbeSettingsDraft(normalized);
      setProbeTimeoutSecInput(String(normalized.timeoutSec));
      setProbeIntervalMinInput(String(normalized.probeIntervalMin));
      setProbeSettingsDirty(false);
    },
    [],
  );

  const discardProbeSettingsDraft = useCallback(() => {
    applyProbeSettingsFromSnapshot(snapshotProbeSettings);
  }, [applyProbeSettingsFromSnapshot, snapshotProbeSettings]);

  return {
    probeSettingsExpandedKeys,
    setProbeSettingsExpandedKeys,
    probeSettingsDraft,
    probeTimeoutSecInput,
    probeIntervalMinInput,
    setProbeTimeoutSecInput,
    setProbeIntervalMinInput,
    probeSettingsDirty,
    markProbeSettingsDirty,
    updateProbeSettingsDraft,
    applyProbeTimeoutDraftFromValue,
    commitProbeTimeoutInput,
    applyProbeIntervalDraftFromValue,
    commitProbeIntervalInput,
    getNormalizedProbeSettingsDraft,
    applyProbeSettingsFromSnapshot,
    discardProbeSettingsDraft,
  };
}
