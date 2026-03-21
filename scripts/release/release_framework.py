#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from scripts.build.platforms.macos import DMG_FILE_NAME as MACOS_DMG_FILE_NAME
from scripts.build.targets.linux_package import linux_bundle_is_current, linux_packages_are_current


ROOT_DIR = Path(__file__).resolve().parents[2]
VERSION_PATH = ROOT_DIR / "VERSION"
CHANGELOG_LATEST_PATH = ROOT_DIR / "docs" / "build" / "CHANGELOG_LATEST.md"
BIN_DIR = ROOT_DIR / "Bin"
RELEASE_ROOT_DIR = BIN_DIR / "github-release"
DEFAULT_PUBLIC_REPO = "water-ray/wateray-release"
OFFICIAL_SITE_URL = "https://wateray.net/"
PLATFORM_ORDER = ("windows", "linux", "macos", "android")
PLATFORM_DISPLAY_NAMES = {
    "windows": "Windows",
    "linux": "Linux",
    "macos": "macOS",
    "android": "Android",
}
PLATFORM_DELIVERY_NAMES = {
    "windows": "ZIP 整包",
    "linux": "ZIP / DEB / AppImage",
    "macos": "DMG 安装镜像",
    "android": "APK",
}
PLATFORM_DIRECTORY_NAMES = {
    "windows": "Wateray-windows",
    "linux": "Wateray-linux",
    "macos": "Wateray-macos",
    "android": "Wateray-Android",
}
LINUX_PACKAGE_OUTPUT_DIR = BIN_DIR / "Wateray-linux-packages"
ASSET_KIND_ORDER = {
    "portable-zip": 0,
    "deb": 1,
    "appimage": 2,
    "dmg": 3,
    "apk": 4,
}


@dataclass(frozen=True)
class ExpectedReleaseAsset:
    platform_id: str
    label: str
    asset_name: str
    kind: str
    primary: bool = False
    required: bool = True


@dataclass(frozen=True)
class ReleaseAsset:
    platform_id: str
    label: str
    path: Path
    kind: str
    primary: bool = False

    @property
    def asset_name(self) -> str:
        return self.path.name


class ReleaseFrameworkError(RuntimeError):
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
        raise ReleaseFrameworkError(stderr or stdout or f"git 命令失败：{' '.join(command)}")
    return stdout


def run_command(command: list[str], cwd: Path) -> None:
    result = subprocess.run(command, cwd=str(cwd), check=False)
    if result.returncode != 0:
        raise ReleaseFrameworkError(f"命令执行失败：{' '.join(command)}")


def read_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not version:
        raise ReleaseFrameworkError("VERSION 为空，无法生成发布素材")
    return version


def resolve_requested_platforms(platform_arg: str) -> set[str]:
    from scripts.build.targets.desktop import resolve_current_platform_id

    if platform_arg == "all":
        return set(PLATFORM_ORDER)
    if platform_arg == "current":
        current_platform = resolve_current_platform_id()
        if current_platform not in PLATFORM_ORDER:
            raise ReleaseFrameworkError(
                f"当前公开发布流程暂不包含 {current_platform} 平台；当前只支持：{', '.join(PLATFORM_ORDER)}"
            )
        return {current_platform}
    if platform_arg not in PLATFORM_ORDER:
        raise ReleaseFrameworkError(f"当前公开发布流程暂不包含 {platform_arg} 平台")
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
        raise ReleaseFrameworkError(f"{label} 不存在：{path}")


def validate_requested_platforms(requested_platforms: set[str]) -> None:
    unsupported = sorted(platform for platform in requested_platforms if platform not in PLATFORM_ORDER)
    if unsupported:
        raise ReleaseFrameworkError(
            f"当前公开发布流程暂不包含这些平台：{', '.join(unsupported)}；当前只支持：{', '.join(PLATFORM_ORDER)}"
        )


def reset_release_dir(release_root_dir: Path, version: str) -> Path:
    release_dir = release_root_dir / f"v{version}"
    if release_dir.exists():
        shutil.rmtree(release_dir)
    release_dir.mkdir(parents=True, exist_ok=True)
    return release_dir


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


def platform_sort_key(platform_id: str) -> tuple[int, str]:
    try:
        return (PLATFORM_ORDER.index(platform_id), platform_id)
    except ValueError:
        return (len(PLATFORM_ORDER), platform_id)


def asset_sort_key(asset: ReleaseAsset) -> tuple[int, int, str]:
    return (
        platform_sort_key(asset.platform_id)[0],
        ASSET_KIND_ORDER.get(asset.kind, 99),
        asset.asset_name,
    )


def sort_release_assets(assets: list[ReleaseAsset]) -> list[ReleaseAsset]:
    return sorted(assets, key=asset_sort_key)


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


def collect_recent_commit_sections(limit: int = 50) -> dict[str, list[str]]:
    sections = {
        "features": [],
        "fixes": [],
        "refactors": [],
        "others": [],
    }
    output = run_git(["log", "--no-merges", f"-{limit}", "--pretty=format:%s"], allow_failure=True)
    if not output:
        return sections
    for subject in output.splitlines():
        normalized = subject.strip()
        if not normalized:
            continue
        sections[classify_commit(normalized)].append(normalized)
    return sections


def summarize_items(items: list[str], fallback: str, limit: int = 3) -> str:
    cleaned: list[str] = []
    seen = set()
    for item in items:
        normalized = normalize_release_line(item)
        if normalized and normalized not in seen:
            seen.add(normalized)
            cleaned.append(normalized)
    if not cleaned:
        return fallback
    return "；".join(cleaned[:limit])


def distinct_platforms(assets: list[ReleaseAsset]) -> list[str]:
    seen = set()
    ordered: list[str] = []
    for asset in sort_release_assets(assets):
        if asset.platform_id in seen:
            continue
        seen.add(asset.platform_id)
        ordered.append(asset.platform_id)
    return ordered


def format_platform_delivery_label(platform_id: str) -> str:
    display_name = PLATFORM_DISPLAY_NAMES.get(platform_id, platform_id)
    delivery_name = PLATFORM_DELIVERY_NAMES.get(platform_id, "")
    if delivery_name:
        return f"{display_name}（{delivery_name}）"
    return display_name


def format_platform_delivery_labels(platform_ids: list[str]) -> list[str]:
    return [format_platform_delivery_label(platform_id) for platform_id in platform_ids]


def build_compatibility_summary(assets: list[ReleaseAsset]) -> str:
    platform_labels = format_platform_delivery_labels(distinct_platforms(assets))
    if len(platform_labels) == 1:
        return f"当前公开发布包仅包含：{platform_labels[0]}。"
    return f"当前公开发布包包含：{', '.join(platform_labels)}。请按对应平台下载使用。"


def build_release_summary(version: str, assets: list[ReleaseAsset]) -> dict[str, str]:
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
        "compatibility": build_compatibility_summary(assets),
    }


def resolve_expected_release_assets(version: str, platform_id: str) -> tuple[ExpectedReleaseAsset, ...]:
    if platform_id == "windows":
        return (
            ExpectedReleaseAsset("windows", "Windows ZIP 便携整包", f"Wateray-windows-v{version}.zip", "portable-zip", True),
        )
    if platform_id == "linux":
        return (
            ExpectedReleaseAsset("linux", "Linux ZIP 便携整包", f"Wateray-linux-v{version}.zip", "portable-zip", True),
            ExpectedReleaseAsset("linux", "Linux Debian/Ubuntu 安装包", f"wateray_{version}_amd64.deb", "deb"),
            ExpectedReleaseAsset("linux", "Linux AppImage 便携包", f"Wateray-linux-v{version}-x86_64.AppImage", "appimage"),
        )
    if platform_id == "android":
        return (
            ExpectedReleaseAsset("android", "Android arm64 APK 安装包", f"Wateray-Android-v{version}-arm64-release.apk", "apk", True),
            ExpectedReleaseAsset("android", "Android x86_64 APK 安装包", f"Wateray-Android-v{version}-x86_64-release.apk", "apk"),
        )
    if platform_id == "macos":
        return (
            ExpectedReleaseAsset("macos", "macOS 客户端 DMG 安装镜像", f"Wateray-macos-v{version}.dmg", "dmg", True),
        )
    raise ReleaseFrameworkError(f"不支持的平台：{platform_id}")


def resolve_local_asset_source(expected: ExpectedReleaseAsset) -> tuple[str, Path]:
    if expected.kind == "portable-zip":
        return ("directory", BIN_DIR / PLATFORM_DIRECTORY_NAMES[expected.platform_id])
    if expected.platform_id == "linux":
        return ("file", LINUX_PACKAGE_OUTPUT_DIR / expected.asset_name)
    if expected.platform_id == "macos":
        return ("file", BIN_DIR / PLATFORM_DIRECTORY_NAMES["macos"] / MACOS_DMG_FILE_NAME)
    if expected.platform_id == "android":
        return ("file", BIN_DIR / PLATFORM_DIRECTORY_NAMES["android"] / expected.asset_name)
    raise ReleaseFrameworkError(f"无法解析本地发布资产来源：{expected.asset_name}")


def ensure_linux_installers_ready(version: str) -> None:
    if sys.platform != "linux":
        raise ReleaseFrameworkError(
            "Linux 安装包缺失，请先在 Linux 宿主机执行 "
            "`python scripts/build/targets/linux_package.py --format all`"
        )
    if linux_packages_are_current(version):
        return
    skip_build = linux_bundle_is_current(BIN_DIR / PLATFORM_DIRECTORY_NAMES["linux"], version)
    command = [sys.executable, str(ROOT_DIR / "scripts" / "build" / "targets" / "linux_package.py"), "--format", "all"]
    if skip_build:
        command.append("--skip-build")
    run_command(
        command,
        cwd=ROOT_DIR,
    )
    if not linux_packages_are_current(version):
        raise ReleaseFrameworkError("Linux 安装包生成失败或与当前 VERSION/源码不一致")


def zip_directory(source_dir: Path, destination_without_suffix: Path) -> Path:
    archive_base = str(destination_without_suffix)
    return Path(shutil.make_archive(archive_base, "zip", root_dir=str(source_dir.parent), base_dir=source_dir.name))


def build_assets_from_directories(version: str, release_root_dir: Path, requested_platforms: set[str]) -> tuple[Path, list[ReleaseAsset]]:
    validate_requested_platforms(requested_platforms)
    release_dir = reset_release_dir(release_root_dir, version)
    assets: list[ReleaseAsset] = []
    for platform_id in PLATFORM_ORDER:
        if platform_id not in requested_platforms:
            continue
        expected_assets = resolve_expected_release_assets(version, platform_id)
        if platform_id == "linux":
            ensure_linux_installers_ready(version)
        for expected in expected_assets:
            source_type, source_path = resolve_local_asset_source(expected)
            if source_type == "directory":
                ensure_dir_exists(source_path, expected.label)
                target_path = zip_directory(source_path, release_dir / expected.asset_name.removesuffix(".zip"))
            else:
                if not source_path.exists():
                    raise ReleaseFrameworkError(f"未找到发布资产：{source_path}")
                target_path = release_dir / expected.asset_name
                shutil.copy2(source_path, target_path)
            assets.append(
                ReleaseAsset(
                    platform_id=expected.platform_id,
                    label=expected.label,
                    path=target_path,
                    kind=expected.kind,
                    primary=expected.primary,
                )
            )
    if not assets:
        requested = ", ".join(sorted(requested_platforms))
        raise ReleaseFrameworkError(f"未找到可发布客户端目录，请先构建：{requested}")
    return release_dir, sort_release_assets(assets)


def resolve_release_assets_in_dir(version: str, release_dir: Path, requested_platforms: set[str]) -> list[ReleaseAsset]:
    validate_requested_platforms(requested_platforms)
    assets: list[ReleaseAsset] = []
    missing: list[str] = []
    for platform_id in PLATFORM_ORDER:
        if platform_id not in requested_platforms:
            continue
        for expected in resolve_expected_release_assets(version, platform_id):
            asset_path = release_dir / expected.asset_name
            if asset_path.exists():
                assets.append(
                    ReleaseAsset(
                        platform_id=expected.platform_id,
                        label=expected.label,
                        path=asset_path,
                        kind=expected.kind,
                        primary=expected.primary,
                    )
                )
                continue
            if expected.required:
                missing.append(str(asset_path))
    if missing:
        raise ReleaseFrameworkError(f"发布素材不完整：{', '.join(missing)}")
    return sort_release_assets(assets)


def copy_release_assets_to_dir(release_root_dir: Path, version: str, assets: list[ReleaseAsset]) -> tuple[Path, list[ReleaseAsset]]:
    release_dir = reset_release_dir(release_root_dir, version)
    copied: list[ReleaseAsset] = []
    for asset in sort_release_assets(assets):
        target_path = release_dir / asset.asset_name
        shutil.copy2(asset.path, target_path)
        copied.append(
            ReleaseAsset(
                platform_id=asset.platform_id,
                label=asset.label,
                path=target_path,
                kind=asset.kind,
                primary=asset.primary,
            )
        )
    return release_dir, copied


def build_assets(
    version: str,
    release_root_dir: Path,
    requested_platforms: set[str],
    source_archives_dir: Path | None = None,
) -> tuple[Path, list[ReleaseAsset]]:
    if source_archives_dir is None:
        return build_assets_from_directories(version, release_root_dir, requested_platforms)
    ensure_dir_exists(source_archives_dir, "现成发布资产目录")
    source_assets = resolve_release_assets_in_dir(version, source_archives_dir, requested_platforms)
    return copy_release_assets_to_dir(release_root_dir, version, source_assets)


def build_asset_payload(asset: ReleaseAsset) -> dict[str, object]:
    return {
        "name": asset.asset_name,
        "label": asset.label,
        "platform": asset.platform_id,
        "kind": asset.kind,
        "primary": asset.primary,
        "sizeBytes": asset.path.stat().st_size,
        "sha256": sha256_file(asset.path),
    }


def write_sha256_sums(release_dir: Path, assets: list[ReleaseAsset]) -> Path:
    lines = [f"{sha256_file(asset.path)}  {asset.asset_name}" for asset in sort_release_assets(assets)]
    output = release_dir / "SHA256SUMS.txt"
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output


def write_latest_json(version: str, release_dir: Path, assets: list[ReleaseAsset]) -> Path:
    release_tag = f"v{version}"
    payload = {
        "version": version,
        "channel": "stable",
        "releaseTag": release_tag,
        "releaseName": f"Wateray {release_tag}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "assets": [build_asset_payload(asset) for asset in sort_release_assets(assets)],
    }
    output = release_dir / "latest.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def build_release_asset_download_url(public_repo: str, release_tag: str, asset_name: str) -> str:
    repo = public_repo.strip() or DEFAULT_PUBLIC_REPO
    return f"https://github.com/{repo}/releases/download/{release_tag}/{asset_name}"


def write_latest_json_for_github(version: str, public_repo: str, release_dir: Path, assets: list[ReleaseAsset]) -> Path:
    release_tag = f"v{version}"
    repo = public_repo.strip() or DEFAULT_PUBLIC_REPO
    payload = {
        "version": version,
        "channel": "stable",
        "releaseTag": release_tag,
        "releaseName": f"Wateray {release_tag}",
        "releasePageUrl": f"https://github.com/{repo}/releases/tag/{release_tag}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "notesFile": f"release-notes-{release_tag}.md",
        "assets": [
            {
                **build_asset_payload(asset),
                "downloadUrl": build_release_asset_download_url(repo, release_tag, asset.asset_name),
            }
            for asset in sort_release_assets(assets)
        ],
    }
    output = release_dir / "latest-github.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


def write_release_notes(version: str, public_repo: str, release_dir: Path, assets: list[ReleaseAsset]) -> Path:
    release_tag = f"v{version}"
    ordered_assets = sort_release_assets(assets)
    summary = build_release_summary(version, ordered_assets)
    platform_labels = format_platform_delivery_labels(distinct_platforms(ordered_assets))
    lines = [
        f"# Wateray {release_tag}",
        "",
        "## 版本简介",
        "- 发布渠道：稳定版",
        f"- 适用平台：{', '.join(platform_labels) if platform_labels else '暂无公开发布平台'}",
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
    for platform_id in distinct_platforms(ordered_assets):
        lines.append(f"### {format_platform_delivery_label(platform_id)}")
        for asset in ordered_assets:
            if asset.platform_id != platform_id:
                continue
            lines.append(f"- `{asset.asset_name}`：{asset.label}（{format_size(asset.path.stat().st_size)}）")
        lines.append("")
    lines.extend(
        [
            "- `SHA256SUMS.txt`：发布文件校验值。",
            "- `latest.json`：机器可读版本摘要。",
            "- `latest-github.json`：带 GitHub 下载地址的版本摘要。",
            "",
        ]
    )
    output = release_dir / f"release-notes-{release_tag}.md"
    output.write_text("\n".join(lines), encoding="utf-8")
    return output


def build_public_release_readme(version: str, public_repo: str, assets: list[ReleaseAsset]) -> str:
    release_tag = f"v{version}"
    repo = public_repo.strip() or DEFAULT_PUBLIC_REPO
    ordered_assets = sort_release_assets(assets)
    summary = build_release_summary(version, ordered_assets)
    platform_ids = distinct_platforms(ordered_assets)
    platform_labels = format_platform_delivery_labels(platform_ids)
    lines = [
        "# Wateray Release",
        "",
        f"官网：[{OFFICIAL_SITE_URL}]({OFFICIAL_SITE_URL})",
        "",
        "Wateray 的公开发布仓库，用于分发客户端安装包、版本说明与升级索引文件。",
        "此 README 由发布流程自动更新。",
        "",
        "## 当前稳定版本",
        "",
        f"- 版本：`{version}`",
        "- 发布渠道：稳定版",
        f"- 当前平台：{', '.join(platform_labels) if platform_labels else '暂无公开发布平台'}",
        f"- Release 页面：[Wateray {release_tag}](https://github.com/{repo}/releases/tag/{release_tag})",
        f"- 全部版本：[查看 Releases](https://github.com/{repo}/releases)",
        "",
        "## 更新摘要",
        f"- 新功能：{summary['features']}",
        f"- 修复：{summary['fixes']}",
        f"- 优化：{summary['refactors']}",
        f"- 兼容性说明：{summary['compatibility']}",
        "",
        "## 下载文件",
        "",
    ]
    for platform_id in platform_ids:
        lines.append(f"### {format_platform_delivery_label(platform_id)}")
        lines.append("")
        for asset in ordered_assets:
            if asset.platform_id != platform_id:
                continue
            asset_url = build_release_asset_download_url(repo, release_tag, asset.asset_name)
            recommendation = "，推荐下载" if asset.primary else ""
            lines.append(
                f"- [{asset.asset_name}]({asset_url})：{asset.label}（{format_size(asset.path.stat().st_size)}{recommendation}）"
            )
        lines.append("")
    lines.extend(
        [
            "## 附加文件",
            "",
            f"- [SHA256SUMS.txt]({build_release_asset_download_url(repo, release_tag, 'SHA256SUMS.txt')})：发布文件校验值。",
            f"- [latest.json]({build_release_asset_download_url(repo, release_tag, 'latest.json')})：机器可读版本摘要。",
            f"- [latest-github.json]({build_release_asset_download_url(repo, release_tag, 'latest-github.json')})：带 GitHub 下载地址的版本摘要。",
            f"- [本次版本说明](https://github.com/{repo}/releases/tag/{release_tag})：查看完整 Release Notes。",
            "",
            "## 说明",
            "",
            "- 该仓库默认只保留公开发布所需文件，不包含源码开发文档。",
            "- 当前公开发布平台以本 README 与对应 Release 附件为准。",
            "",
        ]
    )
    return "\n".join(lines)


def write_platform_build_manifest(
    version: str,
    repo: str,
    release_dir: Path,
    platform_id: str,
    assets: list[ReleaseAsset],
) -> Path:
    manifest_path = release_dir / f"platform-build-{platform_id}-v{version}.json"
    payload = {
        "version": version,
        "platform": platform_id,
        "publicRepo": repo,
        "sourceCommit": run_git(["rev-parse", "HEAD"]),
        "sourceBranch": run_git(["rev-parse", "--abbrev-ref", "HEAD"], allow_failure=True) or "unknown",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "assets": [build_asset_payload(asset) for asset in sort_release_assets(assets)],
    }
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def load_platform_build_manifest(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ReleaseFrameworkError(f"平台清单解析失败：{path}") from err
    return payload


def manifest_to_release_assets(manifest: dict[str, object], asset_dir: Path) -> list[ReleaseAsset]:
    platform_id = str(manifest.get("platform", "")).strip()
    assets_payload = manifest.get("assets", [])
    if not isinstance(assets_payload, list):
        raise ReleaseFrameworkError("平台清单 assets 字段非法")
    assets: list[ReleaseAsset] = []
    for item in assets_payload:
        if not isinstance(item, dict):
            raise ReleaseFrameworkError("平台清单资产条目非法")
        asset_name = str(item.get("name", "")).strip()
        label = str(item.get("label", "")).strip()
        kind = str(item.get("kind", "")).strip()
        primary = bool(item.get("primary", False))
        if not asset_name or not label or not kind:
            raise ReleaseFrameworkError("平台清单缺少必要资产字段")
        asset_path = asset_dir / asset_name
        if not asset_path.exists():
            raise ReleaseFrameworkError(f"staging 目录缺少资产：{asset_path}")
        assets.append(
            ReleaseAsset(
                platform_id=platform_id,
                label=label,
                path=asset_path,
                kind=kind,
                primary=primary,
            )
        )
    return sort_release_assets(assets)


def load_release_assets_from_latest_json(latest_json_path: Path) -> list[str]:
    try:
        payload = json.loads(latest_json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ReleaseFrameworkError(f"latest.json 解析失败：{latest_json_path}") from err
    assets_payload = payload.get("assets", [])
    if not isinstance(assets_payload, list):
        raise ReleaseFrameworkError("latest.json 缺少 assets 列表")
    names: list[str] = []
    for item in assets_payload:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if name:
            names.append(name)
    return names


def load_release_asset_records_from_latest_json(latest_json_path: Path) -> list[ReleaseAsset]:
    try:
        payload = json.loads(latest_json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ReleaseFrameworkError(f"latest.json 解析失败：{latest_json_path}") from err
    assets_payload = payload.get("assets", [])
    if not isinstance(assets_payload, list):
        raise ReleaseFrameworkError("latest.json 缺少 assets 列表")
    release_dir = latest_json_path.parent
    assets: list[ReleaseAsset] = []
    for item in assets_payload:
        if not isinstance(item, dict):
            raise ReleaseFrameworkError("latest.json 资产条目非法")
        asset_name = str(item.get("name", "")).strip()
        label = str(item.get("label", "")).strip()
        platform_id = str(item.get("platform", "")).strip()
        kind = str(item.get("kind", "")).strip()
        primary = bool(item.get("primary", False))
        if not asset_name or not label or not platform_id or not kind:
            raise ReleaseFrameworkError("latest.json 缺少必要资产字段")
        asset_path = release_dir / asset_name
        if not asset_path.exists():
            raise ReleaseFrameworkError(f"发布素材不完整：{asset_path}")
        assets.append(
            ReleaseAsset(
                platform_id=platform_id,
                label=label,
                path=asset_path,
                kind=kind,
                primary=primary,
            )
        )
    return sort_release_assets(assets)
