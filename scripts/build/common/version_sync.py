#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[3]
VERSION_PATH = ROOT_DIR / "VERSION"
PACKAGE_JSON_PATH = ROOT_DIR / "TauriApp" / "package.json"
PACKAGE_LOCK_PATH = ROOT_DIR / "TauriApp" / "package-lock.json"
TAURI_CONF_PATH = ROOT_DIR / "TauriApp" / "src-tauri" / "tauri.conf.json"
CARGO_MANIFEST_PATH = ROOT_DIR / "TauriApp" / "src-tauri" / "Cargo.toml"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


class VersionSyncError(RuntimeError):
    pass


def read_release_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not SEMVER_PATTERN.match(version):
        raise VersionSyncError(f"VERSION 格式非法（需要 X.Y.Z）：{version!r}")
    return version


def _write_text_if_changed(path: Path, content: str) -> bool:
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == content:
        return False
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def _sync_json_version(path: Path, version: str) -> bool:
    payload = json.loads(path.read_text(encoding="utf-8"))
    changed = False
    if payload.get("version") != version:
        payload["version"] = version
        changed = True
    if path == PACKAGE_LOCK_PATH:
        package_root = payload.get("packages")
        if isinstance(package_root, dict):
            root_entry = package_root.get("")
            if isinstance(root_entry, dict) and root_entry.get("version") != version:
                root_entry["version"] = version
                changed = True
    if not changed:
        return False
    content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    return _write_text_if_changed(path, content)


def _sync_cargo_version(version: str) -> bool:
    content = CARGO_MANIFEST_PATH.read_text(encoding="utf-8")
    match = re.search(r"(?ms)^\[package\]\n(?P<body>.*?)(^\[|\Z)", content)
    if not match:
        raise VersionSyncError("Cargo.toml 缺少 [package] 段，无法同步版本")
    package_body = match.group("body")
    next_body, count = re.subn(
        r'^version\s*=\s*"[^"]+"',
        f'version = "{version}"',
        package_body,
        count=1,
        flags=re.MULTILINE,
    )
    if count == 0:
        raise VersionSyncError("Cargo.toml 的 [package] 段缺少 version 字段")
    next_content = content[: match.start("body")] + next_body + content[match.end("body") :]
    return _write_text_if_changed(CARGO_MANIFEST_PATH, next_content)


def ensure_project_versions_synced() -> str:
    version = read_release_version()
    changed_paths: list[Path] = []
    for path in (PACKAGE_JSON_PATH, PACKAGE_LOCK_PATH, TAURI_CONF_PATH):
        if _sync_json_version(path, version):
            changed_paths.append(path)
    if _sync_cargo_version(version):
        changed_paths.append(CARGO_MANIFEST_PATH)
    for path in changed_paths:
        print(f"已同步版本：{path.relative_to(ROOT_DIR)} -> {version}")
    return version
