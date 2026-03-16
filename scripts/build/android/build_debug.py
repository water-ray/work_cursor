#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
TAURI_DIR = ROOT_DIR / "TauriApp"


def resolve_npx_command() -> str:
    return "npx.cmd" if os.name == "nt" else "npx"


def main() -> int:
    env = os.environ.copy()
    env["WATERAY_APP_TARGET"] = "mobile"
    env["VITE_WATERAY_APP_TARGET"] = "mobile"
    command = [resolve_npx_command(), "tauri", "android", "build", "--debug", "--apk", "--ci"]
    print(" ".join(command))
    return subprocess.run(command, cwd=str(TAURI_DIR), env=env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
