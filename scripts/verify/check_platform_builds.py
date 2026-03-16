#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[2]
TAURI_DIR = ROOT_DIR / "TauriApp"
RUST_MANIFEST_PATH = TAURI_DIR / "src-tauri" / "Cargo.toml"


class BuildCheckError(RuntimeError):
    pass


def resolve_executable(name: str) -> str:
    candidates = [name]
    if os.name == "nt":
        lower = name.lower()
        if not lower.endswith((".exe", ".cmd", ".bat")):
            candidates = [name, f"{name}.cmd", f"{name}.exe", f"{name}.bat"]
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return name


def run_step(label: str, command: list[str], cwd: Path) -> None:
    print(f"\n==> {label}")
    resolved_command = [resolve_executable(command[0]), *command[1:]]
    print(" ".join(resolved_command))
    result = subprocess.run(resolved_command, cwd=str(cwd), check=False)
    if result.returncode != 0:
        raise BuildCheckError(f"{label} 失败（exit_code={result.returncode}）")


def main() -> int:
    try:
        run_step("平台边界校验", [sys.executable, "scripts/verify/validate_platform_boundaries.py"], ROOT_DIR)
        run_step("前端类型检查", ["npm", "run", "typecheck"], TAURI_DIR)
        run_step(
            "桌面 renderer 构建",
            [sys.executable, "scripts/build/common/build_renderer.py", "build", "--app-target", "desktop"],
            ROOT_DIR,
        )
        run_step(
            "移动 renderer 构建",
            [sys.executable, "scripts/build/common/build_renderer.py", "build", "--app-target", "mobile"],
            ROOT_DIR,
        )
        run_step(
            "Rust 宿主编译检查",
            ["cargo", "check", "--manifest-path", str(RUST_MANIFEST_PATH)],
            ROOT_DIR,
        )
        print("\n平台独立构建检查通过")
        return 0
    except BuildCheckError as error:
        print(f"检查失败：[platform_builds] {error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover
        print(f"检查失败：[platform_builds_unexpected] {error}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
