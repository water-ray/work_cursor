#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets.desktop import resolve_current_platform_id

VERSION_PATH = ROOT_DIR / "VERSION"
DEFAULT_PUBLIC_REPO = "water-ray/wateray-release"
DEFAULT_RELEASE_ROOT_DIR = ROOT_DIR / "Bin" / "github-staging-release"


class UploadReleaseError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="上传当前平台客户端产物到 GitHub staging release")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--release-root-dir",
        default="",
        help="当前平台发布素材根目录，默认 Bin/github-staging-release",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅打印计划，不真正上传",
    )
    return parser.parse_args()


def read_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not version:
        raise UploadReleaseError("VERSION 为空，无法上传当前平台产物")
    return version


def resolve_release_root_dir(raw_value: str) -> Path:
    if not raw_value.strip():
        return DEFAULT_RELEASE_ROOT_DIR
    candidate = Path(raw_value)
    if not candidate.is_absolute():
        candidate = ROOT_DIR / candidate
    return candidate


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
        detail = stderr or stdout or f"命令失败（exit_code={result.returncode}）"
        raise UploadReleaseError(detail)
    return result


def ensure_gh_ready() -> None:
    try:
        run_command(["gh", "--version"], check=True)
    except FileNotFoundError as err:
        raise UploadReleaseError("未安装 gh CLI，请先安装 GitHub CLI") from err
    run_command(["gh", "auth", "status"], check=True)


def run_git(args: list[str], allow_failure: bool = False) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(ROOT_DIR),
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        if allow_failure:
            return ""
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        raise UploadReleaseError(stderr or stdout or "git 命令失败")
    return (result.stdout or "").strip()


def resolve_current_platform_asset(version: str, release_root_dir: Path, platform_id: str) -> Path:
    release_dir = release_root_dir / f"v{version}"
    asset_path = release_dir / f"Wateray-{platform_id}-v{version}.zip"
    if not asset_path.exists():
        raise UploadReleaseError(f"未找到当前平台发布压缩包：{asset_path}")
    return asset_path


def write_platform_build_manifest(
    version: str,
    repo: str,
    release_root_dir: Path,
    asset_path: Path,
    platform_id: str,
) -> Path:
    release_dir = release_root_dir / f"v{version}"
    manifest_path = release_dir / f"platform-build-{platform_id}-v{version}.json"
    payload = {
        "version": version,
        "platform": platform_id,
        "assetName": asset_path.name,
        "publicRepo": repo,
        "sourceCommit": run_git(["rev-parse", "HEAD"]),
        "sourceBranch": run_git(["rev-parse", "--abbrev-ref", "HEAD"], allow_failure=True) or "unknown",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def release_exists(repo: str, tag: str) -> bool:
    result = run_command(
        ["gh", "release", "view", tag, "--repo", repo],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


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
    names = [item.get("name", "") for item in payload.get("assets", [])]
    platforms = []
    for name in names:
        if not name.startswith("Wateray-") or "-v" not in name:
            continue
        platforms.append(name.removeprefix("Wateray-").split("-v", 1)[0])
    return sorted(set(platforms))


def build_staging_notes(version: str, uploaded_platforms: list[str]) -> str:
    expected = {"windows", "linux", "macos"}
    uploaded = set(uploaded_platforms)
    missing = sorted(expected - uploaded)
    lines = [
        f"# Wateray staging v{version}",
        "",
        "当前 release 仅用于汇总三端构建产物，正式发布将由 GitHub Actions 统一执行。",
        "",
        f"- 已上传平台：{', '.join(sorted(uploaded)) if uploaded else '无'}",
        f"- 缺少平台：{', '.join(missing) if missing else '无'}",
    ]
    return "\n".join(lines)


def ensure_staging_release(repo: str, tag: str, title: str, *, dry_run: bool) -> None:
    if release_exists(repo, tag):
        return
    if dry_run:
        print(f"[dry-run] 将创建 staging release：{repo} {tag}")
        return
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
            "等待三端客户端产物上传完成后，由 GitHub Actions 统一汇总正式发布。",
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
        platform_id = resolve_current_platform_id()
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        asset_path = resolve_current_platform_asset(version, release_root_dir, platform_id)
        manifest_path = write_platform_build_manifest(version, repo, release_root_dir, asset_path, platform_id)
        ensure_gh_ready()
        staging_tag = f"staging-v{version}"
        ensure_staging_release(repo, staging_tag, f"Wateray staging v{version}", dry_run=args.dry_run)
        upload_platform_assets(repo, staging_tag, [asset_path, manifest_path], dry_run=args.dry_run)
        update_staging_release_notes(repo, staging_tag, version, dry_run=args.dry_run)
        if not args.dry_run:
            print(f"已上传当前平台产物：{platform_id} -> {repo} {staging_tag}")
        return 0
    except UploadReleaseError as err:
        print(f"上传当前平台产物失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"上传当前平台产物失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
