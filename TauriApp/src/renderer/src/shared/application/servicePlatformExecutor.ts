import type { DaemonSnapshot, ProxyMode } from "../../../../shared/daemon";
import type { NoticeApiLike } from "../../services/configChangeMessage";
import type { ServiceStartupStage } from "../../services/serviceControl";

export interface EnsureServiceStartReadyParams {
  targetMode: ProxyMode;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
  cancellationErrorMessage?: string;
}

export interface SyncPlatformSnapshotParams {
  snapshot: DaemonSnapshot;
  notice: NoticeApiLike;
  actionLabel: string;
  force?: boolean;
}

export interface ServicePlatformExecutor {
  resolveStartupTargetMode: (snapshot: DaemonSnapshot) => ProxyMode;
  ensureStartReady: (params: EnsureServiceStartReadyParams) => Promise<void>;
  shouldOptimizeBeforeStart: boolean;
  shouldOptimizeAfterStart: boolean;
  optimizeAfterStartInBackground: boolean;
  syncPlatformState: (params: SyncPlatformSnapshotParams) => Promise<void>;
}
