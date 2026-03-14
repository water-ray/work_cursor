import { invoke } from "@tauri-apps/api/core";
import type { ProbeType, ProxyMode } from "../../../shared/daemon";

export type WaterayMobileHostState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface WaterayMobileHostStatus {
  state: WaterayMobileHostState;
  runtimeMode: ProxyMode;
  permissionGranted: boolean;
  systemDnsServers: string[];
  serviceRunning: boolean;
  nativeReady: boolean;
  tunReady: boolean;
  profileName: string | null;
  configDigest: string | null;
  lastError: string | null;
  startedAtMs: number | null;
  updatedAtMs: number;
}

export interface WaterayMobileHostPrepareResult {
  granted: boolean;
  status: WaterayMobileHostStatus;
}

export interface WaterayMobileHostCheckResult {
  ok: boolean;
  version: string;
  status: WaterayMobileHostStatus;
}

export interface WaterayMobileHostStartRequest {
  configJson: string;
  profileName?: string;
  mode?: ProxyMode;
}

export interface WaterayMobileProbeConfigInput {
  nodeId: string;
  configJson: string;
}

export interface WaterayMobileProbeRequest {
  configs: WaterayMobileProbeConfigInput[];
  probeTypes?: ProbeType[];
  latencyUrl?: string;
  realConnectUrl?: string;
  timeoutMs?: number;
}

export interface WaterayMobileProbeResultItem {
  nodeId: string;
  latencyMs?: number;
  realConnectMs?: number;
  error?: string | null;
}

export interface WaterayMobileProbeResult {
  results: WaterayMobileProbeResultItem[];
}

export interface WaterayMobileDnsHealthRequest {
  type: string;
  address: string;
  port?: number;
  domain: string;
  timeoutMs?: number;
}

export interface WaterayMobileDnsHealthResult {
  reachable: boolean;
  latencyMs: number;
  resolvedIp?: string[];
  error?: string | null;
}

export interface WaterayMobileHostApi {
  getStatus: () => Promise<WaterayMobileHostStatus>;
  prepare: () => Promise<WaterayMobileHostPrepareResult>;
  checkConfig: (configJson: string) => Promise<WaterayMobileHostCheckResult>;
  start: (request: WaterayMobileHostStartRequest) => Promise<WaterayMobileHostStatus>;
  stop: () => Promise<WaterayMobileHostStatus>;
  probe: (request: WaterayMobileProbeRequest) => Promise<WaterayMobileProbeResult>;
  dnsHealth: (request: WaterayMobileDnsHealthRequest) => Promise<WaterayMobileDnsHealthResult>;
  onStatusChanged: (
    listener: (status: WaterayMobileHostStatus) => void,
  ) => Promise<() => void>;
}

type TauriInvokeArgs = Parameters<typeof invoke>[1];
const mobileHostStatusPollIntervalMs = 1500;
const mobileHostPermissionConfirmTimeoutMs = 2000;
const mobileHostPermissionConfirmPollIntervalMs = 100;
const emptyMobileHostStatus: WaterayMobileHostStatus = {
  state: "idle",
  runtimeMode: "off",
  permissionGranted: false,
  systemDnsServers: [],
  serviceRunning: false,
  nativeReady: false,
  tunReady: false,
  profileName: null,
  configDigest: null,
  lastError: null,
  startedAtMs: null,
  updatedAtMs: 0,
};

async function invokeMobileHost<T>(command: string, payload?: TauriInvokeArgs): Promise<T> {
  return invoke<T>(command, payload ?? {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeMobileHostStatus(payload: unknown): WaterayMobileHostStatus {
  if (!payload || typeof payload !== "object") {
    return { ...emptyMobileHostStatus };
  }
  const source = payload as Partial<WaterayMobileHostStatus>;
  const systemDnsServers = Array.isArray(source.systemDnsServers)
    ? source.systemDnsServers.filter((value): value is string => typeof value === "string")
    : [];
  return {
    state: source.state ?? emptyMobileHostStatus.state,
    runtimeMode: source.runtimeMode ?? emptyMobileHostStatus.runtimeMode,
    permissionGranted: source.permissionGranted === true,
    systemDnsServers,
    serviceRunning: source.serviceRunning === true,
    nativeReady: source.nativeReady === true,
    tunReady: source.tunReady === true,
    profileName: typeof source.profileName === "string" ? source.profileName : null,
    configDigest: typeof source.configDigest === "string" ? source.configDigest : null,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    startedAtMs: typeof source.startedAtMs === "number" ? source.startedAtMs : null,
    updatedAtMs: typeof source.updatedAtMs === "number" ? source.updatedAtMs : 0,
  };
}

function normalizePrepareResult(payload: unknown): WaterayMobileHostPrepareResult {
  if (!payload || typeof payload !== "object") {
    return {
      granted: false,
      status: { ...emptyMobileHostStatus },
    };
  }
  const source = payload as Partial<WaterayMobileHostPrepareResult> & {
    status?: unknown;
  };
  const status = normalizeMobileHostStatus(source.status);
  return {
    granted: source.granted === true || status.permissionGranted,
    status,
  };
}

function normalizeCheckResult(payload: unknown): WaterayMobileHostCheckResult {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      version: "",
      status: { ...emptyMobileHostStatus },
    };
  }
  const source = payload as Partial<WaterayMobileHostCheckResult> & {
    status?: unknown;
  };
  return {
    ok: source.ok === true,
    version: typeof source.version === "string" ? source.version : "",
    status: normalizeMobileHostStatus(source.status),
  };
}

async function readMobileHostStatus(): Promise<WaterayMobileHostStatus> {
  const payload = await invokeMobileHost<unknown>("mobile_host_get_status");
  return normalizeMobileHostStatus(payload);
}

async function confirmGrantedPermission(): Promise<WaterayMobileHostStatus | null> {
  const deadline = Date.now() + mobileHostPermissionConfirmTimeoutMs;
  let latestStatus: WaterayMobileHostStatus | null = null;
  while (Date.now() < deadline) {
    try {
      latestStatus = await readMobileHostStatus();
      if (latestStatus.permissionGranted) {
        return latestStatus;
      }
    } catch {
      // Ignore transient read failures while Android finishes returning to the app.
    }
    await sleep(mobileHostPermissionConfirmPollIntervalMs);
  }
  return latestStatus?.permissionGranted ? latestStatus : null;
}

export function createWaterayMobileHostApi(): WaterayMobileHostApi {
  return {
    async getStatus() {
      return readMobileHostStatus();
    },
    async prepare() {
      const payload = await invokeMobileHost<unknown>("mobile_host_prepare");
      const result = normalizePrepareResult(payload);
      if (result.granted || result.status.permissionGranted) {
        return result;
      }
      const confirmedStatus = await confirmGrantedPermission();
      if (!confirmedStatus) {
        return result;
      }
      return {
        granted: true,
        status: confirmedStatus,
      };
    },
    async checkConfig(configJson) {
      const payload = await invokeMobileHost<unknown>("mobile_host_check_config", {
        payload: {
          configJson,
        },
      });
      return normalizeCheckResult(payload);
    },
    async start(request) {
      const payload = await invokeMobileHost<unknown>("mobile_host_start", {
        payload: {
          configJson: request.configJson,
          profileName: request.profileName,
          mode: request.mode,
        },
      });
      return normalizeMobileHostStatus(payload);
    },
    async stop() {
      const payload = await invokeMobileHost<unknown>("mobile_host_stop");
      return normalizeMobileHostStatus(payload);
    },
    probe(request) {
      return invokeMobileHost<WaterayMobileProbeResult>("mobile_host_probe", {
        payload: {
          configs: request.configs,
          probeTypes: request.probeTypes,
          latencyUrl: request.latencyUrl,
          realConnectUrl: request.realConnectUrl,
          timeoutMs: request.timeoutMs,
        },
      });
    },
    dnsHealth(request) {
      return invokeMobileHost<WaterayMobileDnsHealthResult>("mobile_host_dns_health", {
        payload: {
          type: request.type,
          address: request.address,
          port: request.port,
          domain: request.domain,
          timeoutMs: request.timeoutMs,
        },
      });
    },
    async onStatusChanged(listener) {
      let stopped = false;
      let lastSnapshot = "";

      const poll = async () => {
        while (!stopped) {
          try {
            const status = await readMobileHostStatus();
            const serialized = JSON.stringify(status);
            if (serialized !== lastSnapshot) {
              lastSnapshot = serialized;
              listener(status);
            }
          } catch {
            // Ignore transient polling failures and retry.
          }

          await sleep(mobileHostStatusPollIntervalMs);
        }
      };

      void poll();
      return () => {
        stopped = true;
      };
    },
  };
}
