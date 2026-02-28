import type { DaemonSnapshot } from "../../../shared/daemon";

export interface DaemonPageProps {
  snapshot: DaemonSnapshot | null;
  loading: boolean;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
}
