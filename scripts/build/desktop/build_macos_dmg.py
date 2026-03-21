#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.common.build_manifest import (  # noqa: E402
    DESKTOP_BUILD_MANIFEST_NAME,
    build_desktop_bundle_manifest,
    write_manifest,
)
from scripts.build.common.desktop_builder import (  # noqa: E402
    BIN_DIR,
    TAURI_DIR,
    BuildError,
    build_backend_release,
    clean_outputs,
    ensure_frontend_deps,
    ensure_host_supported,
    ensure_required_files,
    format_size,
    load_release_version,
    print_step,
    run_command,
)
from scripts.build.platforms.macos import APP_OUTPUT_DIR_NAME, DMG_FILE_NAME, TARGET  # noqa: E402


TAURI_MACOS_BUNDLE_DIR = TAURI_DIR / "src-tauri" / "target" / "release" / "bundle" / "macos"
MACOS_TEMP_DIR = ROOT_DIR / "temp" / "macos"
DMG_STAGE_DIR = MACOS_TEMP_DIR / "dmg-stage"
APP_OUTPUT_DIR = TARGET.bin_dir / APP_OUTPUT_DIR_NAME
DMG_OUTPUT_PATH = TARGET.bin_dir / DMG_FILE_NAME
LEGACY_DMG_OUTPUT_PATH = BIN_DIR / DMG_FILE_NAME
DMG_VOLUME_NAME = "Wateray"


def remove_path(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
        return
    path.unlink()


def build_tauri_macos_app() -> Path:
    print_step("编译 Tauri macOS .app")
    remove_path(TAURI_MACOS_BUNDLE_DIR)
    env = os.environ.copy()
    env["WATERAY_APP_TARGET"] = "desktop"
    env["VITE_WATERAY_APP_TARGET"] = "desktop"
    if env.get("CI", "").strip() == "1":
        env["CI"] = "true"
    run_command(
        ["npx", "tauri", "build", "--bundles", "app"],
        cwd=TAURI_DIR,
        stage="frontend_shell_build",
        code=32,
        env=env,
    )
    candidates = sorted(path for path in TAURI_MACOS_BUNDLE_DIR.glob("*.app") if path.is_dir())
    if len(candidates) != 1:
        joined = ", ".join(path.name for path in candidates) or "(none)"
        raise BuildError(32, "frontend_shell_build", f"未找到唯一的 macOS App bundle：{joined}")
    return candidates[0]


def copy_app_bundle(source_app: Path, target_app: Path, stage: str, code: int) -> None:
    remove_path(target_app)
    target_app.parent.mkdir(parents=True, exist_ok=True)
    run_command(["ditto", str(source_app), str(target_app)], cwd=ROOT_DIR, stage=stage, code=code)


def inject_packaged_daemon(app_bundle_path: Path) -> Path:
    app_macos_dir = app_bundle_path / "Contents" / "MacOS"
    if not app_macos_dir.is_dir():
        raise BuildError(33, "assemble", f"App bundle 缺少 Contents/MacOS：{app_bundle_path}")
    daemon_source_path = TARGET.bin_core_dir / TARGET.daemon_binary_name
    daemon_target_dir = app_macos_dir / "core"
    daemon_target_dir.mkdir(parents=True, exist_ok=True)
    daemon_target_path = daemon_target_dir / TARGET.daemon_binary_name
    shutil.copy2(daemon_source_path, daemon_target_path)
    return daemon_target_path


def cleanup_legacy_dmg_output() -> None:
    remove_path(LEGACY_DMG_OUTPUT_PATH)


def cleanup_packaged_backend_staging() -> None:
    remove_path(TARGET.bin_core_dir)


def assemble_unsigned_bundle(source_app: Path, release_version: str) -> tuple[Path, Path]:
    print_step(f"整理 macOS App 到 {APP_OUTPUT_DIR}")
    remove_path(APP_OUTPUT_DIR)
    target_app_path = APP_OUTPUT_DIR / TARGET.frontend_entry_name
    copy_app_bundle(source_app, target_app_path, stage="assemble", code=33)
    packaged_daemon_path = inject_packaged_daemon(target_app_path)
    write_manifest(
        APP_OUTPUT_DIR / DESKTOP_BUILD_MANIFEST_NAME,
        build_desktop_bundle_manifest(TARGET.platform_id, release_version, TARGET.output_dir_name),
    )
    cleanup_packaged_backend_staging()
    print(f"打包版本 -> {release_version}")
    return target_app_path, packaged_daemon_path


def prepare_dmg_stage(app_bundle_path: Path) -> Path:
    print_step("准备 DMG 暂存目录")
    remove_path(DMG_STAGE_DIR)
    DMG_STAGE_DIR.mkdir(parents=True, exist_ok=True)
    staged_app_path = DMG_STAGE_DIR / app_bundle_path.name
    copy_app_bundle(app_bundle_path, staged_app_path, stage="dmg_stage", code=34)
    applications_link = DMG_STAGE_DIR / "Applications"
    remove_path(applications_link)
    applications_link.symlink_to("/Applications")
    return staged_app_path


def build_unsigned_dmg() -> Path:
    print_step(f"生成无签名 DMG -> {DMG_OUTPUT_PATH}")
    remove_path(DMG_OUTPUT_PATH)
    run_command(
        [
            "hdiutil",
            "create",
            "-volname",
            DMG_VOLUME_NAME,
            "-srcfolder",
            str(DMG_STAGE_DIR),
            "-ov",
            "-format",
            "UDZO",
            str(DMG_OUTPUT_PATH),
        ],
        cwd=ROOT_DIR,
        stage="dmg_build",
        code=35,
    )
    if not DMG_OUTPUT_PATH.is_file():
        raise BuildError(35, "dmg_build", f"DMG 产物缺失：{DMG_OUTPUT_PATH}")
    return DMG_OUTPUT_PATH


def path_size_bytes(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            total += child.stat().st_size
    return total


def print_summary(
    start_ts: float,
    release_version: str,
    app_bundle_path: Path,
    packaged_daemon_path: Path,
    dmg_path: Path,
) -> None:
    elapsed = time.time() - start_ts
    print_step("构建完成")
    print(f"- 平台：{TARGET.display_name}")
    print(f"- 目录：{TARGET.bin_dir}")
    print(f"- App 目录：{APP_OUTPUT_DIR}")
    print(f"- App：{app_bundle_path} ({format_size(path_size_bytes(app_bundle_path))})")
    print(f"- 内核：{packaged_daemon_path} ({format_size(packaged_daemon_path.stat().st_size)})")
    print(f"- DMG：{dmg_path} ({format_size(dmg_path.stat().st_size)})")
    print(f"- 统一版本：{release_version}")
    print(f"- 总耗时：{elapsed:.1f}s")


def main() -> int:
    start_ts = time.time()
    try:
        ensure_host_supported(TARGET)
        ensure_required_files(TARGET)
        release_version = load_release_version()
        clean_outputs(TARGET)
        cleanup_legacy_dmg_output()
        build_backend_release(TARGET, release_version)
        ensure_frontend_deps()
        source_app_path = build_tauri_macos_app()
        app_bundle_path, packaged_daemon_path = assemble_unsigned_bundle(source_app_path, release_version)
        prepare_dmg_stage(app_bundle_path)
        dmg_path = build_unsigned_dmg()
        print_summary(start_ts, release_version, app_bundle_path, packaged_daemon_path, dmg_path)
        return 0
    except BuildError as err:
        print(f"\n构建失败：{err}", file=sys.stderr)
        return err.code
    except Exception as err:  # pragma: no cover
        print(f"\n构建失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
