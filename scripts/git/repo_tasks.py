from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


USER_HOME = Path(os.environ.get("USERPROFILE", str(Path.home())))
WINDOWS_GIT_CANDIDATES = [
    r"C:\Program Files\Git\cmd\git.exe",
    r"C:\Program Files\Git\bin\git.exe",
    r"C:\Program Files (x86)\Git\cmd\git.exe",
    r"C:\Program Files (x86)\Git\bin\git.exe",
    str(USER_HOME / "AppData" / "Local" / "Programs" / "Git" / "cmd" / "git.exe"),
    str(USER_HOME / "scoop" / "apps" / "git" / "current" / "cmd" / "git.exe"),
]


class TaskError(RuntimeError):
    pass


@dataclass
class RepoContext:
    git_exe: str
    root: Path
    cache_path: Path


def configure_stdio() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def detect_git_executable() -> str:
    candidates: list[str] = []

    env_git = os.environ.get("GIT_EXE", "").strip()
    if env_git:
        candidates.append(env_git)

    which_git = shutil.which("git")
    if which_git:
        candidates.append(which_git)

    if os.name == "nt":
        candidates.extend(WINDOWS_GIT_CANDIDATES)

    seen: set[str] = set()
    for candidate in candidates:
        normalized = str(Path(candidate))
        if normalized in seen:
            continue
        seen.add(normalized)
        if Path(candidate).exists():
            return candidate

    raise TaskError(
        "未找到 Git 可执行文件。\n"
        "请安装 Git，或设置环境变量 GIT_EXE 指向 git 可执行文件。"
    )


def run_process(
    command: list[str],
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    if check and result.returncode != 0:
        raise TaskError(format_process_error(command, result))

    return result


def format_process_error(
    command: list[str], result: subprocess.CompletedProcess[str]
) -> str:
    parts = [
        f"命令执行失败（退出码 {result.returncode}）:",
        " ".join(command),
    ]

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()

    if stdout:
        parts.extend(["", "[stdout]", stdout])
    if stderr:
        parts.extend(["", "[stderr]", stderr])

    return "\n".join(parts)


def build_repo_context() -> RepoContext:
    git_exe = detect_git_executable()
    root_result = run_process(
        [git_exe, "rev-parse", "--show-toplevel"],
        cwd=Path.cwd(),
        check=False,
    )
    if root_result.returncode != 0:
        raise TaskError("当前目录不是 Git 仓库，无法执行仓库任务。")

    root = Path(root_result.stdout.strip()).resolve()
    cache_path = root / "temp" / "git_task_cache.json"
    return RepoContext(git_exe=git_exe, root=root, cache_path=cache_path)


def git(ctx: RepoContext, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run_process([ctx.git_exe, *args], cwd=ctx.root, check=check)


def git_stdout(ctx: RepoContext, *args: str, check: bool = True) -> str:
    return git(ctx, *args, check=check).stdout.strip()


def load_cache(ctx: RepoContext) -> dict[str, Any]:
    if not ctx.cache_path.exists():
        return {}

    try:
        return json.loads(ctx.cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_cache(ctx: RepoContext, **updates: str | None) -> None:
    cache = load_cache(ctx)
    for key, value in updates.items():
        if value is None:
            continue
        text = value.strip()
        if text:
            cache[key] = text

    ctx.cache_path.parent.mkdir(parents=True, exist_ok=True)
    ctx.cache_path.write_text(
        json.dumps(cache, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def current_branch(ctx: RepoContext) -> str | None:
    branch = git_stdout(ctx, "branch", "--show-current", check=False)
    return branch or None


def ensure_branch(ctx: RepoContext) -> str:
    branch = current_branch(ctx)
    if not branch:
        raise TaskError("当前不在可识别的本地分支上，可能处于 detached HEAD 状态。")
    return branch


def current_upstream(ctx: RepoContext) -> dict[str, str] | None:
    upstream = git_stdout(
        ctx,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
        check=False,
    )
    if not upstream:
        return None

    if "/" not in upstream:
        return {"full": upstream, "remote": upstream, "branch": ""}

    remote_name, branch_name = upstream.split("/", 1)
    return {"full": upstream, "remote": remote_name, "branch": branch_name}


def remote_map(ctx: RepoContext) -> dict[str, dict[str, str]]:
    remotes: dict[str, dict[str, str]] = {}
    output = git_stdout(ctx, "remote", "-v", check=False)
    pattern = re.compile(r"^(\S+)\s+(.+?)\s+\((fetch|push)\)$")

    for line in output.splitlines():
        match = pattern.match(line.strip())
        if not match:
            continue

        name, url, kind = match.groups()
        remotes.setdefault(name, {})[kind] = url

    return remotes


def git_config(ctx: RepoContext, key: str) -> str:
    return git_stdout(ctx, "config", "--get", key, check=False)


def local_branch_exists(ctx: RepoContext, branch_name: str) -> bool:
    result = git(ctx, "show-ref", "--verify", f"refs/heads/{branch_name}", check=False)
    return result.returncode == 0


def ensure_remote_exists(ctx: RepoContext, remote_name: str) -> None:
    remotes = remote_map(ctx)
    if remote_name in remotes:
        return

    available = ", ".join(sorted(remotes)) if remotes else "无"
    raise TaskError(
        f"未找到远程源：{remote_name}\n"
        f"当前可用远程源：{available}\n"
        '可使用任务“仓库：设置远程仓库源”进行新增或更新。'
    )


def resolve_remote(ctx: RepoContext, explicit_remote: str) -> tuple[str, str]:
    remote_input = explicit_remote.strip()
    if remote_input:
        return remote_input, "手动输入"

    cache = load_cache(ctx)
    cached_remote = str(cache.get("last_remote", "")).strip()
    if cached_remote:
        return cached_remote, "缓存"

    upstream = current_upstream(ctx)
    if upstream and upstream.get("remote"):
        return upstream["remote"], "当前上游"

    return "origin", "默认值"


def resolve_target_branch(ctx: RepoContext, explicit_branch: str) -> tuple[str, str]:
    branch_input = explicit_branch.strip()
    if branch_input:
        return branch_input, "手动输入"

    cache = load_cache(ctx)
    cached_branch = str(cache.get("last_branch", "")).strip()
    if cached_branch:
        return cached_branch, "缓存"

    return ensure_branch(ctx), "当前分支"


def is_non_fast_forward_push_error(result: subprocess.CompletedProcess[str]) -> bool:
    combined = "\n".join(
        part.strip() for part in (result.stdout or "", result.stderr or "") if part.strip()
    ).lower()
    markers = (
        "fetch first",
        "non-fast-forward",
        "[rejected]",
        "tip of your current branch is behind",
    )
    return any(marker in combined for marker in markers)


def confirm_force_push() -> bool:
    print_section("推送冲突")
    print("检测到远程分支存在未合并提交，普通推送已被 Git 拒绝。")
    print("如果确认要覆盖远程分支，请输入 Y 或 yes 继续强制推送。")
    print("输入其他内容或直接回车将取消。")
    try:
        answer = input("是否执行强制推送？[y/N]: ").strip().lower()
    except EOFError:
        return False
    return answer in {"y", "yes"}


def print_completed_process(result: subprocess.CompletedProcess[str]) -> None:
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    if stdout:
        print(stdout)
    if stderr:
        print(stderr)


def run_push_with_optional_force(
    ctx: RepoContext,
    push_args: list[str],
    force_push_args: list[str],
    success_message: str,
    force_success_message: str,
    remote_name: str,
    branch_name: str,
) -> int:
    result = git(ctx, *push_args, check=False)
    if result.returncode == 0:
        print_completed_process(result)
        save_cache(ctx, last_remote=remote_name, last_branch=branch_name)
        print(success_message)
        return 0

    if not is_non_fast_forward_push_error(result):
        raise TaskError(format_process_error([ctx.git_exe, *push_args], result))

    print(format_process_error([ctx.git_exe, *push_args], result))

    if not sys.stdin.isatty():
        raise TaskError("当前终端不可交互，无法确认是否强制推送。")

    if not confirm_force_push():
        raise TaskError("已取消强制推送，远程未发生变更。")

    print("\n开始执行强制推送...")
    force_result = git(ctx, *force_push_args, check=False)
    if force_result.returncode != 0:
        raise TaskError(format_process_error([ctx.git_exe, *force_push_args], force_result))

    print_completed_process(force_result)
    save_cache(ctx, last_remote=remote_name, last_branch=branch_name)
    print(force_success_message)
    return 0


def print_section(title: str) -> None:
    print(f"\n== {title} ==")


def print_remotes(ctx: RepoContext) -> None:
    remotes = remote_map(ctx)
    upstream = current_upstream(ctx)
    cached_remote = str(load_cache(ctx).get("last_remote", "")).strip()

    print_section("远程仓库")
    if not remotes:
        print("未配置任何远程仓库。")
        print('示例：git remote add origin https://github.com/your-name/your-repo.git')
        return

    for name in sorted(remotes):
        markers: list[str] = []
        if upstream and name == upstream.get("remote"):
            markers.append("当前上游")
        if cached_remote and name == cached_remote:
            markers.append("最近使用")

        marker_text = f" [{'、'.join(markers)}]" if markers else ""
        fetch_url = remotes[name].get("fetch", "未设置")
        push_url = remotes[name].get("push", fetch_url)
        print(f"- {name}{marker_text}")
        print(f"  fetch: {fetch_url}")
        print(f"  push:  {push_url}")


def cmd_status(ctx: RepoContext, _: argparse.Namespace) -> int:
    branch = current_branch(ctx)
    upstream = current_upstream(ctx)
    author_name = git_config(ctx, "user.name")
    author_email = git_config(ctx, "user.email")

    print_section("仓库信息")
    print(f"仓库根目录: {ctx.root}")
    print(f"Git 路径: {ctx.git_exe}")

    print_section("当前分支")
    if branch:
        print(f"当前分支: {branch}")
    else:
        print("当前分支: 未检测到（可能处于 detached HEAD 状态）")

    if upstream:
        print(f"当前上游: {upstream['full']}")
        if branch:
            print(f"当前绑定: {branch} -> {upstream['full']}")
    else:
        print("当前上游: 未设置")
        print(f"示例：git push -u origin {branch or '<branch>'}")

    print_remotes(ctx)

    print_section("作者信息")
    if author_name:
        print(f"user.name : {author_name}")
    else:
        print("user.name : 未设置")
        print('示例：git config --global user.name "Your Name"')

    if author_email:
        print(f"user.email: {author_email}")
    else:
        print("user.email: 未设置")
        print('示例：git config --global user.email "name@example.com"')

    return 0


def cmd_switch(ctx: RepoContext, args: argparse.Namespace) -> int:
    branch_name = args.branch.strip()
    if not branch_name:
        raise TaskError("分支名称不能为空。")

    if local_branch_exists(ctx, branch_name):
        git(ctx, "switch", branch_name)
        print(f"已切换到已有分支：{branch_name}")
    else:
        git(ctx, "switch", "-c", branch_name)
        print(f"已创建并切换到新分支：{branch_name}")

    save_cache(ctx, last_branch=branch_name)
    return 0


def cmd_commit(ctx: RepoContext, args: argparse.Namespace) -> int:
    message = args.message.strip()
    if not message:
        raise TaskError("提交说明不能为空。")

    changed = git_stdout(ctx, "status", "--short", check=False)
    if not changed:
        print("当前没有可提交的改动。")
        return 0

    git(ctx, "add", "-A")

    print_section("即将提交的改动")
    print(git_stdout(ctx, "status", "--short", check=False) or "无")

    result = git(ctx, "commit", "-m", message)
    print(result.stdout.strip() or "提交完成。")
    return 0


def cmd_push_current(ctx: RepoContext, args: argparse.Namespace) -> int:
    branch_name = ensure_branch(ctx)
    remote_name, source = resolve_remote(ctx, args.remote)
    ensure_remote_exists(ctx, remote_name)

    print(f"使用远程源: {remote_name}（来源：{source}）")
    return run_push_with_optional_force(
        ctx,
        ["push", "-u", remote_name, branch_name],
        ["push", "--force", "-u", remote_name, branch_name],
        f"已推送当前分支到 {remote_name}/{branch_name}",
        f"已强制推送当前分支到 {remote_name}/{branch_name}",
        remote_name,
        branch_name,
    )


def cmd_push_branch(ctx: RepoContext, args: argparse.Namespace) -> int:
    remote_name, remote_source = resolve_remote(ctx, args.remote)
    ensure_remote_exists(ctx, remote_name)
    target_branch, branch_source = resolve_target_branch(ctx, args.branch)

    print(f"使用远程源: {remote_name}（来源：{remote_source}）")
    print(f"目标分支: {target_branch}（来源：{branch_source}）")
    return run_push_with_optional_force(
        ctx,
        ["push", remote_name, f"HEAD:{target_branch}"],
        ["push", "--force", remote_name, f"HEAD:{target_branch}"],
        f"已将当前内容推送到 {remote_name}/{target_branch}",
        f"已强制将当前内容推送到 {remote_name}/{target_branch}",
        remote_name,
        target_branch,
    )


def cmd_pull_current(ctx: RepoContext, args: argparse.Namespace) -> int:
    branch_name = ensure_branch(ctx)
    remote_name, source = resolve_remote(ctx, args.remote)
    ensure_remote_exists(ctx, remote_name)

    print(f"使用远程源: {remote_name}（来源：{source}）")
    git(ctx, "pull", remote_name, branch_name)
    save_cache(ctx, last_remote=remote_name, last_branch=branch_name)
    print(f"已从 {remote_name}/{branch_name} 拉取最新改动")
    return 0


def cmd_set_remote(ctx: RepoContext, args: argparse.Namespace) -> int:
    remote_name = args.name.strip()
    remote_url = args.url.strip()

    if not remote_name:
        raise TaskError("远程源名称不能为空。")
    if not remote_url:
        raise TaskError("远程仓库地址不能为空。")

    remotes = remote_map(ctx)
    if remote_name in remotes:
        git(ctx, "remote", "set-url", remote_name, remote_url)
        git(ctx, "remote", "set-url", "--push", remote_name, remote_url)
        print(f"已更新远程源：{remote_name} -> {remote_url}")
    else:
        git(ctx, "remote", "add", remote_name, remote_url)
        print(f"已新增远程源：{remote_name} -> {remote_url}")

    save_cache(ctx, last_remote=remote_name)
    print_remotes(ctx)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repository task helpers for VSCode/Cursor."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser(
        "status", help="Show branch, remote and author information."
    )
    status_parser.set_defaults(handler=cmd_status)

    switch_parser = subparsers.add_parser(
        "switch", help="Switch to an existing branch or create it."
    )
    switch_parser.add_argument("--branch", required=True)
    switch_parser.set_defaults(handler=cmd_switch)

    commit_parser = subparsers.add_parser(
        "commit", help="Stage all changes and create a commit."
    )
    commit_parser.add_argument("--message", required=True)
    commit_parser.set_defaults(handler=cmd_commit)

    push_current_parser = subparsers.add_parser(
        "push-current", help="Push current branch to a remote."
    )
    push_current_parser.add_argument("--remote", default="")
    push_current_parser.set_defaults(handler=cmd_push_current)

    push_branch_parser = subparsers.add_parser(
        "push-branch", help="Push current HEAD to a target remote branch."
    )
    push_branch_parser.add_argument("--remote", default="")
    push_branch_parser.add_argument("--branch", default="")
    push_branch_parser.set_defaults(handler=cmd_push_branch)

    pull_current_parser = subparsers.add_parser(
        "pull-current", help="Pull current branch from a remote."
    )
    pull_current_parser.add_argument("--remote", default="")
    pull_current_parser.set_defaults(handler=cmd_pull_current)

    set_remote_parser = subparsers.add_parser(
        "set-remote", help="Add or update a remote binding."
    )
    set_remote_parser.add_argument("--name", required=True)
    set_remote_parser.add_argument("--url", required=True)
    set_remote_parser.set_defaults(handler=cmd_set_remote)

    return parser


def main() -> int:
    configure_stdio()
    parser = build_parser()
    args = parser.parse_args()
    ctx = build_repo_context()
    return args.handler(ctx, args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TaskError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
