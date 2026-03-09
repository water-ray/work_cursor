#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
VERSION_PATH = ROOT_DIR / "VERSION"
BIN_DIR = ROOT_DIR / "Bin"
CLIENT_DIR = BIN_DIR / "Wateray-windows"
ADS_SERVER_DIR = BIN_DIR / "adsroot" / "server"
ADS_WEB_DIR = BIN_DIR / "adsroot" / "web"
RELEASE_ROOT_DIR = BIN_DIR / "github-release"
DEFAULT_PUBLIC_REPO = "water-ray/wateray"


@dataclass
class ReleaseAsset:
    label: str
    source_dir: Path
    zip_name: str


class ReleasePrepareError(RuntimeError):
    pass


def read_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not version:
        raise ReleasePrepareError("VERSION 为空，无法生成发布素材")
    return version


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="为 GitHub Release 生成发布素材")
    parser.add_argument(
        "--repo",
        default=DEFAULT_PUBLIC_REPO,
        help="公开发布仓库 owner/name，例如 water-ray/wateray",
    )
    return parser.parse_args()


def ensure_dir_exists(path: Path, label: str) -> None:
    if not path.exists() or not path.is_dir():
        raise ReleasePrepareError(f"{label} 不存在：{path}")


def format_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size_bytes)
    unit_index = 0
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1
    return f"{value:.2f} {units[unit_index]}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def zip_directory(source_dir: Path, destination_without_suffix: Path) -> Path:
    archive_base = str(destination_without_suffix)
    zip_path = Path(shutil.make_archive(archive_base, "zip", root_dir=str(source_dir.parent), base_dir=source_dir.name))
    return zip_path


def build_assets(version: str) -> tuple[Path, list[Path]]:
    release_dir = RELEASE_ROOT_DIR / f"v{version}"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    release_dir.mkdir(parents=True, exist_ok=True)

    asset_defs = [
        ReleaseAsset(
            label="Windows 客户端整包",
            source_dir=CLIENT_DIR,
            zip_name=f"Wateray-windows-v{version}.zip",
        ),
        ReleaseAsset(
            label="广告服务端",
            source_dir=ADS_SERVER_DIR,
            zip_name=f"wateray-ads-server-v{version}.zip",
        ),
        ReleaseAsset(
            label="广告前端",
            source_dir=ADS_WEB_DIR,
            zip_name=f"wateray-ads-web-v{version}.zip",
        ),
    ]

    archives: list[Path] = []
    for item in asset_defs:
        ensure_dir_exists(item.source_dir, item.label)
        archive = zip_directory(item.source_dir, release_dir / item.zip_name.removesuffix(".zip"))
        archives.append(archive)
    return release_dir, archives


def write_sha256_sums(release_dir: Path, archives: list[Path]) -> Path:
    lines = [f"{sha256_file(path)}  {path.name}" for path in archives]
    output = release_dir / "SHA256SUMS.txt"
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output


def write_latest_json(version: str, release_dir: Path, archives: list[Path]) -> Path:
    release_tag = f"v{version}"
    payload = {
        "version": version,
        "channel": "stable",
        "releaseTag": release_tag,
        "releaseName": f"Wateray {release_tag}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "assets": [
            {
                "name": path.name,
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in archives
        ],
    }
    output = release_dir / "latest.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def write_latest_json_for_github(
    version: str,
    public_repo: str,
    release_dir: Path,
    archives: list[Path],
) -> Path:
    release_tag = f"v{version}"
    repo = public_repo.strip() or DEFAULT_PUBLIC_REPO
    release_url = f"https://github.com/{repo}/releases/tag/{release_tag}"
    payload = {
        "version": version,
        "channel": "stable",
        "releaseTag": release_tag,
        "releaseName": f"Wateray {release_tag}",
        "releasePageUrl": release_url,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "notesFile": f"release-notes-{release_tag}.md",
        "assets": [
            {
                "name": path.name,
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "downloadUrl": f"https://github.com/{repo}/releases/download/{release_tag}/{path.name}",
            }
            for path in archives
        ],
    }
    output = release_dir / "latest-github.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def write_release_notes(version: str, public_repo: str, release_dir: Path, archives: list[Path]) -> Path:
    release_tag = f"v{version}"
    lines = [
        f"# Wateray {release_tag}",
        "",
        "## 版本简介",
        "- 发布渠道：稳定版",
        "- 适用平台：Windows 客户端 + 广告前后端发布包",
        f"- GitHub 仓库：`{public_repo.strip() or DEFAULT_PUBLIC_REPO}`",
        "",
        "## 更新摘要",
        "- 新功能：待补充",
        "- 修复：待补充",
        "- 优化：待补充",
        "- 兼容性说明：待补充",
        "",
        "## 发布文件",
    ]
    for path in archives:
        lines.append(f"- `{path.name}` ({format_size(path.stat().st_size)})")
    lines.extend(
        [
            "- `SHA256SUMS.txt`：发布文件校验值。",
            "- `latest.json`：机器可读版本摘要。",
            "- `latest-github.json`：带 GitHub 下载地址的版本摘要。",
            "",
            "## 发布步骤建议",
            "1. 先上传上述 zip 包与校验文件到 GitHub Release。",
            "2. 再把本文件内容整理后粘贴到 Release 正文。",
            "3. 上传完成后，检查下载链接、文件大小和 SHA256 是否一致。",
            "",
            "## 发布后检查",
            "- 能否正常下载 Windows 客户端压缩包。",
            "- 广告服务端与广告前端压缩包结构是否完整。",
            "- `SHA256SUMS.txt` 是否与上传文件一致。",
            "- `latest-github.json` 中的下载地址是否与最终 Release Tag 一致。",
            "",
        ],
    )
    output = release_dir / f"release-notes-{release_tag}.md"
    output.write_text("\n".join(lines), encoding="utf-8")
    return output


def main() -> int:
    try:
        args = parse_args()
        version = read_version()
        release_dir, archives = build_assets(version)
        sha_path = write_sha256_sums(release_dir, archives)
        latest_path = write_latest_json(version, release_dir, archives)
        latest_github_path = write_latest_json_for_github(version, args.repo, release_dir, archives)
        notes_path = write_release_notes(version, args.repo, release_dir, archives)

        print(f"已生成 GitHub Release 素材目录：{release_dir}")
        for path in archives:
            print(f"- {path.name} ({format_size(path.stat().st_size)})")
        print(f"- {sha_path.name}")
        print(f"- {latest_path.name}")
        print(f"- {latest_github_path.name}")
        print(f"- {notes_path.name}")
        return 0
    except ReleasePrepareError as err:
        print(f"发布素材生成失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"发布素材生成失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
