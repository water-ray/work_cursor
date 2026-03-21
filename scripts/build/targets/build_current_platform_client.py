#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets.desktop import resolve_current_platform_id
from scripts.build.common.sync_default_rulesets import (
    ensure_default_rule_sets_synced,
    print_rule_set_sync_summary,
)


class CurrentPlatformBuildError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def run_command(command: list[str]) -> None:
    result = subprocess.run(command, cwd=str(ROOT_DIR), check=False)
    if result.returncode != 0:
        raise CurrentPlatformBuildError(f"命令执行失败：{' '.join(command)}")


def resolve_build_script(platform_id: str) -> Path:
    if platform_id == "macos":
        return ROOT_DIR / "scripts" / "build" / "desktop" / "build_macos_dmg.py"
    return ROOT_DIR / "scripts" / "build" / "desktop" / "build_current_host.py"


def main() -> int:
    try:
        platform_id = resolve_current_platform_id()
        print_rule_set_sync_summary(ensure_default_rule_sets_synced())
        build_script = resolve_build_script(platform_id)
        print(f"当前平台：{platform_id}，转发到 {build_script.relative_to(ROOT_DIR)}")
        run_command([sys.executable, str(build_script)])
        return 0
    except CurrentPlatformBuildError as err:
        print(f"构建失败：[current_platform_client] {err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"构建失败：[current_platform_client_unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
