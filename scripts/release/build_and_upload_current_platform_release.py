#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.release.release_framework import DEFAULT_PUBLIC_REPO, resolve_release_root_dir


class BuildAndUploadReleaseError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def run_command(command: list[str]) -> None:
    result = subprocess.run(command, cwd=str(ROOT_DIR), check=False)
    if result.returncode != 0:
        raise BuildAndUploadReleaseError(f"命令执行失败：{' '.join(command)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建并上传当前平台客户端产物到 GitHub staging release")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--release-root-dir",
        default="Bin/github-staging-release",
        help="当前平台 staging 素材根目录，默认 Bin/github-staging-release",
    )
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        repo = args.repo.strip() or DEFAULT_PUBLIC_REPO
        release_root_dir = resolve_release_root_dir(args.release_root_dir)

        print("==> 构建当前平台客户端")
        run_command([sys.executable, str(ROOT_DIR / "scripts" / "build" / "targets" / "build_current_platform_client.py")])

        print("==> 生成当前平台 staging 素材")
        run_command(
            [
                sys.executable,
                str(ROOT_DIR / "scripts" / "release" / "prepare_github_release.py"),
                "--repo",
                repo,
                "--platform",
                "current",
                "--release-root-dir",
                str(release_root_dir),
            ]
        )

        print("==> 上传当前平台产物到 GitHub staging release")
        run_command(
            [
                sys.executable,
                str(ROOT_DIR / "scripts" / "release" / "upload_current_platform_release.py"),
                "--repo",
                repo,
                "--release-root-dir",
                str(release_root_dir),
            ]
        )
        return 0
    except BuildAndUploadReleaseError as err:
        print(f"当前平台公开发布失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"当前平台公开发布失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
