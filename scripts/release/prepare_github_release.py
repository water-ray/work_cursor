#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets.desktop import resolve_current_platform_id

VERSION_PATH = ROOT_DIR / "VERSION"
CHANGELOG_LATEST_PATH = ROOT_DIR / "docs" / "build" / "CHANGELOG_LATEST.md"
BIN_DIR = ROOT_DIR / "Bin"
RELEASE_ROOT_DIR = BIN_DIR / "github-release"
DEFAULT_PUBLIC_REPO = "water-ray/wateray-release"

PLATFORM_RELEASES = (
    ("windows", "Windows 客户端整包", "Wateray-windows"),
    ("linux", "Linux 客户端整包", "Wateray-linux"),
    ("macos", "macOS 客户端整包", "Wateray-macos"),
)


@dataclass
class ReleaseAsset:
    platform_id: str
    label: str
    source_dir: Path
    zip_name: str


class ReleasePrepareError(RuntimeError):
    pass


def run_git(args: list[str], allow_failure: bool = False) -> str:
    command = ["git", *args]
    completed = subprocess.run(
        command,
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    if completed.returncode != 0:
        if allow_failure:
            return ""
        message = stderr or stdout
        raise ReleasePrepareError(f"git 命令失败：{' '.join(command)}\n{message}")
    return stdout


def classify_commit(subject: str) -> str:
    text = subject.strip()
    lower = text.lower()
    if lower.startswith(("feat", "feature", "add", "新增", "新功能")):
        return "features"
    if lower.startswith(("fix", "bug", "修复")):
        return "fixes"
    if lower.startswith(("refactor", "perf", "optimize", "优化", "重构")):
        return "refactors"
    return "others"


def strip_commit_suffix(text: str) -> str:
    return re.sub(r"\s*\([0-9a-f]{7,40}\)\s*$", "", text.strip(), flags=re.IGNORECASE)


def strip_conventional_prefix(text: str) -> str:
    normalized = strip_commit_suffix(text)
    return re.sub(r"^[a-zA-Z]+(?:\([^)]+\))?!?:\s*", "", normalized).strip()


def normalize_release_line(text: str) -> str:
    normalized = strip_conventional_prefix(text)
    if not normalized:
        return ""
    lower = normalized.lower()
    replacements = [
        ("finalize adsroot migration and release workflow", "完成广告端迁移与发布流程收尾"),
        ("增加仅 windows 的 sb 库发布流程", "补充仅 Windows 平台的 sing-box 库发布流程"),
        ("修复 windows dll 构建时版本符号冲突", "修复 Windows DLL 构建时的版本符号冲突"),
        ("增加 sing-box 三端库自动构建流程", "补充 sing-box 多平台库自动构建流程"),
        ("完善开源协作与ci基础设施", "完善开源协作与 CI 基础设施"),
        ("完善开源协作与ci基础设施", "完善开源协作与 CI 基础设施"),
        ("初始化 wateray 项目骨架", "初始化 Wateray 项目骨架"),
    ]
    for source, target in replacements:
        if lower == source:
            return target
    if normalized.startswith(("备份当前", "备份")):
        return "整理并保留当前开发快照，便于后续重构与回滚"
    return normalized[:1].upper() + normalized[1:]


def parse_changelog_sections_for_version(version: str) -> dict[str, list[str]]:
    sections = {
        "features": [],
        "fixes": [],
        "refactors": [],
        "others": [],
    }
    if not CHANGELOG_LATEST_PATH.exists():
        return sections
    lines = CHANGELOG_LATEST_PATH.read_text(encoding="utf-8").splitlines()
    target_heading = f"## v{version}"
    in_target_version = False
    current_section = ""
    section_map = {
        "### Features": "features",
        "### Fixes": "fixes",
        "### Refactors": "refactors",
        "### Others": "others",
    }
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("## "):
            if line == target_heading:
                in_target_version = True
                current_section = ""
                continue
            if in_target_version:
                break
        if not in_target_version:
            continue
        mapped = section_map.get(line)
        if mapped:
            current_section = mapped
            continue
        if line.startswith("- ") and current_section:
            item = line[2:].strip()
            if item and item != "无":
                sections[current_section].append(item)
    return sections


def collect_recent_commit_sections(limit: int = 20) -> dict[str, list[str]]:
    sections = {
        "features": [],
        "fixes": [],
        "refactors": [],
        "others": [],
    }
    output = run_git(["log", f"-{limit}", "--pretty=format:%s"], allow_failure=True)
    if not output:
        return sections
    for subject in output.splitlines():
        normalized = subject.strip()
        if not normalized:
            continue
        sections[classify_commit(normalized)].append(normalized)
    return sections


def summarize_items(items: list[str], fallback: str, limit: int = 3) -> str:
    cleaned = []
    seen = set()
    for item in items:
        normalized = normalize_release_line(item)
        if normalized and normalized not in seen:
            seen.add(normalized)
            cleaned.append(normalized)
    if not cleaned:
        return fallback
    return "；".join(cleaned[:limit])


def build_compatibility_summary(archives: list[Path]) -> str:
    platforms = [path.name.removeprefix("Wateray-").split("-v", 1)[0] for path in archives]
    normalized = [item.lower() for item in platforms]
    if normalized == ["windows"]:
        return "当前公开发布包仅包含 Windows 客户端；Linux/macOS 构建入口已预留，暂未附带正式发布包。"
    return f"当前公开发布包包含：{', '.join(platforms)}。请按对应平台下载使用。"


def build_release_summary(version: str, archives: list[Path]) -> dict[str, str]:
    sections = parse_changelog_sections_for_version(version)
    if not any(sections.values()):
        sections = collect_recent_commit_sections()
    return {
        "features": summarize_items(sections["features"], "本次版本未记录独立新功能。"),
        "fixes": summarize_items(sections["fixes"], "本次版本未记录独立缺陷修复。"),
        "refactors": summarize_items(
            [*sections["refactors"], *sections["others"]],
            "本次版本以构建、发布或维护性调整为主。",
        ),
        "compatibility": build_compatibility_summary(archives),
    }


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
        help="公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--platform",
        choices=("all", "current", "windows", "linux", "macos"),
        default="all",
        help="要收集的平台：all / current / windows / linux / macos，默认 all",
    )
    parser.add_argument(
        "--source-archives-dir",
        default="",
        help="直接复用已有 zip 包的目录；传入后不会重新打包 Bin/Wateray-* 目录",
    )
    parser.add_argument(
        "--release-root-dir",
        default="",
        help="发布素材输出根目录，默认 Bin/github-release",
    )
    return parser.parse_args()


def resolve_requested_platforms(platform_arg: str) -> set[str]:
    if platform_arg == "all":
        return {platform_id for platform_id, _label, _dir_name in PLATFORM_RELEASES}
    if platform_arg == "current":
        return {resolve_current_platform_id()}
    return {platform_arg}


def resolve_release_root_dir(raw_value: str) -> Path:
    if not raw_value.strip():
        return RELEASE_ROOT_DIR
    candidate = Path(raw_value)
    if not candidate.is_absolute():
        candidate = ROOT_DIR / candidate
    return candidate


def resolve_source_archives_dir(raw_value: str) -> Path | None:
    if not raw_value.strip():
        return None
    candidate = Path(raw_value)
    if not candidate.is_absolute():
        candidate = ROOT_DIR / candidate
    return candidate


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


def build_assets_from_directories(
    version: str,
    release_root_dir: Path,
    requested_platforms: set[str],
) -> tuple[Path, list[Path]]:
    release_dir = release_root_dir / f"v{version}"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    release_dir.mkdir(parents=True, exist_ok=True)

    asset_defs: list[ReleaseAsset] = []
    for platform_id, label, dir_name in PLATFORM_RELEASES:
        if platform_id not in requested_platforms:
            continue
        source_dir = BIN_DIR / dir_name
        if not source_dir.exists():
            continue
        asset_defs.append(
            ReleaseAsset(
                platform_id=platform_id,
                label=label,
                source_dir=source_dir,
                zip_name=f"Wateray-{platform_id}-v{version}.zip",
            ),
        )
    if not asset_defs:
        supported_dirs = ", ".join(
            dir_name
            for platform_id, _label, dir_name in PLATFORM_RELEASES
            if platform_id in requested_platforms
        )
        raise ReleasePrepareError(f"未找到可发布客户端目录，请先构建：{supported_dirs}")

    archives: list[Path] = []
    for item in asset_defs:
        ensure_dir_exists(item.source_dir, item.label)
        archive = zip_directory(item.source_dir, release_dir / item.zip_name.removesuffix(".zip"))
        archives.append(archive)
    return release_dir, archives


def copy_assets_from_archives(
    version: str,
    release_root_dir: Path,
    source_archives_dir: Path,
    requested_platforms: set[str],
) -> tuple[Path, list[Path]]:
    ensure_dir_exists(source_archives_dir, "现成发布压缩包目录")
    release_dir = release_root_dir / f"v{version}"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    release_dir.mkdir(parents=True, exist_ok=True)

    archives: list[Path] = []
    for platform_id in sorted(requested_platforms):
        source_archive = source_archives_dir / f"Wateray-{platform_id}-v{version}.zip"
        if not source_archive.exists():
            continue
        target_archive = release_dir / source_archive.name
        shutil.copy2(source_archive, target_archive)
        archives.append(target_archive)
    if not archives:
        expected = ", ".join(f"Wateray-{platform_id}-v{version}.zip" for platform_id in sorted(requested_platforms))
        raise ReleasePrepareError(f"未找到可复用的发布压缩包：{expected}")
    return release_dir, archives


def build_assets(
    version: str,
    release_root_dir: Path,
    requested_platforms: set[str],
    source_archives_dir: Path | None = None,
) -> tuple[Path, list[Path]]:
    if source_archives_dir is not None:
        return copy_assets_from_archives(
            version=version,
            release_root_dir=release_root_dir,
            source_archives_dir=source_archives_dir,
            requested_platforms=requested_platforms,
        )
    return build_assets_from_directories(
        version=version,
        release_root_dir=release_root_dir,
        requested_platforms=requested_platforms,
    )


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
                "platform": path.name.removeprefix("Wateray-").split("-v", 1)[0],
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
                "platform": path.name.removeprefix("Wateray-").split("-v", 1)[0],
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
    summary = build_release_summary(version, archives)
    lines = [
        f"# Wateray {release_tag}",
        "",
        "## 版本简介",
        "- 发布渠道：稳定版",
        f"- 适用平台：{', '.join(path.name.removeprefix('Wateray-').split('-v', 1)[0] for path in archives)}",
        f"- GitHub 仓库：`{public_repo.strip() or DEFAULT_PUBLIC_REPO}`",
        "",
        "## 更新摘要",
        f"- 新功能：{summary['features']}",
        f"- 修复：{summary['fixes']}",
        f"- 优化：{summary['refactors']}",
        f"- 兼容性说明：{summary['compatibility']}",
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
        requested_platforms = resolve_requested_platforms(args.platform)
        release_root_dir = resolve_release_root_dir(args.release_root_dir)
        source_archives_dir = resolve_source_archives_dir(args.source_archives_dir)
        release_dir, archives = build_assets(
            version=version,
            release_root_dir=release_root_dir,
            requested_platforms=requested_platforms,
            source_archives_dir=source_archives_dir,
        )
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
