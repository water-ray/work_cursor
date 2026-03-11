from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
CORE_DIR = ROOT_DIR / "core"
TAURI_DIR = ROOT_DIR / "TauriApp"
VERSION_PATH = ROOT_DIR / "VERSION"
LINUX_ASSET_DIR = ROOT_DIR / "scripts" / "build" / "assets" / "linux"
DESKTOP_BUILD_MANIFEST_NAME = "bundle-manifest.json"
LINUX_PACKAGE_MANIFEST_NAME = "package-manifest.json"

EXCLUDED_DIR_NAMES = {
    ".git",
    ".idea",
    ".cursor",
    ".vscode",
    "__pycache__",
    "target",
    "node_modules",
    "dist",
    "Bin",
}


def _iter_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative_parts = path.relative_to(root).parts
        if any(part in EXCLUDED_DIR_NAMES for part in relative_parts):
            continue
        files.append(path)
    return files


def hash_files(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted({path.resolve() for path in paths}):
        relative_path = path.relative_to(ROOT_DIR).as_posix()
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def collect_desktop_build_inputs(platform_id: str) -> list[Path]:
    inputs: list[Path] = []
    for path in (
        VERSION_PATH,
        ROOT_DIR / "scripts" / "build" / "common" / "desktop_builder.py",
        ROOT_DIR / "scripts" / "build" / "targets" / "desktop.py",
        ROOT_DIR / "scripts" / "build" / "targets" / "build_current_platform_client.py",
        ROOT_DIR / "scripts" / "build" / "platforms" / f"{platform_id}.py",
        ROOT_DIR / "scripts" / "build" / "assets" / "wateray_server.manifest",
        CORE_DIR / "go.mod",
        CORE_DIR / "go.sum",
        TAURI_DIR / "package.json",
        TAURI_DIR / "package-lock.json",
        TAURI_DIR / "vite.config.ts",
        TAURI_DIR / "vite.config.js",
        TAURI_DIR / "vite.config.mjs",
        TAURI_DIR / "index.html",
    ):
        if path.is_file():
            inputs.append(path)

    inputs.extend(_iter_files(CORE_DIR / "cmd"))
    inputs.extend(_iter_files(CORE_DIR / "internal"))
    inputs.extend(_iter_files(TAURI_DIR / "src"))
    inputs.extend(_iter_files(TAURI_DIR / "src-tauri"))
    inputs.extend(_iter_files(TAURI_DIR / "default-config"))
    if platform_id == "linux":
        inputs.extend(_iter_files(LINUX_ASSET_DIR))
    return inputs


def collect_linux_package_inputs() -> list[Path]:
    inputs = collect_desktop_build_inputs("linux")
    for path in (
        ROOT_DIR / "scripts" / "build" / "targets" / "linux_package.py",
        ROOT_DIR / "scripts" / "release" / "release_framework.py",
    ):
        if path.is_file():
            inputs.append(path)
    return inputs


def build_desktop_bundle_manifest(platform_id: str, version: str, output_dir_name: str) -> dict[str, object]:
    inputs = collect_desktop_build_inputs(platform_id)
    return {
        "kind": "desktop-bundle",
        "platform": platform_id,
        "version": version,
        "outputDirName": output_dir_name,
        "sourceHash": hash_files(inputs),
        "sourceFileCount": len(inputs),
    }


def build_linux_package_manifest(version: str, bundle_source_hash: str, asset_names: list[str]) -> dict[str, object]:
    inputs = collect_linux_package_inputs()
    return {
        "kind": "linux-packages",
        "platform": "linux",
        "version": version,
        "bundleSourceHash": bundle_source_hash,
        "sourceHash": hash_files(inputs),
        "sourceFileCount": len(inputs),
        "assetNames": sorted(asset_names),
    }


def read_manifest(path: Path) -> dict[str, object] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def write_manifest(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def manifest_matches(path: Path, expected_payload: dict[str, object]) -> bool:
    return read_manifest(path) == expected_payload
