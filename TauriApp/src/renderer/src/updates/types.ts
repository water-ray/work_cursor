type UpdatesApi = Window["waterayDesktop"]["updates"];

export type AppUpdateState = Awaited<ReturnType<UpdatesApi["getState"]>>;
export type AppUpdateCandidate = NonNullable<AppUpdateState["candidate"]>;
export type AppUpdateStage = AppUpdateState["stage"];
