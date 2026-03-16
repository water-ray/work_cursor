#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets.desktop import resolve_target
from scripts.build.common.desktop_builder import build_desktop_target


def main() -> int:
    return build_desktop_target(resolve_target("linux"))


if __name__ == "__main__":
    raise SystemExit(main())
