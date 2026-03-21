#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";

const minimumSupportedVersion = {
  major: 3,
  minor: 8,
};

const candidateCommands = process.platform === "win32"
  ? [
      { command: "py", args: ["-3.12"] },
      { command: "py", args: ["-3.11"] },
      { command: "py", args: ["-3.10"] },
      { command: "py", args: ["-3.9"] },
      { command: "py", args: ["-3.8"] },
      { command: "py", args: ["-3"] },
      { command: "python3.12", args: [] },
      { command: "python3.11", args: [] },
      { command: "python3.10", args: [] },
      { command: "python3.9", args: [] },
      { command: "python3.8", args: [] },
      { command: "python3", args: [] },
      { command: "python", args: [] },
    ]
  : [
      { command: "python3.12", args: [] },
      { command: "python3.11", args: [] },
      { command: "python3.10", args: [] },
      { command: "python3.9", args: [] },
      { command: "python3.8", args: [] },
      { command: "python3", args: [] },
      { command: "python", args: [] },
    ];

function formatCandidate(candidate) {
  return [candidate.command, ...candidate.args].join(" ");
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function isSupportedVersion(version) {
  if (!version) {
    return false;
  }
  if (version.major !== minimumSupportedVersion.major) {
    return version.major > minimumSupportedVersion.major;
  }
  return version.minor >= minimumSupportedVersion.minor;
}

function probeCandidate(candidate) {
  const versionCheck = spawnSync(
    candidate.command,
    [
      ...candidate.args,
      "-c",
      "import sys; print('.'.join(str(part) for part in sys.version_info[:3]))",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (versionCheck.error || versionCheck.status !== 0) {
    return null;
  }
  const version = parseVersion(versionCheck.stdout);
  if (!version) {
    return null;
  }
  return {
    ...candidate,
    version,
  };
}

function renderVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

const scriptArgs = process.argv.slice(2);
if (scriptArgs.length === 0) {
  console.error("usage: node scripts/dev/run_python3_script.mjs <script.py> [args...]");
  process.exit(2);
}

const discoveredCandidates = [];
for (const candidate of candidateCommands) {
  const resolved = probeCandidate(candidate);
  if (resolved) {
    discoveredCandidates.push(resolved);
  }
}

const selectedCandidate = discoveredCandidates.find((candidate) => isSupportedVersion(candidate.version));
if (!selectedCandidate) {
  const detectedText = discoveredCandidates.length > 0
    ? discoveredCandidates
      .map((candidate) => `${formatCandidate(candidate)}=${renderVersion(candidate.version)}`)
      .join(", ")
    : "none";
  console.error(
    `未找到可用的 Python ${minimumSupportedVersion.major}.${minimumSupportedVersion.minor}+ 解释器；detected: ${detectedText}`,
  );
  process.exit(1);
}

const scriptPath = resolve(process.cwd(), scriptArgs[0]);
const execution = spawnSync(
  selectedCandidate.command,
  [...selectedCandidate.args, scriptPath, ...scriptArgs.slice(1)],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);

if (typeof execution.status === "number") {
  process.exit(execution.status);
}
if (execution.signal) {
  process.kill(process.pid, execution.signal);
}
if (execution.error) {
  console.error(execution.error.message);
}
process.exit(1);
