#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TextIO

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.common.build_manifest import DESKTOP_BUILD_MANIFEST_NAME


CORE_DIR = ROOT_DIR / "core"
TAURI_DIR = ROOT_DIR / "TauriApp"
VERSION_PATH = ROOT_DIR / "VERSION"
LINUX_HELPER_PATH = (
    ROOT_DIR / "scripts" / "build" / "assets" / "linux" / "wateray-service-helper.sh"
)
LINUX_DEV_INSTALL_DIR = ROOT_DIR / "Bin" / ".tmp" / "wateray-linux-dev"
LINUX_DEV_STAGE_DIR = ROOT_DIR / "Bin" / ".tmp" / "wateray-linux-dev.stage"
LINUX_DEV_BINARY_PATH = LINUX_DEV_INSTALL_DIR / "core" / "waterayd"
LINUX_DEV_MANIFEST_PATH = LINUX_DEV_INSTALL_DIR / DESKTOP_BUILD_MANIFEST_NAME
LINUX_DEV_SERVICE_NAME = "waterayd-dev"
LINUX_DEV_READY_URL = "http://127.0.0.1:39080/v1/state?withLogs=0"
LINUX_DEV_READY_TIMEOUT_SEC = 20.0
DEV_CRASH_LOG_DIR = ROOT_DIR / "temp" / "crash" / "waterayd"


def run_command(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> int:
    completed = subprocess.run(command, cwd=str(cwd), env=env)
    return int(completed.returncode)


def write_stream_targets(targets: list[TextIO], text: str) -> None:
    for target in targets:
        target.write(text)
        target.flush()


def build_foreground_core_log_paths() -> tuple[Path, Path]:
    DEV_CRASH_LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    return (
        DEV_CRASH_LOG_DIR / f"waterayd-{timestamp}.log",
        DEV_CRASH_LOG_DIR / "latest.log",
    )


def stream_command_with_combined_logging(
    command: list[str],
    cwd: Path,
    env: dict[str, str] | None = None,
) -> int:
    log_path, latest_path = build_foreground_core_log_paths()
    command_text = " ".join(command)
    started_at = time.strftime("%Y-%m-%d %H:%M:%S")
    with (
        log_path.open("w", encoding="utf-8", newline="") as log_file,
        latest_path.open("w", encoding="utf-8", newline="") as latest_file,
    ):
        log_targets = [log_file, latest_file]
        write_stream_targets(
            log_targets,
            (
                f"[waterayd-dev]\n"
                f"started_at={started_at}\n"
                f"cwd={cwd}\n"
                f"command={command_text}\n\n"
            ),
        )
        print(f"[waterayd-dev] logging to {log_path}", flush=True)
        try:
            process = subprocess.Popen(
                command,
                cwd=str(cwd),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as error:
            message = f"[waterayd-dev] launch failed: {error}\n"
            sys.stderr.write(message)
            sys.stderr.flush()
            write_stream_targets(log_targets, message)
            return 1

        stdout = process.stdout
        if stdout is not None:
            for line in stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
                write_stream_targets(log_targets, line)

        return_code = process.wait()
        finished_at = time.strftime("%Y-%m-%d %H:%M:%S")
        write_stream_targets(
            log_targets,
            f"\n[waterayd-dev] finished_at={finished_at}\n[waterayd-dev] exit_code={return_code}\n",
        )

    if return_code != 0:
        print(
            f"[waterayd-dev] process exited with code {return_code}, full log: {log_path}",
            file=sys.stderr,
            flush=True,
        )
    return return_code


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


def hash_files(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        relative_path = path.relative_to(ROOT_DIR).as_posix()
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def collect_linux_dev_manifest_inputs() -> list[Path]:
    inputs: list[Path] = []
    for path in (VERSION_PATH, CORE_DIR / "go.mod", CORE_DIR / "go.sum"):
        if path.is_file():
            inputs.append(path)
    for path in CORE_DIR.rglob("*.go"):
        if path.is_file():
            inputs.append(path)
    default_config_dir = TAURI_DIR / "default-config"
    if default_config_dir.exists():
        for path in default_config_dir.rglob("*"):
            if path.is_file():
                inputs.append(path)
    return inputs


def build_linux_dev_manifest() -> dict[str, object]:
    version = read_release_version()
    inputs = collect_linux_dev_manifest_inputs()
    return {
        "version": version,
        "sourceHash": hash_files(inputs),
        "sourceFileCount": len(inputs),
    }


def read_linux_dev_manifest() -> dict[str, object] | None:
    if not LINUX_DEV_MANIFEST_PATH.is_file():
        return None
    try:
        payload = json.loads(LINUX_DEV_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def write_linux_dev_manifest(target_dir: Path, payload: dict[str, object]) -> None:
    (target_dir / DESKTOP_BUILD_MANIFEST_NAME).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def linux_dev_bundle_is_current(expected_manifest: dict[str, object]) -> bool:
    if not LINUX_DEV_BINARY_PATH.is_file():
        return False
    current_manifest = read_linux_dev_manifest()
    return current_manifest == expected_manifest


def query_systemd_service_state(service_name: str) -> tuple[bool, bool, bool]:
    result = subprocess.run(
        [
            "systemctl",
            "show",
            f"{service_name}.service",
            "--property=LoadState",
            "--property=UnitFileState",
            "--property=ActiveState",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return False, False, False
    properties: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        properties[key.strip()] = value.strip()
    load_state = properties.get("LoadState") or "not-found"
    unit_file_state = properties.get("UnitFileState") or "disabled"
    active_state = properties.get("ActiveState") or "inactive"
    installed = load_state != "not-found"
    enabled = unit_file_state in {"enabled", "enabled-runtime", "linked", "linked-runtime", "alias"}
    active = active_state == "active"
    return installed, enabled, active


def linux_dev_service_is_ready(expected_manifest: dict[str, object]) -> bool:
    if not linux_dev_bundle_is_current(expected_manifest):
        return False
    _installed, _enabled, active = query_systemd_service_state(LINUX_DEV_SERVICE_NAME)
    if not active:
        return False
    return wait_linux_dev_ready(timeout_sec=1.2)


def prepare_linux_dev_bundle(target_dir: Path, manifest: dict[str, object]) -> Path:
    if target_dir.exists():
        shutil.rmtree(target_dir)
    (target_dir / "core").mkdir(parents=True, exist_ok=True)
    version = str(manifest.get("version", "")).strip()
    go_command = [
        "go",
        "build",
        "-tags",
        "with_clash_api,with_gvisor,with_quic",
        "-trimpath",
    ]
    if version:
        go_command.extend(["-ldflags", f"-X main.appVersion={version}"])
    go_command.extend(["-o", str(target_dir / "core" / "waterayd"), "./cmd/waterayd"])
    exit_code = run_command(go_command, cwd=CORE_DIR)
    if exit_code != 0:
        raise SystemExit(exit_code)
    default_config_dir = TAURI_DIR / "default-config"
    if default_config_dir.exists():
        sync_tree(default_config_dir, target_dir / "default-config")
    shutil.copy2(VERSION_PATH, target_dir / "VERSION")
    write_linux_dev_manifest(target_dir, manifest)
    return target_dir


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
    expected_manifest = build_linux_dev_manifest()
    if linux_dev_service_is_ready(expected_manifest):
        print("waterayd-dev service is already up-to-date")
        return 0

    install_dir = LINUX_DEV_INSTALL_DIR
    if not linux_dev_bundle_is_current(expected_manifest):
        staged_dir = prepare_linux_dev_bundle(LINUX_DEV_STAGE_DIR, expected_manifest)
        try:
            if install_dir.exists():
                shutil.rmtree(install_dir)
            staged_dir.rename(install_dir)
        finally:
            if staged_dir.exists():
                shutil.rmtree(staged_dir)

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
    return stream_command_with_combined_logging(
        ["go", "run", "-tags", "with_clash_api,with_gvisor,with_quic", "./cmd/waterayd"],
        cwd=CORE_DIR,
    )


def main() -> int:
    if sys.platform.startswith("linux"):
        return ensure_linux_dev_service()
    return run_foreground_core()


if __name__ == "__main__":
    raise SystemExit(main())
