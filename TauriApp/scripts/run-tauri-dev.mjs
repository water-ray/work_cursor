import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tauriBin = join(
  __dirname,
  "../node_modules/.bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const subcommand = process.argv[2] ?? "dev";
const forwardedArgs = process.argv.slice(3);

const linuxAppId = "com.wateray.desktop";
const linuxDesktopFileName = `${linuxAppId}.desktop`;
const linuxDevIconPrefix = "wateray-tauri-dev-";
const linuxIconSourcePath = join(__dirname, "../src-tauri/icons/128x128@2x.png");

function quoteDesktopExecToken(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function removeFileIfExists(path) {
  rmSync(path, { force: true, recursive: false });
}

function ensureLinuxDevDesktopEntry() {
  if (process.platform !== "linux" || subcommand !== "dev") {
    return () => {};
  }

  const localApplicationsDir = join(homedir(), ".local", "share", "applications");
  const desktopFilePath = join(localApplicationsDir, linuxDesktopFileName);
  const scriptPath = join(__dirname, "run-tauri-dev.mjs");

  mkdirSync(localApplicationsDir, { recursive: true });

  let copiedIconPath = "";
  if (existsSync(linuxIconSourcePath)) {
    const iconHash = createHash("sha256")
      .update(readFileSync(linuxIconSourcePath))
      .digest("hex")
      .slice(0, 8);
    copiedIconPath = join(localApplicationsDir, `${linuxDevIconPrefix}${iconHash}.png`);
    copyFileSync(linuxIconSourcePath, copiedIconPath);
  }

  for (const entry of readdirSync(localApplicationsDir)) {
    if (entry === linuxDesktopFileName || entry.startsWith(linuxDevIconPrefix)) {
      const targetPath = join(localApplicationsDir, entry);
      if (targetPath !== copiedIconPath) {
        removeFileIfExists(targetPath);
      }
    }
  }

  const iconValue = copiedIconPath || linuxIconSourcePath;
  const desktopFileContent = [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=Wateray (Dev)",
    "Comment=Wateray Tauri development build",
    `Exec=/usr/bin/env node ${quoteDesktopExecToken(scriptPath)} dev`,
    `TryExec=${tauriBin}`,
    `Icon=${iconValue}`,
    "Terminal=false",
    "Categories=Development;Network;",
    "StartupNotify=true",
    `StartupWMClass=${linuxAppId}`,
    `X-GNOME-WMClass=${linuxAppId}`,
    "NoDisplay=true",
    "X-Wateray-DevDesktop=true",
  ].join("\n");
  writeFileSync(desktopFilePath, `${desktopFileContent}\n`, "utf-8");

  return () => {
    removeFileIfExists(desktopFilePath);
    if (copiedIconPath) {
      removeFileIfExists(copiedIconPath);
    }
  };
}

const cleanupLinuxDevDesktopEntry = ensureLinuxDevDesktopEntry();
let cleanedUp = false;

function cleanup() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  cleanupLinuxDevDesktopEntry();
}

function signalExitCode(signal) {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

const child = spawn(tauriBin, [subcommand, ...forwardedArgs], {
  cwd: join(__dirname, ".."),
  env: {
    ...process.env,
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    if (!child.killed) {
      child.kill(signal);
    }
    process.exit(signalExitCode(signal));
  });
}

process.on("exit", cleanup);

child.on("error", (error) => {
  cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  cleanup();
  if (signal) {
    process.exit(signalExitCode(signal));
    return;
  }
  process.exit(code ?? 0);
});
