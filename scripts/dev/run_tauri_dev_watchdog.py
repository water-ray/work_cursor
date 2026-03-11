#!/usr/bin/env python3
from __future__ import annotations

import argparse
import atexit
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ROOT_DIR = Path(__file__).resolve().parents[2]
TAURI_DIR = ROOT_DIR / "TauriApp"
TAURI_SRC_DIR = TAURI_DIR / "src-tauri"
DEFAULT_DEV_PORT = 1420
WEB_START_TIMEOUT_MS = 30000
LISTENING_PATTERN = re.compile(
    r"^\s*TCP\s+\S+:(?P<port>\d+)\s+\S+\s+LISTENING\s+(?P<pid>\d+)\s*$",
    re.IGNORECASE,
)


class TauriDevTaskError(RuntimeError):
    pass


def resolve_executable(candidates: tuple[str, ...], label: str) -> str:
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
    raise TauriDevTaskError(f"未找到 {label}，请确认它已安装并在 PATH 中。")


def list_listening_pids(port: int) -> list[int]:
    result = subprocess.run(
        ["netstat", "-ano", "-p", "TCP"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        check=False,
    )
    if result.returncode != 0:
        raise TauriDevTaskError("执行 netstat 失败，无法检查 Tauri dev 端口。")

    pids: set[int] = set()
    for raw_line in result.stdout.splitlines():
        match = LISTENING_PATTERN.match(raw_line)
        if not match:
            continue
        if int(match.group("port")) != port:
            continue
        pids.add(int(match.group("pid")))
    return sorted(pids)


def taskkill_pid_tree(pid: int, *, force: bool) -> None:
    command = ["taskkill", "/PID", str(pid), "/T"]
    if force:
        command.append("/F")
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        check=False,
    )
    if result.returncode != 0:
        rendered = (result.stdout + result.stderr).strip()
        if rendered:
            print(
                f"警告：结束进程树 PID={pid} 时返回非 0，可能进程已退出：\n{rendered}",
                file=sys.stderr,
            )


def wait_process_exit(pid: int, timeout_ms: int) -> bool:
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        if not is_process_alive(pid):
            return True
        time.sleep(0.2)
    return not is_process_alive(pid)


def terminate_pid_tree(pid: int, *, best_effort: bool) -> None:
    if os.name == "nt":
        taskkill_pid_tree(pid, force=False)
        if wait_process_exit(pid, timeout_ms=2000):
            return

        taskkill_pid_tree(pid, force=True)
        if wait_process_exit(pid, timeout_ms=3000):
            return

        if not best_effort:
            raise TauriDevTaskError(f"Windows 进程树 PID={pid} 在强制结束后仍未退出。")
        return

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as err:
        if not best_effort:
            raise TauriDevTaskError(f"结束进程 PID={pid} 失败：{err}") from err


def wait_port_state(port: int, *, should_listen: bool, timeout_ms: int) -> None:
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        has_listener = bool(list_listening_pids(port))
        if has_listener == should_listen:
            return
        time.sleep(0.25)
    state_label = "监听" if should_listen else "释放"
    raise TauriDevTaskError(f"端口 {port} 在 {timeout_ms}ms 内未完成{state_label}。")


def ensure_port_available(port: int) -> None:
    pids = list_listening_pids(port)
    if not pids:
        return
    rendered = ", ".join(str(pid) for pid in pids)
    raise TauriDevTaskError(
        f"端口 {port} 已被占用（PID: {rendered}）。请先结束现有的 Tauri 前端任务，再重新启动。"
    )


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    OpenProcess = kernel32.OpenProcess
    OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    OpenProcess.restype = wintypes.HANDLE

    WaitForSingleObject = kernel32.WaitForSingleObject
    WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    WaitForSingleObject.restype = wintypes.DWORD

    CloseHandle = kernel32.CloseHandle
    CloseHandle.argtypes = [wintypes.HANDLE]
    CloseHandle.restype = wintypes.BOOL

    SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102


def is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False

    if os.name == "nt":
        handle = OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


@dataclass
class ManagedProcess:
    name: str
    process: subprocess.Popen[str]


class ProcessTreeOwner:
    def __init__(self) -> None:
        self._managed: list[ManagedProcess] = []
        self._cleanup_lock = Lock()
        self._cleaned = False

    def spawn(self, *, name: str, command: list[str], cwd: Path) -> ManagedProcess:
        creation_flags = 0
        if os.name == "nt":
            creation_flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=os.environ.copy(),
            creationflags=creation_flags,
        )
        managed = ManagedProcess(name=name, process=process)
        self._managed.append(managed)
        return managed

    def cleanup(self, *, best_effort: bool) -> None:
        with self._cleanup_lock:
            if self._cleaned:
                return
            self._cleaned = True

        for managed in reversed(self._managed):
            if managed.process.poll() is not None:
                continue
            terminate_pid_tree(managed.process.pid, best_effort=best_effort)


CURRENT_OWNER: ProcessTreeOwner | None = None


def handle_termination(signum: int, _frame) -> None:
    if CURRENT_OWNER is not None:
        print(f"\n收到终止信号 {signum}，正在结束 Tauri 开发进程树...", file=sys.stderr)
        CURRENT_OWNER.cleanup(best_effort=True)
    raise SystemExit(130)


def register_signal_handlers() -> None:
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        signum = getattr(signal, name, None)
        if signum is not None:
            signal.signal(signum, handle_termination)


def parse_child_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a child process under parent watchdog.")
    parser.add_argument("--name", required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        raise TauriDevTaskError("child 模式缺少实际命令。")
    return args


def child_main(argv: list[str]) -> int:
    global CURRENT_OWNER

    args = parse_child_args(argv)
    owner = ProcessTreeOwner()
    CURRENT_OWNER = owner
    register_signal_handlers()
    atexit.register(lambda: CURRENT_OWNER.cleanup(best_effort=True) if CURRENT_OWNER else None)

    managed = owner.spawn(
        name=args.name,
        command=list(args.command),
        cwd=Path(args.cwd),
    )

    try:
        while True:
            exit_code = managed.process.poll()
            if exit_code is not None:
                return exit_code

            if not is_process_alive(args.parent_pid):
                print(f"检测到监督进程已退出，正在结束 {args.name}...", file=sys.stderr)
                owner.cleanup(best_effort=True)
                return 130

            time.sleep(0.3)
    finally:
        owner.cleanup(best_effort=True)


class TauriSupervisor(ProcessTreeOwner):
    def __init__(self, port: int) -> None:
        super().__init__()
        self.port = port
        self.web_helper: ManagedProcess | None = None
        self.tauri_helper: ManagedProcess | None = None

    def _spawn_child_helper(self, *, name: str, cwd: Path, command: list[str]) -> ManagedProcess:
        python = resolve_executable(("python.exe", "python"), "python")
        helper_command = [
            python,
            str(Path(__file__).resolve()),
            "child",
            "--name",
            name,
            "--parent-pid",
            str(os.getpid()),
            "--cwd",
            str(cwd),
            "--",
            *command,
        ]
        return self.spawn(name=f"helper:{name}", command=helper_command, cwd=ROOT_DIR)

    def start(self) -> None:
        if not TAURI_DIR.is_dir():
            raise TauriDevTaskError(f"TauriApp 目录不存在：{TAURI_DIR}")
        if not TAURI_SRC_DIR.is_dir():
            raise TauriDevTaskError(f"src-tauri 目录不存在：{TAURI_SRC_DIR}")

        ensure_port_available(self.port)

        npm = resolve_executable(("npm.cmd", "npm"), "npm")
        cargo = resolve_executable(("cargo.exe", "cargo"), "cargo")

        self.web_helper = self._spawn_child_helper(
            name="web:dev",
            cwd=TAURI_DIR,
            command=[npm, "run", "web:dev"],
        )

        try:
            wait_port_state(
                self.port,
                should_listen=True,
                timeout_ms=WEB_START_TIMEOUT_MS,
            )
        except TauriDevTaskError as err:
            web_exit = self.web_helper.process.poll()
            if web_exit is not None:
                raise TauriDevTaskError(
                    f"Vite dev server 启动失败，helper exit_code={web_exit}"
                ) from err
            raise

        self.tauri_helper = self._spawn_child_helper(
            name="tauri-host",
            cwd=TAURI_SRC_DIR,
            command=[
                cargo,
                "run",
                "--no-default-features",
                "--color",
                "always",
                "--",
            ],
        )

    def wait(self) -> int:
        if self.web_helper is None or self.tauri_helper is None:
            raise TauriDevTaskError("Tauri 子进程尚未完整启动。")

        while True:
            web_exit = self.web_helper.process.poll()
            tauri_exit = self.tauri_helper.process.poll()

            if web_exit is not None:
                if tauri_exit is None:
                    print("Vite dev helper 已退出，正在结束 Tauri helper...", file=sys.stderr)
                return web_exit

            if tauri_exit is not None:
                if web_exit is None:
                    print("Tauri helper 已退出，正在结束 Vite helper...", file=sys.stderr)
                return tauri_exit

            time.sleep(0.3)

    def cleanup(self, *, best_effort: bool) -> None:
        super().cleanup(best_effort=best_effort)


def supervisor_main() -> int:
    global CURRENT_OWNER

    port_raw = os.environ.get("WATERAY_TAURI_DEV_PORT", "").strip()
    port = DEFAULT_DEV_PORT
    if port_raw:
        try:
            port = int(port_raw)
        except ValueError as err:
            raise TauriDevTaskError(
                f"WATERAY_TAURI_DEV_PORT 不是合法整数：{port_raw!r}"
            ) from err

    supervisor = TauriSupervisor(port)
    CURRENT_OWNER = supervisor
    register_signal_handlers()
    atexit.register(lambda: CURRENT_OWNER.cleanup(best_effort=True) if CURRENT_OWNER else None)

    try:
        supervisor.start()
        return supervisor.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        supervisor.cleanup(best_effort=True)


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "child":
        try:
            return child_main(sys.argv[2:])
        except TauriDevTaskError as err:
            print(f"Tauri dev child 失败：{err}", file=sys.stderr)
            return 1

    try:
        return supervisor_main()
    except TauriDevTaskError as err:
        print(f"Tauri dev 任务启动失败：{err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
