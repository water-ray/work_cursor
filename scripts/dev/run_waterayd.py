#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
CORE_DIR = ROOT_DIR / "core"
ELECTRON_DIR = ROOT_DIR / "ElectronApp"
VERSION_PATH = ROOT_DIR / "VERSION"
LINUX_HELPER_PATH = (
    ROOT_DIR / "scripts" / "build" / "assets" / "linux" / "wateray-service-helper.sh"
)
LINUX_DEV_INSTALL_DIR = ROOT_DIR / "Bin" / ".tmp" / "wateray-linux-dev"
LINUX_DEV_BINARY_PATH = LINUX_DEV_INSTALL_DIR / "core" / "waterayd"
LINUX_DEV_SERVICE_NAME = "waterayd-dev"
LINUX_DEV_READY_URL = "http://127.0.0.1:39080/v1/state?withLogs=0"
LINUX_DEV_READY_TIMEOUT_SEC = 20.0


def run_command(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> int:
    completed = subprocess.run(command, cwd=str(cwd), env=env)
    return int(completed.returncode)


def safe_slug(value: str) -> str:
    normalized = "".join(ch if ch.isalnum() else "-" for ch in value.lower()).strip("-")
    return normalized or "wateray"


def read_release_version() -> str:
    try:
        return VERSION_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def sync_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)


def prepare_linux_dev_bundle() -> Path:
    version = read_release_version()
    if LINUX_DEV_INSTALL_DIR.exists():
      shutil.rmtree(LINUX_DEV_INSTALL_DIR)
    (LINUX_DEV_INSTALL_DIR / "core").mkdir(parents=True, exist_ok=True)
    go_command = [
        "go",
        "build",
        "-tags",
        "with_clash_api,with_gvisor,with_quic",
        "-trimpath",
    ]
    if version:
        go_command.extend(["-ldflags", f"-X main.appVersion={version}"])
    go_command.extend(["-o", str(LINUX_DEV_BINARY_PATH), "./cmd/waterayd"])
    exit_code = run_command(go_command, cwd=CORE_DIR)
    if exit_code != 0:
        raise SystemExit(exit_code)
    sync_tree(ELECTRON_DIR / "rule-set", LINUX_DEV_INSTALL_DIR / "rule-set")
    default_config_dir = ELECTRON_DIR / "default-config"
    if default_config_dir.exists():
        sync_tree(default_config_dir, LINUX_DEV_INSTALL_DIR / "default-config")
    shutil.copy2(VERSION_PATH, LINUX_DEV_INSTALL_DIR / "VERSION")
    return LINUX_DEV_INSTALL_DIR


def resolve_linux_dev_data_root() -> str:
    user = safe_slug(os.environ.get("USER", "user"))
    repo = safe_slug(ROOT_DIR.name)
    repo_hash = hashlib.sha256(str(ROOT_DIR).encode("utf-8")).hexdigest()[:8]
    return f"/var/lib/wateray-dev-{user}-{repo}-{repo_hash}"


def wait_linux_dev_ready(timeout_sec: float = LINUX_DEV_READY_TIMEOUT_SEC) -> bool:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(LINUX_DEV_READY_URL, timeout=1.2) as response:
                if 200 <= int(response.status) < 300:
                    return True
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            time.sleep(0.3)
    return False


def ensure_linux_dev_service() -> int:
    if not LINUX_HELPER_PATH.is_file():
        print(f"missing Linux helper: {LINUX_HELPER_PATH}", file=sys.stderr)
        return 1
    install_dir = prepare_linux_dev_bundle()
    command = [
        "pkexec",
        str(LINUX_HELPER_PATH),
        "ensure-dev",
        "--install-dir",
        str(install_dir),
        "--service-name",
        LINUX_DEV_SERVICE_NAME,
        "--data-root",
        resolve_linux_dev_data_root(),
    ]
    exit_code = run_command(command, cwd=ROOT_DIR)
    if exit_code != 0:
        return exit_code
    if not wait_linux_dev_ready():
        print("waterayd-dev service start timeout", file=sys.stderr)
        return 1
    return 0


def run_foreground_core() -> int:
    return run_command(
        ["go", "run", "-tags", "with_clash_api,with_gvisor,with_quic", "./cmd/waterayd"],
        cwd=CORE_DIR,
    )


def main() -> int:
    if sys.platform.startswith("linux"):
        return ensure_linux_dev_service()
    return run_foreground_core()


if __name__ == "__main__":
    raise SystemExit(main())
