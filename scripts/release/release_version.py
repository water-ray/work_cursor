#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
VERSION_FILE = ROOT_DIR / "VERSION"
TAURI_PACKAGE_JSON = ROOT_DIR / "TauriApp" / "package.json"
TAURI_PACKAGE_LOCK = ROOT_DIR / "TauriApp" / "package-lock.json"
CHANGELOG_LATEST_FILE = ROOT_DIR / "docs" / "build" / "CHANGELOG_LATEST.md"

SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")

FEATURE_PREFIXES = ("feat", "feature", "add", "新增", "新功能")
FIX_PREFIXES = ("fix", "bug", "修复")
REFACTOR_PREFIXES = ("refactor", "perf", "optimize", "优化", "重构")


@dataclass
class CommitRecord:
    sha: str
    subject: str


def read_semver(path: Path) -> str:
    if not path.exists():
        raise RuntimeError(f"缺少版本文件：{path}")
    value = path.read_text(encoding="utf-8").strip()
    if not SEMVER_PATTERN.match(value):
        raise RuntimeError(f"版本格式必须为 X.Y.Z，当前为：{value!r}")
    return value


def bump_semver(version: str, bump: str) -> str:
    major, minor, patch = [int(part) for part in version.split(".")]
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise RuntimeError(f"不支持的 bump 类型：{bump}")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def update_package_json(version: str) -> None:
    payload = json.loads(TAURI_PACKAGE_JSON.read_text(encoding="utf-8"))
    payload["version"] = version
    TAURI_PACKAGE_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def update_package_lock(version: str) -> None:
    if not TAURI_PACKAGE_LOCK.exists():
        return
    payload = json.loads(TAURI_PACKAGE_LOCK.read_text(encoding="utf-8"))
    payload["version"] = version
    packages = payload.get("packages")
    if isinstance(packages, dict):
        root_package = packages.get("")
        if isinstance(root_package, dict):
            root_package["version"] = version
    TAURI_PACKAGE_LOCK.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


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
        raise RuntimeError(f"git 命令失败：{' '.join(command)}\n{message}")
    return stdout


def resolve_previous_tag() -> str:
    return run_git(["describe", "--tags", "--abbrev=0"], allow_failure=True).strip()


def collect_commits(previous_tag: str) -> list[CommitRecord]:
    range_spec = f"{previous_tag}..HEAD" if previous_tag else "HEAD"
    output = run_git(["log", "--pretty=format:%h%x1f%s", range_spec], allow_failure=True)
    if output.strip() == "":
        return []
    records: list[CommitRecord] = []
    for line in output.splitlines():
        if "\x1f" not in line:
            continue
        sha, subject = line.split("\x1f", 1)
        sha = sha.strip()
        subject = subject.strip()
        if sha == "" or subject == "":
            continue
        records.append(CommitRecord(sha=sha, subject=subject))
    return records


def classify_commit(subject: str) -> str:
    text = subject.strip()
    lower = text.lower()

    match = re.match(r"^([a-zA-Z]+)(?:\([^)]+\))?!?:", lower)
    if match is not None:
        prefix = match.group(1)
    else:
        prefix = lower.split(":")[0].split(" ")[0]

    if any(prefix.startswith(item) for item in FEATURE_PREFIXES):
        return "Features"
    if any(prefix.startswith(item) for item in FIX_PREFIXES):
        return "Fixes"
    if any(prefix.startswith(item) for item in REFACTOR_PREFIXES):
        return "Refactors"
    return "Others"


def render_latest_changelog(
    *,
    version: str,
    bump: str,
    previous_tag: str,
    commits: list[CommitRecord],
) -> str:
    sections: dict[str, list[CommitRecord]] = {
        "Features": [],
        "Fixes": [],
        "Refactors": [],
        "Others": [],
    }
    for commit in commits:
        sections[classify_commit(commit.subject)].append(commit)

    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines: list[str] = [
        "# CHANGELOG_LATEST",
        "",
        f"## v{version}",
        f"- 生成时间：{generated_at}",
        f"- 版本升级：{bump}",
    ]
    if previous_tag:
        lines.append(f"- 基线标签：{previous_tag}")
    else:
        lines.append("- 基线标签：无（首次生成）")
    lines.append("")

    for section_name in ("Features", "Fixes", "Refactors", "Others"):
        lines.append(f"### {section_name}")
        records = sections[section_name]
        if len(records) == 0:
            lines.append("- 无")
        else:
            for record in records:
                lines.append(f"- {record.subject} ({record.sha})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bump VERSION + sync Tauri desktop version + generate latest changelog.",
    )
    parser.add_argument(
        "bump",
        choices=["major", "minor", "patch"],
        help="SemVer bump 类型",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅预览，不落盘",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    current_version = read_semver(VERSION_FILE)
    next_version = bump_semver(current_version, args.bump)
    previous_tag = resolve_previous_tag()
    commits = collect_commits(previous_tag)
    changelog = render_latest_changelog(
        version=next_version,
        bump=args.bump,
        previous_tag=previous_tag,
        commits=commits,
    )

    if args.dry_run:
        print(f"[dry-run] VERSION: {current_version} -> {next_version}")
        print("[dry-run] 将更新：")
        print(f"- {VERSION_FILE}")
        print(f"- {TAURI_PACKAGE_JSON}")
        if TAURI_PACKAGE_LOCK.exists():
            print(f"- {TAURI_PACKAGE_LOCK}")
        print(f"- {CHANGELOG_LATEST_FILE}")
        return 0

    write_text(VERSION_FILE, f"{next_version}\n")
    update_package_json(next_version)
    update_package_lock(next_version)
    write_text(CHANGELOG_LATEST_FILE, changelog)

    print(f"版本升级完成：{current_version} -> {next_version}")
    print(f"简约更新日志：{CHANGELOG_LATEST_FILE}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # pragma: no cover
        print(f"release_version 失败：{error}", file=sys.stderr)
        raise SystemExit(1)
