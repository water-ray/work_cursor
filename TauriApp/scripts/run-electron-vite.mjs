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
const electronViteBin = join(
  __dirname,
  "../node_modules/.bin",
  process.platform === "win32" ? "electron-vite.cmd" : "electron-vite",
);
const subcommand = process.argv[2];
const linuxDevDesktopFileName = "wateray-dev-local.desktop";
const linuxStartupWMClass = "wateray";
const linuxSharedIconPath = join(__dirname, "../../scripts/build/assets/linux/wateray.png");

if (!subcommand) {
  console.error("Missing electron-vite subcommand.");
  process.exit(1);
}

function quoteDesktopExecToken(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function ensureLinuxDevDesktopEntry() {
  if (process.platform !== "linux" || subcommand !== "dev") {
    return {};
  }
  const localApplicationsDir = join(homedir(), ".local", "share", "applications");
  const desktopFilePath = join(localApplicationsDir, linuxDevDesktopFileName);
  const scriptPath = join(__dirname, "run-electron-vite.mjs");
  mkdirSync(localApplicationsDir, { recursive: true });
  const iconHash = existsSync(linuxSharedIconPath)
    ? createHash("sha256").update(readFileSync(linuxSharedIconPath)).digest("hex").slice(0, 8)
    : "missing";
  const iconPath = join(localApplicationsDir, `wateray-dev-local-${iconHash}.png`);
  for (const entry of readdirSync(localApplicationsDir)) {
    if (
      entry === "wateray-dev.desktop" ||
      entry === "wateray-dev-local.desktop" ||
      entry.startsWith("wateray-dev.png") ||
      entry.startsWith("wateray-dev-local-")
    ) {
      const targetPath = join(localApplicationsDir, entry);
      if (targetPath !== desktopFilePath && targetPath !== iconPath) {
        rmSync(targetPath, { force: true, recursive: false });
      }
    }
  }
  if (existsSync(linuxSharedIconPath)) {
    copyFileSync(linuxSharedIconPath, iconPath);
  }
  const desktopFileContent = [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=Wateray (Dev)",
    "Comment=Wateray Electron development build",
    `Exec=/usr/bin/env node ${quoteDesktopExecToken(scriptPath)} dev`,
    `Icon=${iconPath}`,
    "Terminal=false",
    "Categories=Development;Network;",
    "StartupNotify=true",
    `StartupWMClass=${linuxStartupWMClass}`,
    `X-GNOME-WMClass=${linuxStartupWMClass}`,
  ].join("\n");
  writeFileSync(desktopFilePath, `${desktopFileContent}\n`, "utf-8");
  return {
    CHROME_DESKTOP: linuxDevDesktopFileName,
    WATERAY_LINUX_ICON_PATH: linuxSharedIconPath,
  };
}

const linuxDesktopEnv = ensureLinuxDevDesktopEntry();

const child = spawn(electronViteBin, [subcommand], {
  cwd: join(__dirname, ".."),
  env: {
    ...process.env,
    ...(process.platform === "linux"
      ? { ELECTRON_DISABLE_SANDBOX: "1", ...linuxDesktopEnv }
      : {}),
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
