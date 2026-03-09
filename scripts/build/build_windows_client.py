#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.common.desktop_builder import build_desktop_target
from scripts.build.platforms.windows import TARGET as WINDOWS_TARGET


if __name__ == "__main__":
    raise SystemExit(build_desktop_target(WINDOWS_TARGET))
