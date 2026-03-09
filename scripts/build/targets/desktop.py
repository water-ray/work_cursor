#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.common.desktop_builder import build_desktop_target
from scripts.build.platforms.linux import TARGET as LINUX_TARGET
from scripts.build.platforms.macos import TARGET as MACOS_TARGET
from scripts.build.platforms.windows import TARGET as WINDOWS_TARGET


TARGETS = {
    WINDOWS_TARGET.platform_id: WINDOWS_TARGET,
    LINUX_TARGET.platform_id: LINUX_TARGET,
    MACOS_TARGET.platform_id: MACOS_TARGET,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建指定平台的 Wateray 桌面客户端")
    parser.add_argument(
        "--platform",
        choices=sorted(TARGETS.keys()),
        required=True,
        help="目标平台：windows / linux / macos",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return build_desktop_target(TARGETS[args.platform])


if __name__ == "__main__":
    raise SystemExit(main())
