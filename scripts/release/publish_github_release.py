#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
VERSION_PATH = ROOT_DIR / "VERSION"
RELEASE_ROOT_DIR = ROOT_DIR / "Bin" / "github-release"
DEFAULT_PUBLIC_REPO = "water-ray/wateray-release"


class ReleasePublishError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="通过 gh CLI 自动发布客户端 GitHub Release")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅打印将要执行的动作，不真正创建或更新 GitHub Release",
    )
    parser.add_argument(
        "--version",
        default="",
        help="要发布的版本号，默认读取 VERSION",
    )
    parser.add_argument(
        "--release-root-dir",
        default="",
        help="发布素材根目录，默认 Bin/github-release",
    )
    return parser.parse_args()


def read_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not version:
        raise ReleasePublishError("VERSION 为空，无法发布 GitHub Release")
    return version


def resolve_release_root_dir(raw_value: str) -> Path:
    if not raw_value.strip():
        return RELEASE_ROOT_DIR
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
    )
    if check and result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        detail = stderr or stdout or f"命令失败（exit_code={result.returncode}）"
        raise ReleasePublishError(detail)
    return result


def ensure_gh_ready() -> None:
    try:
        run_command(["gh", "--version"], check=True)
    except FileNotFoundError as err:
        raise ReleasePublishError("未安装 gh CLI，请先安装 GitHub CLI") from err
    run_command(["gh", "auth", "status"], check=True)


def resolve_release_files(version: str, release_root_dir: Path) -> tuple[Path, Path, list[Path]]:
    release_dir = release_root_dir / f"v{version}"
    notes_path = release_dir / f"release-notes-v{version}.md"
    if not release_dir.exists():
        raise ReleasePublishError(f"未找到发布素材目录：{release_dir}")
    if not notes_path.exists():
        raise ReleasePublishError(f"未找到发布说明：{notes_path}")
    zip_assets = sorted(release_dir.glob("Wateray-*-v*.zip"))
    metadata_assets = [
        release_dir / "SHA256SUMS.txt",
        release_dir / "latest.json",
        release_dir / "latest-github.json",
    ]
    assets = [*zip_assets, *metadata_assets]
    missing_assets = [str(path) for path in assets if not path.exists()]
    if not zip_assets:
        missing_assets.append("至少一个 Wateray-<platform>-v<version>.zip")
    if missing_assets:
        raise ReleasePublishError(f"发布素材不完整：{', '.join(missing_assets)}")
    return release_dir, notes_path, assets


def release_exists(repo: str, tag: str) -> bool:
    result = run_command(
        ["gh", "release", "view", tag, "--repo", repo],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def print_plan(repo: str, tag: str, notes_path: Path, assets: list[Path], exists: bool) -> None:
    action = "更新已有 Release" if exists else "创建新 Release"
    print(f"[dry-run] 仓库：{repo}")
    print(f"[dry-run] Tag：{tag}")
    print(f"[dry-run] 动作：{action}")
    print(f"[dry-run] 说明文件：{notes_path}")
    print("[dry-run] 上传文件：")
    for asset in assets:
        print(f"  - {asset}")


def publish_release(repo: str, tag: str, title: str, notes_path: Path, assets: list[Path], *, dry_run: bool) -> None:
    exists = release_exists(repo, tag)
    if dry_run:
        print_plan(repo, tag, notes_path, assets, exists)
        return

    if exists:
        run_command(
            [
                "gh",
                "release",
                "upload",
                tag,
                *[str(path) for path in assets],
                "--repo",
                repo,
                "--clobber",
            ],
            check=True,
        )
        run_command(
            [
                "gh",
                "release",
                "edit",
                tag,
                "--repo",
                repo,
                "--title",
                title,
                "--notes-file",
                str(notes_path),
                "--draft=false",
                "--prerelease=false",
                "--latest=true",
            ],
            check=True,
        )
        print(f"已更新 GitHub Release：{repo} {tag}")
        return

    run_command(
        [
            "gh",
            "release",
            "create",
            tag,
            *[str(path) for path in assets],
            "--repo",
            repo,
            "--title",
            title,
            "--notes-file",
            str(notes_path),
            "--latest",
        ],
        check=True,
    )
    print(f"已创建 GitHub Release：{repo} {tag}")


def main() -> int:
    try:
        args = parse_args()
        version = args.version.strip() or read_version()
        repo = args.repo.strip() or DEFAULT_PUBLIC_REPO
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        tag = f"v{version}"
        title = f"Wateray {tag}"
        _release_dir, notes_path, assets = resolve_release_files(version, release_root_dir)
        ensure_gh_ready()
        publish_release(repo, tag, title, notes_path, assets, dry_run=args.dry_run)
        return 0
    except ReleasePublishError as err:
        print(f"GitHub Release 发布失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"GitHub Release 发布失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
