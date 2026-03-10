#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.release.prepare_github_release import (
    DEFAULT_PUBLIC_REPO,
    build_assets,
    read_version,
    resolve_release_root_dir,
    write_latest_json,
    write_latest_json_for_github,
    write_release_notes,
    write_sha256_sums,
)

EXPECTED_PLATFORMS = ("windows", "linux", "macos")


class AggregateReleaseError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


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
        help="已下载的 staging zip 目录",
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


def load_manifest(path: Path) -> dict[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise AggregateReleaseError(f"平台清单解析失败：{path}") from err
    return {
        "platform": str(payload.get("platform", "")).strip(),
        "version": str(payload.get("version", "")).strip(),
        "assetName": str(payload.get("assetName", "")).strip(),
        "sourceCommit": str(payload.get("sourceCommit", "")).strip(),
        "sourceBranch": str(payload.get("sourceBranch", "")).strip(),
    }


def validate_staging_assets(version: str, source_archives_dir: Path) -> tuple[set[str], dict[str, dict[str, str]]]:
    if not source_archives_dir.exists():
        raise AggregateReleaseError(f"staging 产物目录不存在：{source_archives_dir}")
    manifests: dict[str, dict[str, str]] = {}
    available_platforms: set[str] = set()
    for platform in EXPECTED_PLATFORMS:
        archive_path = source_archives_dir / f"Wateray-{platform}-v{version}.zip"
        manifest_path = source_archives_dir / f"platform-build-{platform}-v{version}.json"
        if archive_path.exists():
            available_platforms.add(platform)
        if not manifest_path.exists():
            continue
        manifest = load_manifest(manifest_path)
        if manifest["platform"] != platform:
            raise AggregateReleaseError(f"平台清单与文件名不一致：{manifest_path}")
        if manifest["version"] != version:
            raise AggregateReleaseError(f"平台清单版本不一致：{manifest_path}")
        if manifest["assetName"] and manifest["assetName"] != archive_path.name:
            raise AggregateReleaseError(f"平台清单记录的压缩包名不匹配：{manifest_path}")
        manifests[platform] = manifest
    commits = {item["sourceCommit"] for item in manifests.values() if item["sourceCommit"]}
    if len(commits) > 1:
        raise AggregateReleaseError("三端构建来源提交不一致，请确认三台机器使用同一源码版本")
    return available_platforms, manifests


def write_status_file(
    status_file: Path,
    version: str,
    available_platforms: set[str],
    manifests: dict[str, dict[str, str]],
) -> None:
    expected = set(EXPECTED_PLATFORMS)
    missing = sorted(expected - available_platforms)
    lines = [
        f"# Wateray v{version} 汇总状态",
        "",
        "正式 Release 尚未发布，当前仍在等待 staging 产物齐备。",
        "",
        f"- 已收到平台：{', '.join(sorted(available_platforms)) if available_platforms else '无'}",
        f"- 缺少平台：{', '.join(missing) if missing else '无'}",
    ]
    commits = sorted({item['sourceCommit'] for item in manifests.values() if item.get('sourceCommit')})
    if commits:
        lines.append(f"- 当前提交：{', '.join(commits)}")
    status_file.parent.mkdir(parents=True, exist_ok=True)
    status_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_release_assets(version: str, repo: str, source_archives_dir: Path, release_root_dir: Path) -> tuple[Path, Path]:
    requested_platforms = set(EXPECTED_PLATFORMS)
    release_dir, archives = build_assets(
        version=version,
        release_root_dir=release_root_dir,
        requested_platforms=requested_platforms,
        source_archives_dir=source_archives_dir,
    )
    write_sha256_sums(release_dir, archives)
    write_latest_json(version, release_dir, archives)
    write_latest_json_for_github(version, repo, release_dir, archives)
    notes_path = write_release_notes(version, repo, release_dir, archives)
    return release_dir, notes_path


def main() -> int:
    try:
        args = parse_args()
        version = args.version.strip() or read_version()
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        status_file = resolve_status_file(args.status_file, release_root_dir, version)
        source_archives_dir = resolve_source_archives_dir(args.source_archives_dir)
        available_platforms, manifests = validate_staging_assets(version, source_archives_dir)
        missing = sorted(set(EXPECTED_PLATFORMS) - available_platforms)
        if missing:
            write_status_file(status_file, version, available_platforms, manifests)
            print(f"等待更多平台产物：{', '.join(missing)}")
            print(f"状态文件：{status_file}")
            return 2
        release_dir, notes_path = build_release_assets(
            version=version,
            repo=args.repo.strip() or DEFAULT_PUBLIC_REPO,
            source_archives_dir=source_archives_dir,
            release_root_dir=release_root_dir,
        )
        print(f"已汇总正式发布素材：{release_dir}")
        print(f"发布说明：{notes_path}")
        return 0
    except AggregateReleaseError as err:
        print(f"汇总 staging release 失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"汇总 staging release 失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
