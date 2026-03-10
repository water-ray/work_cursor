#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
VERSION_PATH = ROOT_DIR / "VERSION"
DEFAULT_PUBLIC_REPO = "water-ray/wateray-release"
DEFAULT_WORKFLOW_FILE = "desktop-release.yml"


class DispatchWorkflowError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="触发 GitHub Actions 汇总客户端 Release")
    parser.add_argument(
        "--public-repo",
        default=DEFAULT_PUBLIC_REPO,
        help="最终公开发布仓库 owner/name，例如 water-ray/wateray-release",
    )
    parser.add_argument(
        "--workflow",
        default=DEFAULT_WORKFLOW_FILE,
        help="要触发的 workflow 文件名，默认 desktop-release.yml",
    )
    parser.add_argument(
        "--workflow-repo",
        default="",
        help="承载 workflow 的仓库 owner/name，默认自动识别当前仓库",
    )
    parser.add_argument(
        "--ref",
        default="",
        help="触发 workflow 时使用的分支或 tag；默认使用 workflow 默认分支",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅打印将要触发的 workflow，不真正执行",
    )
    return parser.parse_args()


def read_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not version:
        raise DispatchWorkflowError("VERSION 为空，无法触发发布工作流")
    return version


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
        raise DispatchWorkflowError(detail)
    return result


def ensure_gh_ready() -> None:
    try:
        run_command(["gh", "--version"], check=True)
    except FileNotFoundError as err:
        raise DispatchWorkflowError("未安装 gh CLI，请先安装 GitHub CLI") from err
    run_command(["gh", "auth", "status"], check=True)


def resolve_workflow_repo(raw_value: str) -> str:
    if raw_value.strip():
        return raw_value.strip()
    result = run_command(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        capture_output=True,
        check=True,
    )
    repo = (result.stdout or "").strip()
    if not repo:
        raise DispatchWorkflowError("无法自动识别当前仓库，请手动传入 --workflow-repo")
    return repo


def main() -> int:
    try:
        args = parse_args()
        ensure_gh_ready()
        version = read_version()
        workflow_repo = resolve_workflow_repo(args.workflow_repo)
        command = [
            "gh",
            "workflow",
            "run",
            args.workflow,
            "--repo",
            workflow_repo,
            "-f",
            f"version={version}",
            "-f",
            f"public_repo={args.public_repo.strip() or DEFAULT_PUBLIC_REPO}",
        ]
        if args.ref.strip():
            command.extend(["--ref", args.ref.strip()])
        if args.dry_run:
            print("[dry-run] 将执行：")
            print(" ".join(command))
            return 0
        run_command(command, check=True)
        print(f"已触发 GitHub Actions：{workflow_repo} -> {args.workflow} (version={version})")
        return 0
    except DispatchWorkflowError as err:
        print(f"触发 GitHub 发布工作流失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"触发 GitHub 发布工作流失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
