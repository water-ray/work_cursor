#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.common.desktop_builder import DesktopBuildTarget, build_desktop_target
from scripts.build.platforms.linux import TARGET as LINUX_TARGET
from scripts.build.platforms.macos import TARGET as MACOS_TARGET
from scripts.build.platforms.windows import TARGET as WINDOWS_TARGET


TARGETS = {
    WINDOWS_TARGET.platform_id: WINDOWS_TARGET,
    LINUX_TARGET.platform_id: LINUX_TARGET,
    MACOS_TARGET.platform_id: MACOS_TARGET,
}

HOST_PLATFORM_TO_TARGET = {
    "win32": WINDOWS_TARGET.platform_id,
    "linux": LINUX_TARGET.platform_id,
    "darwin": MACOS_TARGET.platform_id,
}


def resolve_current_platform_id() -> str:
    try:
        return HOST_PLATFORM_TO_TARGET[sys.platform]
    except KeyError as err:
        supported_hosts = ", ".join(sorted(HOST_PLATFORM_TO_TARGET))
        raise SystemExit(
            f"当前宿主平台 {sys.platform!r} 不支持桌面客户端构建，支持：{supported_hosts}"
        ) from err


def resolve_target(platform: str) -> DesktopBuildTarget:
    target_platform = resolve_current_platform_id() if platform == "auto" else platform
    return TARGETS[target_platform]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建当前或指定平台的 Wateray 桌面客户端")
    parser.add_argument(
        "--platform",
        choices=["auto", *sorted(TARGETS.keys())],
        default="auto",
        help="目标平台：auto / windows / linux / macos，默认 auto（按当前宿主机自动判断）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return build_desktop_target(resolve_target(args.platform))


if __name__ == "__main__":
    raise SystemExit(main())
