#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


from scripts.release.release_framework import (
    DEFAULT_PUBLIC_REPO,
    ReleaseFrameworkError,
    build_assets,
    format_size,
    read_version,
    resolve_release_root_dir,
    resolve_requested_platforms,
    resolve_source_archives_dir,
    write_latest_json,
    write_latest_json_for_github,
    write_release_notes,
    write_sha256_sums,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="为 GitHub Release 生成发布素材")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--platform",
        choices=("all", "current", "windows", "linux", "android"),
        default="all",
        help="要收集的平台：all / current / windows / linux / android，默认 all",
    )
    parser.add_argument(
        "--source-archives-dir",
        default="",
        help="直接复用已有发布资产目录；传入后不会重新打包 Bin/Wateray-* 目录",
    )
    parser.add_argument(
        "--release-root-dir",
        default="",
        help="发布素材输出根目录，默认 Bin/github-release",
    )
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        version = read_version()
        requested_platforms = resolve_requested_platforms(args.platform)
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        source_archives_dir = resolve_source_archives_dir(args.source_archives_dir)
        release_dir, assets = build_assets(
            version=version,
            release_root_dir=release_root_dir,
            requested_platforms=requested_platforms,
            source_archives_dir=source_archives_dir,
        )
        sha_path = write_sha256_sums(release_dir, assets)
        latest_path = write_latest_json(version, release_dir, assets)
        latest_github_path = write_latest_json_for_github(version, args.repo, release_dir, assets)
        notes_path = write_release_notes(version, args.repo, release_dir, assets)

        print(f"已生成 GitHub Release 素材目录：{release_dir}")
        for asset in assets:
            print(f"- {asset.asset_name} ({format_size(asset.path.stat().st_size)})")
        print(f"- {sha_path.name}")
        print(f"- {latest_path.name}")
        print(f"- {latest_github_path.name}")
        print(f"- {notes_path.name}")
        return 0
    except ReleaseFrameworkError as err:
        print(f"发布素材生成失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"发布素材生成失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
