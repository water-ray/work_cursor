#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets.build_android_release import ANDROID_BIN_DIR, BUILD_INFO_PATH, EXPECTED_OUTPUT_ABIS
from scripts.release.release_framework import DEFAULT_PUBLIC_REPO, resolve_release_root_dir, read_version


class BuildAndUploadAndroidReleaseError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def run_command(command: list[str]) -> None:
    result = subprocess.run(command, cwd=str(ROOT_DIR), check=False)
    if result.returncode != 0:
        raise BuildAndUploadAndroidReleaseError(f"命令执行失败：{' '.join(command)}")


def expected_android_asset_names(version: str) -> set[str]:
    return {f"Wateray-Android-v{version}-{abi}-release.apk" for abi in EXPECTED_OUTPUT_ABIS}


def android_release_assets_ready(version: str) -> bool:
    expected_names = expected_android_asset_names(version)
    expected_paths = [ANDROID_BIN_DIR / name for name in expected_names]
    if not all(path.exists() for path in expected_paths):
        return False
    if not BUILD_INFO_PATH.exists():
        return False
    try:
        payload = json.loads(BUILD_INFO_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    if str(payload.get("version", "")).strip() != version:
        return False
    artifacts = payload.get("artifacts", [])
    if not isinstance(artifacts, list):
        return False
    actual_names = {str(item.get("fileName", "")).strip() for item in artifacts if isinstance(item, dict)}
    return expected_names.issubset(actual_names)


def build_android_assets(version: str) -> None:
    if android_release_assets_ready(version):
        print("==> 复用 Android 已有构建产物")
        return
    print("==> 构建 Android 客户端")
    run_command([sys.executable, str(ROOT_DIR / "scripts" / "build" / "targets" / "build_android_release.py")])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建并上传 Android 客户端产物到 GitHub staging release")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--release-root-dir",
        default="Bin/github-staging-release",
        help="Android staging 素材根目录，默认 Bin/github-staging-release",
    )
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        repo = args.repo.strip() or DEFAULT_PUBLIC_REPO
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        version = read_version()

        build_android_assets(version)

        print("==> 生成 Android staging 素材")
        run_command(
            [
                sys.executable,
                str(ROOT_DIR / "scripts" / "release" / "prepare_github_release.py"),
                "--repo",
                repo,
                "--platform",
                "android",
                "--release-root-dir",
                str(release_root_dir),
            ]
        )

        print("==> 上传 Android 产物到 GitHub staging release")
        run_command(
            [
                sys.executable,
                str(ROOT_DIR / "scripts" / "release" / "upload_current_platform_release.py"),
                "--repo",
                repo,
                "--platform",
                "android",
                "--release-root-dir",
                str(release_root_dir),
            ]
        )
        return 0
    except BuildAndUploadAndroidReleaseError as err:
        print(f"Android 公开发布失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"Android 公开发布失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
