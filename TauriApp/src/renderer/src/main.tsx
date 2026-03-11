import "antd/dist/reset.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "flag-icons/css/flag-icons.min.css";
import "./styles/global.css";

import { invoke } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app/App";
import { installWaterayDesktop } from "./desktop/tauriDesktop";

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
    await installWaterayDesktop();

    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );

    await invoke("frontend_ready");
  } catch (error) {
    console.error("frontend bootstrap failed", error);
    await reportFrontendStartupFailure(error);
  }
}

void bootstrap();
