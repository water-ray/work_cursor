#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets.desktop import resolve_current_platform_id
from scripts.release.release_framework import (
    DEFAULT_PUBLIC_REPO,
    PLATFORM_DISPLAY_NAMES,
    PLATFORM_ORDER,
    ReleaseFrameworkError,
    format_platform_delivery_labels,
    read_version,
    resolve_release_assets_in_dir,
    resolve_release_root_dir,
    write_platform_build_manifest,
)

DEFAULT_RELEASE_ROOT_DIR = ROOT_DIR / "Bin" / "github-staging-release"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="上传单个平台客户端产物到 GitHub staging release")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--platform",
        choices=("current", "windows", "linux", "macos", "android"),
        default="current",
        help="要上传的平台：current / windows / linux / macos / android，默认 current",
    )
    parser.add_argument(
        "--release-root-dir",
        default="",
        help="单平台发布素材根目录，默认 Bin/github-staging-release",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅打印计划，不真正上传",
    )
    return parser.parse_args()


def run_command(command: list[str], *, capture_output: bool = False, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=str(ROOT_DIR),
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture_output,
        check=False,
    )
    if check and result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        raise ReleaseFrameworkError(stderr or stdout or f"命令失败（exit_code={result.returncode}）")
    return result


def ensure_gh_ready() -> None:
    try:
        run_command(["gh", "--version"], check=True)
    except FileNotFoundError as err:
        raise ReleaseFrameworkError("未安装 gh CLI，请先安装 GitHub CLI") from err
    run_command(["gh", "auth", "status"], check=True)


def resolve_staging_root_dir(raw_value: str) -> Path:
    if not raw_value.strip():
        return DEFAULT_RELEASE_ROOT_DIR
    return resolve_release_root_dir(raw_value)


def resolve_target_platform(platform_arg: str) -> str:
    if platform_arg == "current":
        return resolve_current_platform_id()
    return platform_arg


def collect_uploaded_platforms(repo: str, tag: str) -> list[str]:
    result = run_command(
        [
            "gh",
            "release",
            "view",
            tag,
            "--repo",
            repo,
            "--json",
            "assets",
        ],
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout or "{}")
    names = [str(item.get("name", "")).strip() for item in payload.get("assets", [])]
    platforms = []
    for name in names:
        if not name.startswith("platform-build-") or "-v" not in name:
            continue
        platforms.append(name.removeprefix("platform-build-").split("-v", 1)[0])
    return sorted(set(platforms))


def build_staging_notes(version: str, uploaded_platforms: list[str]) -> str:
    expected = set(PLATFORM_ORDER)
    uploaded = set(uploaded_platforms)
    missing = sorted(expected - uploaded)
    uploaded_labels = [PLATFORM_DISPLAY_NAMES.get(item, item) for item in sorted(uploaded)]
    missing_labels = [PLATFORM_DISPLAY_NAMES.get(item, item) for item in missing]
    expected_labels = " / ".join(format_platform_delivery_labels(list(PLATFORM_ORDER)))
    lines = [
        f"# Wateray staging v{version}",
        "",
        "当前 staging release 仅用于汇总各平台待发布产物，不直接作为最终对外发布说明。",
        "",
        f"- 目标平台：{expected_labels}",
        f"- 已上传平台：{', '.join(uploaded_labels) if uploaded_labels else '无'}",
        f"- 缺少平台：{', '.join(missing_labels) if missing_labels else '无'}",
    ]
    return "\n".join(lines)


def release_exists(repo: str, tag: str) -> bool:
    result = run_command(
        ["gh", "release", "view", tag, "--repo", repo],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def ensure_staging_release(repo: str, tag: str, title: str, *, dry_run: bool) -> None:
    if release_exists(repo, tag):
        return
    if dry_run:
        print(f"[dry-run] 将创建 staging release：{repo} {tag}")
        return
    expected_labels = " / ".join(format_platform_delivery_labels(list(PLATFORM_ORDER)))
    run_command(
        [
            "gh",
            "release",
            "create",
            tag,
            "--repo",
            repo,
            "--title",
            title,
            "--notes",
            f"等待以下平台产物上传完成后，由 GitHub Actions 统一汇总正式发布：{expected_labels}",
            "--draft",
            "--prerelease",
        ]
    )


def upload_platform_assets(repo: str, tag: str, files: list[Path], *, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] 将上传到 {repo} {tag}:")
        for item in files:
            print(f"  - {item}")
        return
    run_command(
        [
            "gh",
            "release",
            "upload",
            tag,
            *[str(path) for path in files],
            "--repo",
            repo,
            "--clobber",
        ]
    )


def update_staging_release_notes(repo: str, tag: str, version: str, *, dry_run: bool) -> None:
    uploaded_platforms = collect_uploaded_platforms(repo, tag) if not dry_run else []
    notes = build_staging_notes(version, uploaded_platforms)
    if dry_run:
        print("[dry-run] staging release 说明：")
        print(notes)
        return
    run_command(
        [
            "gh",
            "release",
            "edit",
            tag,
            "--repo",
            repo,
            "--title",
            f"Wateray staging v{version}",
            "--notes",
            notes,
            "--draft=true",
            "--prerelease=true",
        ]
    )


def main() -> int:
    try:
        args = parse_args()
        version = read_version()
        repo = args.repo.strip() or DEFAULT_PUBLIC_REPO
        platform_id = resolve_target_platform(args.platform)
        release_root_dir = resolve_staging_root_dir(args.release_root_dir)
        release_dir = release_root_dir / f"v{version}"
        assets = resolve_release_assets_in_dir(version, release_dir, {platform_id})
        manifest_path = write_platform_build_manifest(version, repo, release_dir, platform_id, assets)
        ensure_gh_ready()
        staging_tag = f"staging-v{version}"
        ensure_staging_release(repo, staging_tag, f"Wateray staging v{version}", dry_run=args.dry_run)
        upload_platform_assets(repo, staging_tag, [*([item.path for item in assets]), manifest_path], dry_run=args.dry_run)
        update_staging_release_notes(repo, staging_tag, version, dry_run=args.dry_run)
        if not args.dry_run:
            print(f"已上传平台产物：{platform_id} -> {repo} {staging_tag}")
        return 0
    except ReleaseFrameworkError as err:
        print(f"上传平台产物失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"上传平台产物失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
