import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { app } from "electron";

import { DEFAULT_DAEMON_BASE_URL } from "../../services/daemonClient";

const daemonProbePath = "/v1/state?withLogs=0";
const daemonProbeTimeoutMs = 1200;
const daemonReadyTimeoutMs = 20000;
const daemonReadyPollIntervalMs = 300;
const installedHelperPath = "/usr/local/libexec/wateray/wateray-service-helper";

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

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

function shouldManageDaemon(): boolean {
  const daemonURL = process.env.WATERAY_DAEMON_URL?.trim();
  if (daemonURL && daemonURL !== DEFAULT_DAEMON_BASE_URL) {
    return false;
  }
  return true;
}

function resolveFirstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRepoRoot(): string {
  return resolveFirstExistingPath([
    resolve(app.getAppPath(), ".."),
    resolve(process.cwd(), ".."),
    process.cwd(),
  ]) ?? process.cwd();
}

function resolveDevBootstrapScript(): string | null {
  const repoRoot = resolveRepoRoot();
  return resolveFirstExistingPath([
    join(repoRoot, "scripts", "dev", "run_waterayd.py"),
    join(resolve(process.cwd(), ".."), "scripts", "dev", "run_waterayd.py"),
  ]);
}

function resolvePackagedInstallDir(): string {
  const explicitInstallDir = process.env.WATERAY_APP_INSTALL_DIR?.trim();
  if (explicitInstallDir) {
    return explicitInstallDir;
  }
  return dirname(process.execPath);
}

function resolvePackagedInstallScript(): string | null {
  return resolveFirstExistingPath([
    join(resolvePackagedInstallDir(), "linux", "install-system-service.sh"),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
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

async function runCommand(
  command: string,
  args: string[],
  workingDirectory: string,
): Promise<CommandResult> {
  return await new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: workingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      resolveCommand({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.once("close", (exitCode) => {
      resolveCommand({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

function logCommandFailure(context: string, result: CommandResult): void {
  const parts = [
    `[wateray] ${context} failed`,
    result.error ? `error=${result.error}` : "",
    result.exitCode !== null ? `exitCode=${result.exitCode}` : "",
    result.stderr.trim() ? `stderr=${result.stderr.trim()}` : "",
    result.stdout.trim() ? `stdout=${result.stdout.trim()}` : "",
  ].filter(Boolean);
  console.error(parts.join(" | "));
}

async function runPkexecCommand(
  executablePath: string,
  args: string[],
  workingDirectory: string,
): Promise<boolean> {
  const result = await runCommand("pkexec", [executablePath, ...args], workingDirectory);
  if (result.ok) {
    return true;
  }
  logCommandFailure(`pkexec ${executablePath}`, result);
  return false;
}

async function ensureDevDaemonRunning(): Promise<void> {
  const bootstrapScript = resolveDevBootstrapScript();
  if (!bootstrapScript) {
    console.error("[wateray] Linux dev bootstrap script not found");
    return;
  }
  const repoRoot = resolveRepoRoot();
  let result = await runCommand("python3", [bootstrapScript], repoRoot);
  if (!result.ok && result.error?.includes("ENOENT")) {
    result = await runCommand("python", [bootstrapScript], repoRoot);
  }
  if (!result.ok) {
    logCommandFailure(`bootstrap Linux dev daemon (${bootstrapScript})`, result);
    return;
  }
  if (!(await waitDaemonReady())) {
    console.error("[wateray] Linux dev daemon start timeout");
  }
}

async function ensurePackagedLinuxServiceRunning(): Promise<void> {
  const installDir = resolvePackagedInstallDir();
  const localInstallScript = resolvePackagedInstallScript();
  if (existsSync(installedHelperPath)) {
    const started = await runPkexecCommand(
      installedHelperPath,
      ["ensure-packaged", "--install-dir", installDir],
      installDir,
    );
    if (!started) {
      return;
    }
  } else if (localInstallScript) {
    const installed = await runPkexecCommand(
      localInstallScript,
      ["--install-dir", installDir],
      installDir,
    );
    if (!installed) {
      return;
    }
  } else {
    console.error("[wateray] Linux install helper not found in packaged app");
    return;
  }
  if (!(await waitDaemonReady())) {
    console.error("[wateray] Linux packaged daemon start timeout");
  }
}

export async function ensurePackagedDaemonRunning(): Promise<void> {
  if (!shouldManageDaemon()) {
    return;
  }
  if (await isDaemonReachable()) {
    return;
  }
  if (isDevMode()) {
    await ensureDevDaemonRunning();
    return;
  }
  if (!app.isPackaged) {
    return;
  }
  await ensurePackagedLinuxServiceRunning();
}

export function shouldShutdownDaemonOnAppQuit(): boolean {
  return false;
}
