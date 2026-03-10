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
    PLATFORM_ORDER,
    ReleaseAsset,
    ReleaseFrameworkError,
    copy_release_assets_to_dir,
    load_platform_build_manifest,
    manifest_to_release_assets,
    read_version,
    resolve_expected_release_assets,
    resolve_release_root_dir,
    sha256_file,
    write_latest_json,
    write_latest_json_for_github,
    write_release_notes,
    write_sha256_sums,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从 GitHub staging release 产物汇总正式发布素材")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="最终公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--version",
        default="",
        help="要汇总的版本号，默认读取 VERSION",
    )
    parser.add_argument(
        "--source-archives-dir",
        required=True,
        help="已下载的 staging 资产目录",
    )
    parser.add_argument(
        "--release-root-dir",
        default="",
        help="正式发布素材输出根目录，默认 Bin/github-release",
    )
    parser.add_argument(
        "--status-file",
        default="",
        help="汇总状态说明输出文件，默认 Bin/github-release/aggregate-status-v<version>.md",
    )
    return parser.parse_args()


def resolve_source_archives_dir(raw_value: str) -> Path:
    candidate = Path(raw_value)
    if not candidate.is_absolute():
        candidate = ROOT_DIR / candidate
    return candidate


def resolve_status_file(raw_value: str, release_root_dir: Path, version: str) -> Path:
    if raw_value.strip():
        candidate = Path(raw_value)
        if not candidate.is_absolute():
            candidate = ROOT_DIR / candidate
        return candidate
    return release_root_dir / f"aggregate-status-v{version}.md"


def validate_manifest_assets(version: str, platform: str, source_archives_dir: Path, assets: list[ReleaseAsset], manifest: dict[str, object]) -> None:
    expected_names = {item.asset_name for item in resolve_expected_release_assets(version, platform)}
    actual_names = {item.asset_name for item in assets}
    if actual_names != expected_names:
        raise ReleaseFrameworkError(
            f"{platform} staging 资产不完整：expected={sorted(expected_names)} actual={sorted(actual_names)}"
        )
    assets_payload = manifest.get("assets", [])
    if not isinstance(assets_payload, list):
        raise ReleaseFrameworkError(f"{platform} 平台清单 assets 字段非法")
    by_name = {asset.asset_name: asset for asset in assets}
    for item in assets_payload:
        if not isinstance(item, dict):
            raise ReleaseFrameworkError(f"{platform} 平台清单资产条目非法")
        name = str(item.get("name", "")).strip()
        if not name:
            raise ReleaseFrameworkError(f"{platform} 平台清单缺少资产名称")
        asset = by_name.get(name)
        if asset is None:
            raise ReleaseFrameworkError(f"{platform} staging 目录缺少资产：{name}")
        expected_size = int(item.get("sizeBytes", 0) or 0)
        if expected_size and asset.path.stat().st_size != expected_size:
            raise ReleaseFrameworkError(f"{platform} 资产大小不匹配：{name}")
        expected_sha = str(item.get("sha256", "")).strip().lower()
        if expected_sha and sha256_file(asset.path).lower() != expected_sha:
            raise ReleaseFrameworkError(f"{platform} 资产校验值不匹配：{name}")


def validate_staging_assets(
    version: str,
    source_archives_dir: Path,
) -> tuple[set[str], dict[str, dict[str, object]], dict[str, list[ReleaseAsset]]]:
    if not source_archives_dir.exists():
        raise ReleaseFrameworkError(f"staging 产物目录不存在：{source_archives_dir}")
    manifests: dict[str, dict[str, object]] = {}
    platform_assets: dict[str, list[ReleaseAsset]] = {}
    available_platforms: set[str] = set()
    for platform in PLATFORM_ORDER:
        manifest_path = source_archives_dir / f"platform-build-{platform}-v{version}.json"
        if not manifest_path.exists():
            continue
        manifest = load_platform_build_manifest(manifest_path)
        if str(manifest.get("platform", "")).strip() != platform:
            raise ReleaseFrameworkError(f"平台清单与文件名不一致：{manifest_path}")
        if str(manifest.get("version", "")).strip() != version:
            raise ReleaseFrameworkError(f"平台清单版本不一致：{manifest_path}")
        assets = manifest_to_release_assets(manifest, source_archives_dir)
        validate_manifest_assets(version, platform, source_archives_dir, assets, manifest)
        manifests[platform] = manifest
        platform_assets[platform] = assets
        available_platforms.add(platform)
    commits = {str(item.get("sourceCommit", "")).strip() for item in manifests.values() if str(item.get("sourceCommit", "")).strip()}
    if len(commits) > 1:
        raise ReleaseFrameworkError("Windows 与 Linux 构建来源提交不一致，请确认两台机器使用同一源码版本")
    return available_platforms, manifests, platform_assets


def write_status_file(
    status_file: Path,
    version: str,
    available_platforms: set[str],
    manifests: dict[str, dict[str, object]],
) -> None:
    expected = set(PLATFORM_ORDER)
    missing = sorted(expected - available_platforms)
    lines = [
        f"# Wateray v{version} 汇总状态",
        "",
        "正式 Release 尚未发布，当前仍在等待 staging 产物齐备。",
        "",
        f"- 已收到平台：{', '.join(sorted(available_platforms)) if available_platforms else '无'}",
        f"- 缺少平台：{', '.join(missing) if missing else '无'}",
    ]
    commits = sorted({str(item.get('sourceCommit', '')).strip() for item in manifests.values() if str(item.get('sourceCommit', '')).strip()})
    if commits:
        lines.append(f"- 当前提交：{', '.join(commits)}")
    status_file.parent.mkdir(parents=True, exist_ok=True)
    status_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_release_assets(
    version: str,
    repo: str,
    platform_assets: dict[str, list[ReleaseAsset]],
    release_root_dir: Path,
) -> tuple[Path, Path]:
    assets: list[ReleaseAsset] = []
    for platform in PLATFORM_ORDER:
        assets.extend(platform_assets.get(platform, []))
    release_dir, copied_assets = copy_release_assets_to_dir(release_root_dir, version, assets)
    write_sha256_sums(release_dir, copied_assets)
    write_latest_json(version, release_dir, copied_assets)
    write_latest_json_for_github(version, repo, release_dir, copied_assets)
    notes_path = write_release_notes(version, repo, release_dir, copied_assets)
    return release_dir, notes_path


def main() -> int:
    try:
        args = parse_args()
        version = args.version.strip() or read_version()
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        status_file = resolve_status_file(args.status_file, release_root_dir, version)
        source_archives_dir = resolve_source_archives_dir(args.source_archives_dir)
        available_platforms, manifests, platform_assets = validate_staging_assets(version, source_archives_dir)
        missing = sorted(set(PLATFORM_ORDER) - available_platforms)
        if missing:
            write_status_file(status_file, version, available_platforms, manifests)
            print(f"等待更多平台产物：{', '.join(missing)}")
            print(f"状态文件：{status_file}")
            return 2
        release_dir, notes_path = build_release_assets(
            version=version,
            repo=args.repo.strip() or DEFAULT_PUBLIC_REPO,
            platform_assets=platform_assets,
            release_root_dir=release_root_dir,
        )
        print(f"已汇总正式发布素材：{release_dir}")
        print(f"发布说明：{notes_path}")
        return 0
    except ReleaseFrameworkError as err:
        print(f"汇总 staging release 失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"汇总 staging release 失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
