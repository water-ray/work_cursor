#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_REMOTE = "source-private"
DEFAULT_MAIN_BRANCH = "main"
COMMIT_MESSAGE_ENV = "WATERAY_GIT_COMMIT_MESSAGE"


class GitTaskError(RuntimeError):
    pass


def run_git(
    args: list[str],
    *,
    check: bool = True,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(ROOT_DIR),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=capture_output,
            check=False,
        )
    except FileNotFoundError as err:
        raise GitTaskError("未安装 git，无法执行仓库任务") from err
    if check and result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        detail = stderr or stdout or f"git {' '.join(args)} 失败（exit_code={result.returncode}）"
        raise GitTaskError(detail)
    return result


def print_stdout(text: str) -> None:
    if not text:
        return
    if text.endswith("\n"):
        print(text, end="")
        return
    print(text)


def resolve_commit_message(explicit_message: str) -> str:
    if explicit_message.strip():
        return explicit_message.strip()
    message = os.environ.get(COMMIT_MESSAGE_ENV, "").strip()
    if message:
        return message
    raise GitTaskError(f"缺少提交说明，请传入 --message 或设置环境变量 {COMMIT_MESSAGE_ENV}")


def ensure_non_empty(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise GitTaskError(f"{field_name} 不能为空")
    return normalized


def has_staged_changes() -> bool:
    result = run_git(["diff", "--cached", "--quiet"], check=False)
    if result.returncode == 0:
        return False
    if result.returncode == 1:
        return True
    raise GitTaskError(f"git diff --cached --quiet 失败（exit_code={result.returncode}）")


def print_short_status() -> None:
    result = run_git(["status", "--short", "--branch"], capture_output=True)
    print_stdout(result.stdout)


def list_remote_names() -> list[str]:
    result = run_git(["remote"], capture_output=True)
    return [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]


def get_remote_url(remote: str, *, push: bool = False) -> str:
    command = ["remote", "get-url"]
    if push:
        command.append("--push")
    command.append(remote)
    result = run_git(command, check=False, capture_output=True)
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


def print_remote_verbose() -> None:
    result = run_git(["remote", "-v"], capture_output=True)
    print("git remote -v:")
    output = (result.stdout or "").strip()
    if output:
        print_stdout(output)
    else:
        print("(未配置任何 remote)")


def print_missing_remote_hint(remote: str) -> None:
    remote_names = set(list_remote_names())
    if remote in remote_names:
        return
    print()
    print(f"提示：当前仓库未配置 {remote}。")
    print(f"{remote} 是这个任务约定使用的 Git 远端名称（remote name / 远程别名）。")
    origin_url = get_remote_url("origin", push=True) or get_remote_url("origin")
    if origin_url:
        print("如果你希望它先和 origin 指向同一个仓库，可以手动执行：")
        print(f"git remote add {remote} {origin_url}")
    else:
        print("当前未检测到可复用的 origin 地址，请改成你的仓库地址后手动执行：")
        print(f"git remote add {remote} <你的私有仓库URL>")
    print("如果后续需要改地址，可执行：")
    print(f"git remote set-url {remote} <新的仓库URL>")


def stage_and_commit(message: str) -> bool:
    run_git(["add", "-A"])
    if not has_staged_changes():
        print("没有可提交的改动")
        return False
    run_git(["commit", "-m", message])
    return True


def push(remote: str, refspec: str, *, set_upstream: bool) -> None:
    command = ["push"]
    if set_upstream:
        command.append("-u")
    command.extend([remote, refspec])
    run_git(command)


def branch_exists(branch: str) -> bool:
    result = run_git(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], check=False)
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise GitTaskError(f"检查本地分支失败：{branch}")


def show_identity() -> None:
    queries = [
        ("local user.name", ["config", "--local", "--get", "user.name"]),
        ("local user.email", ["config", "--local", "--get", "user.email"]),
        ("author", ["var", "GIT_AUTHOR_IDENT"]),
        ("committer", ["var", "GIT_COMMITTER_IDENT"]),
    ]
    for label, args in queries:
        result = run_git(args, check=False, capture_output=True)
        value = (result.stdout or "").strip()
        print(f"{label}: {value or '(未设置)'}")


def command_commit(args: argparse.Namespace) -> int:
    message = resolve_commit_message(args.message)
    if stage_and_commit(message):
        print_short_status()
    return 0


def command_push_current(args: argparse.Namespace) -> int:
    push(ensure_non_empty(args.remote, "remote"), "HEAD", set_upstream=False)
    return 0


def command_switch_branch(args: argparse.Namespace) -> int:
    branch = ensure_non_empty(args.branch, "目标分支")
    if branch_exists(branch):
        run_git(["switch", branch])
    else:
        run_git(["switch", "-c", branch])
    current = run_git(["branch", "--show-current"], capture_output=True)
    print_stdout(current.stdout)
    return 0


def command_show_branch(args: argparse.Namespace) -> int:
    print_short_status()
    print()
    print_remote_verbose()
    print_missing_remote_hint(ensure_non_empty(args.remote, "remote"))
    return 0


def command_push_main(args: argparse.Namespace) -> int:
    remote = ensure_non_empty(args.remote, "remote")
    branch = ensure_non_empty(args.branch, "目标远端分支")
    push(remote, f"HEAD:{branch}", set_upstream=False)
    return 0


def command_commit_push_current(args: argparse.Namespace) -> int:
    message = resolve_commit_message(args.message)
    if not stage_and_commit(message):
        return 0
    push(ensure_non_empty(args.remote, "remote"), "HEAD", set_upstream=False)
    print_short_status()
    return 0


def command_commit_push_main(args: argparse.Namespace) -> int:
    message = resolve_commit_message(args.message)
    if not stage_and_commit(message):
        return 0
    remote = ensure_non_empty(args.remote, "remote")
    branch = ensure_non_empty(args.branch, "目标远端分支")
    push(remote, f"HEAD:{branch}", set_upstream=False)
    print_short_status()
    return 0


def command_show_identity(_args: argparse.Namespace) -> int:
    show_identity()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="跨平台执行私有源码 Git 任务")
    subparsers = parser.add_subparsers(dest="command", required=True)

    commit = subparsers.add_parser("commit", help="提交当前改动")
    commit.add_argument("--message", default="", help=f"提交说明；为空时读取 {COMMIT_MESSAGE_ENV}")
    commit.set_defaults(handler=command_commit)

    push_current = subparsers.add_parser("push-current", help="推送当前分支")
    push_current.add_argument("--remote", default=DEFAULT_REMOTE, help=f"远端名称，默认 {DEFAULT_REMOTE}")
    push_current.set_defaults(handler=command_push_current)

    switch_branch = subparsers.add_parser("switch-branch", help="切换或创建本地分支")
    switch_branch.add_argument("--branch", required=True, help="目标分支名")
    switch_branch.set_defaults(handler=command_switch_branch)

    show_branch_parser = subparsers.add_parser("show-branch", help="查看当前分支")
    show_branch_parser.add_argument("--remote", default=DEFAULT_REMOTE, help=f"提示检查的远端名称，默认 {DEFAULT_REMOTE}")
    show_branch_parser.set_defaults(handler=command_show_branch)

    push_main = subparsers.add_parser("push-main", help="推送当前内容到主分支")
    push_main.add_argument("--remote", default=DEFAULT_REMOTE, help=f"远端名称，默认 {DEFAULT_REMOTE}")
    push_main.add_argument("--branch", default=DEFAULT_MAIN_BRANCH, help=f"远端主分支，默认 {DEFAULT_MAIN_BRANCH}")
    push_main.set_defaults(handler=command_push_main)

    commit_push_current = subparsers.add_parser("commit-push-current", help="提交并推送当前分支")
    commit_push_current.add_argument("--message", default="", help=f"提交说明；为空时读取 {COMMIT_MESSAGE_ENV}")
    commit_push_current.add_argument("--remote", default=DEFAULT_REMOTE, help=f"远端名称，默认 {DEFAULT_REMOTE}")
    commit_push_current.set_defaults(handler=command_commit_push_current)

    commit_push_main = subparsers.add_parser("commit-push-main", help="提交并推送到主分支")
    commit_push_main.add_argument("--message", default="", help=f"提交说明；为空时读取 {COMMIT_MESSAGE_ENV}")
    commit_push_main.add_argument("--remote", default=DEFAULT_REMOTE, help=f"远端名称，默认 {DEFAULT_REMOTE}")
    commit_push_main.add_argument("--branch", default=DEFAULT_MAIN_BRANCH, help=f"远端主分支，默认 {DEFAULT_MAIN_BRANCH}")
    commit_push_main.set_defaults(handler=command_commit_push_main)

    show_identity_parser = subparsers.add_parser("show-identity", help="显示当前提交身份")
    show_identity_parser.set_defaults(handler=command_show_identity)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.handler(args))
    except GitTaskError as err:
        print(f"Git 任务失败：{err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"Git 任务失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
