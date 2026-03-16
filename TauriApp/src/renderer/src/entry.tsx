import { invoke } from "@tauri-apps/api/core";

import { installWaterayPlatform } from "./platform/runtimePlatform";

function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function reportFrontendStartupFailure(error: unknown): Promise<void> {
  const message = formatStartupError(error);
  try {
    await invoke("frontend_startup_failed", { message });
  } catch (reportError) {
    console.error("report frontend startup failure failed", reportError);
  }
}

async function bootstrap(): Promise<void> {
  try {
    const platform = await installWaterayPlatform();
    const root = document.getElementById("root");
    if (!root) {
      throw new Error("前端根节点不存在");
    }
    if (platform.appTarget === "desktop") {
      const { renderDesktopApp } = await import("./apps/desktop/main");
      renderDesktopApp(root);
    } else {
      const { renderMobileApp } = await import("./apps/mobile/main");
      renderMobileApp(root);
    }
    await invoke("frontend_ready");
  } catch (error) {
    console.error("frontend bootstrap failed", error);
    await reportFrontendStartupFailure(error);
  }
}

void bootstrap();
