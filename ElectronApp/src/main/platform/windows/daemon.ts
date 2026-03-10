import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { app } from "electron";

import { DEFAULT_DAEMON_BASE_URL } from "../../services/daemonClient";

const daemonProbePath = "/v1/state?withLogs=0";
const daemonProbeTimeoutMs = 1200;
const daemonReadyTimeoutMs = 12000;
const daemonReadyPollIntervalMs = 300;

function isDevMode(): boolean {
  const mode = process.env.WATERAY_APP_MODE?.trim().toLowerCase();
  if (mode === "dev") {
    return true;
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    return true;
  }
  return !app.isPackaged;
}

function shouldManagePackagedDaemon(): boolean {
  if (isDevMode()) {
    return false;
  }
  if (!app.isPackaged) {
    return false;
  }
  const daemonURL = process.env.WATERAY_DAEMON_URL?.trim();
  if (daemonURL && daemonURL !== DEFAULT_DAEMON_BASE_URL) {
    return false;
  }
  return true;
}

function resolveDaemonExecutablePath(): string {
  return join(dirname(process.execPath), "core", "WaterayServer.exe");
}

function isPermissionDeniedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function spawnDaemonDetached(daemonExecutablePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(daemonExecutablePath, [], {
      cwd: dirname(daemonExecutablePath),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    const onError = (error: Error): void => {
      reject(error);
    };
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      child.unref();
      resolve();
    });
  });
}

async function spawnDaemonElevatedViaUAC(
  daemonExecutablePath: string,
): Promise<boolean> {
  const daemonDir = dirname(daemonExecutablePath);
  const command = `Start-Process -FilePath ${quotePowerShellLiteral(daemonExecutablePath)} -WorkingDirectory ${quotePowerShellLiteral(daemonDir)} -Verb RunAs -WindowStyle Hidden`;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      child.once("error", (error) => {
        reject(error);
      });
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `powershell runas exited with code ${typeof code === "number" ? code : "unknown"}`,
          ),
        );
      });
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[wateray] failed to elevate daemon start: ${message}`);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isDaemonReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, daemonProbeTimeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:39080${daemonProbePath}`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitDaemonReady(): Promise<boolean> {
  const deadline = Date.now() + daemonReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonReachable()) {
      return true;
    }
    await delay(daemonReadyPollIntervalMs);
  }
  return false;
}

export async function ensurePackagedDaemonRunning(): Promise<void> {
  if (!shouldManagePackagedDaemon()) {
    return;
  }
  if (await isDaemonReachable()) {
    return;
  }

  const daemonExecutablePath = resolveDaemonExecutablePath();
  if (!existsSync(daemonExecutablePath)) {
    console.error(
      `[wateray] daemon executable not found: ${daemonExecutablePath}`,
    );
    return;
  }

  try {
    await spawnDaemonDetached(daemonExecutablePath);
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      const elevatedStarted = await spawnDaemonElevatedViaUAC(
        daemonExecutablePath,
      );
      if (!elevatedStarted) {
        return;
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[wateray] failed to spawn daemon: ${message}`);
      return;
    }
  }

  if (!(await waitDaemonReady())) {
    console.error("[wateray] daemon start timeout");
  }
}

export function shouldShutdownDaemonOnAppQuit(): boolean {
  return true;
}
