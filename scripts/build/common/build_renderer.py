#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[3]
TAURI_DIR = ROOT_DIR / "TauriApp"
VITE_ENTRY = TAURI_DIR / "node_modules" / "vite" / "bin" / "vite.js"
ALLOWED_TARGETS = {"desktop", "mobile"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="统一包装 Vite renderer 构建入口")
    parser.add_argument("mode", choices=("dev", "build", "preview"))
    parser.add_argument(
        "--app-target",
        choices=sorted(ALLOWED_TARGETS),
        default="",
        help="显式指定 renderer 入口目标（desktop/mobile）",
    )
    return parser.parse_args()


def resolve_app_target(raw_value: str) -> str:
    normalized = raw_value.strip().lower()
    if normalized in ALLOWED_TARGETS:
        return normalized
    return "desktop"


def main() -> int:
    args = parse_args()
    app_target = resolve_app_target(
        args.app_target or os.environ.get("WATERAY_APP_TARGET", "") or os.environ.get("VITE_WATERAY_APP_TARGET", "")
    )
    env = os.environ.copy()
    env["WATERAY_APP_TARGET"] = app_target
    env["VITE_WATERAY_APP_TARGET"] = app_target
    command = ["node", str(VITE_ENTRY), args.mode]
    print(f"renderer mode={args.mode} app_target={app_target}")
    print(" ".join(command))
    result = subprocess.run(command, cwd=str(TAURI_DIR), env=env, check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
