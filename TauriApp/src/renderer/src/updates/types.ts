import type { WaterayPlatformUpdatesApi } from "../platform/adapterTypes";

type UpdatesApi = WaterayPlatformUpdatesApi;

export type AppUpdateState = Awaited<ReturnType<UpdatesApi["getState"]>>;
export type AppUpdateCandidate = NonNullable<AppUpdateState["candidate"]>;
export type AppUpdateStage = AppUpdateState["stage"];
