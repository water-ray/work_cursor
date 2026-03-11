#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[3]
CORE_DIR = ROOT_DIR / "core"
TAURI_DIR = ROOT_DIR / "TauriApp"
TAURI_CARGO_MANIFEST_PATH = TAURI_DIR / "src-tauri" / "Cargo.toml"
TAURI_BINARY_TARGET_DIR = TAURI_DIR / "src-tauri" / "target" / "release"
BIN_DIR = ROOT_DIR / "Bin"
MANIFEST_PATH = ROOT_DIR / "scripts" / "build" / "assets" / "wateray_server.manifest"
TEMP_SYSO_PATH = CORE_DIR / "cmd" / "waterayd" / "zz_wateray_server_windows_amd64.syso"
TAURI_DEFAULT_CONFIG_DIR = TAURI_DIR / "default-config"
TAURI_DEFAULT_RULE_SET_DIR = TAURI_DEFAULT_CONFIG_DIR / "rule-set"
VERSION_PATH = ROOT_DIR / "VERSION"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


@dataclass(frozen=True)
class DesktopBuildTarget:
    platform_id: str
    display_name: str
    host_platforms: tuple[str, ...]
    go_os: str
    go_arch: str
    output_dir_name: str
    daemon_binary_name: str
    frontend_entry_name: str
    tauri_binary_name: str
    icon_path: str | None = None
    needs_windows_manifest: bool = False
    desktop_bundle_supported: bool = False

    @property
    def bin_dir(self) -> Path:
        return BIN_DIR / self.output_dir_name

    @property
    def bin_core_dir(self) -> Path:
        return self.bin_dir / "core"

    @property
    def tauri_binary_path(self) -> Path:
        return TAURI_BINARY_TARGET_DIR / self.tauri_binary_name


@dataclass
class BuildError(RuntimeError):
    code: int
    stage: str
    detail: str

    def __str__(self) -> str:
        return f"[{self.stage}] {self.detail} (exit_code={self.code})"


def print_step(title: str) -> None:
    print(f"\n==> {title}")


def resolve_executable(name: str) -> str:
    candidates = [name]
    if os.name == "nt":
        lower = name.lower()
        if not lower.endswith((".exe", ".cmd", ".bat")):
            candidates = [name, f"{name}.cmd", f"{name}.exe", f"{name}.bat"]
    for candidate in candidates:
        found = shutil.which(candidate)
        if found:
            return found
    return name


def run_command(
    command: list[str],
    cwd: Path,
    stage: str,
    code: int,
    env: dict[str, str] | None = None,
) -> None:
    resolved = [resolve_executable(command[0]), *command[1:]]
    print(" ".join(resolved))
    try:
        result = subprocess.run(resolved, cwd=str(cwd), env=env, check=False)
    except FileNotFoundError as err:
        raise BuildError(code, stage, f"命令不存在：{command[0]}") from err
    if result.returncode != 0:
        raise BuildError(code, stage, f"命令执行失败：{' '.join(command)}")


def ensure_host_supported(target: DesktopBuildTarget) -> None:
    if sys.platform in target.host_platforms:
        return
    hosts = ", ".join(target.host_platforms)
    raise BuildError(
        10,
        "prepare",
        f"{target.display_name} 需要在以下宿主系统构建：{hosts}；当前为 {sys.platform}",
    )


def ensure_bundle_supported(target: DesktopBuildTarget) -> None:
    if target.desktop_bundle_supported:
        return
    raise BuildError(
        13,
        "prepare",
        f"{target.display_name} 的 Tauri 桌面打包尚未迁移完成；当前阶段仅完成 Windows 客户端正式构建",
    )


def ensure_required_files(target: DesktopBuildTarget) -> None:
    missing: list[Path] = []
    required_paths = [
        VERSION_PATH,
        CORE_DIR / "go.mod",
        TAURI_DIR / "package.json",
        TAURI_CARGO_MANIFEST_PATH,
        TAURI_DEFAULT_CONFIG_DIR,
        TAURI_DEFAULT_RULE_SET_DIR,
    ]
    if target.icon_path:
        required_paths.append((TAURI_DIR / target.icon_path).resolve())
    if target.needs_windows_manifest:
        required_paths.extend(
            [
                MANIFEST_PATH,
                TAURI_DIR / "ico.ico",
            ]
        )
    for path in required_paths:
        if not path.exists():
            missing.append(path)
    if missing:
        formatted = ", ".join(str(path) for path in missing)
        raise BuildError(11, "prepare", f"缺少必要文件：{formatted}")


def load_release_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not SEMVER_PATTERN.match(version):
        raise BuildError(12, "prepare", f"VERSION 格式非法（需要 X.Y.Z）：{version!r}")

    package_payload = json.loads((TAURI_DIR / "package.json").read_text(encoding="utf-8"))
    package_version = str(package_payload.get("version", "")).strip()
    if package_version != version:
        raise BuildError(
            12,
            "prepare",
            f"VERSION 与 TauriApp/package.json 版本不一致：{version} != {package_version}",
        )

    package_lock_path = TAURI_DIR / "package-lock.json"
    if package_lock_path.exists():
        lock_payload = json.loads(package_lock_path.read_text(encoding="utf-8"))
        lock_version = str(lock_payload.get("version", "")).strip()
        if lock_version != version:
            raise BuildError(
                12,
                "prepare",
                f"VERSION 与 package-lock.json 版本不一致：{version} != {lock_version}",
            )
    return version


def clean_outputs(target: DesktopBuildTarget) -> None:
    print_step("清理旧产物")
    if target.bin_dir.exists():
        shutil.rmtree(target.bin_dir)
    target.bin_core_dir.mkdir(parents=True, exist_ok=True)


def build_windows_manifest() -> None:
    if TEMP_SYSO_PATH.exists():
        TEMP_SYSO_PATH.unlink()
    manifest_command = [
        "go",
        "run",
        "github.com/akavel/rsrc@latest",
        "-manifest",
        str(MANIFEST_PATH),
        "-o",
        str(TEMP_SYSO_PATH),
        "-arch",
        "amd64",
    ]
    proxy_attempts = [
        None,
        "https://proxy.golang.org,direct",
        "direct",
    ]
    last_manifest_error: BuildError | None = None
    for proxy in proxy_attempts:
        env = os.environ.copy()
        if proxy:
            env["GOPROXY"] = proxy
            print(f"GOPROXY fallback -> {proxy}")
        try:
            run_command(
                manifest_command,
                cwd=CORE_DIR,
                stage="backend_manifest",
                code=20,
                env=env,
            )
            last_manifest_error = None
            break
        except BuildError as err:
            last_manifest_error = err
    if last_manifest_error is not None:
        raise BuildError(
            20,
            "backend_manifest",
            "manifest 资源工具下载失败，请检查网络或 GOPROXY 配置",
        ) from last_manifest_error
    if not TEMP_SYSO_PATH.exists():
        raise BuildError(20, "backend_manifest", f"未生成资源文件：{TEMP_SYSO_PATH}")


def build_backend_release(target: DesktopBuildTarget, release_version: str) -> None:
    print_step(f"编译后端 {target.daemon_binary_name}")
    try:
        if target.needs_windows_manifest:
            build_windows_manifest()
        env = os.environ.copy()
        env["GOOS"] = target.go_os
        env["GOARCH"] = target.go_arch
        ldflags_parts = [
            "-s",
            "-w",
            f"-X main.appVersion={release_version}",
        ]
        if target.go_os == "windows":
            # 发布态由桌面宿主托管，不需要额外的控制台窗口。
            ldflags_parts.append("-H=windowsgui")
        ldflags_value = " ".join(ldflags_parts)
        run_command(
            [
                "go",
                "build",
                "-tags",
                "with_clash_api,with_gvisor,with_quic",
                "-trimpath",
                "-ldflags",
                ldflags_value,
                "-o",
                str(target.bin_core_dir / target.daemon_binary_name),
                "./cmd/waterayd",
            ],
            cwd=CORE_DIR,
            stage="backend_build",
            code=21,
            env=env,
        )
    finally:
        if TEMP_SYSO_PATH.exists():
            TEMP_SYSO_PATH.unlink()

    daemon_path = target.bin_core_dir / target.daemon_binary_name
    if not daemon_path.exists():
        raise BuildError(21, "backend_build", f"后端产物缺失：{daemon_path}")


def ensure_frontend_deps() -> None:
    if (TAURI_DIR / "node_modules").exists():
        return
    print_step("安装前端依赖（首次构建）")
    run_command(["npm", "install"], cwd=TAURI_DIR, stage="frontend_install", code=30)


def build_frontend_bundle() -> None:
    print_step("构建 Tauri 前端 bundle")
    run_command(["npm", "run", "build"], cwd=TAURI_DIR, stage="frontend_build", code=31)


def build_tauri_shell(target: DesktopBuildTarget) -> None:
    print_step("编译 Tauri 桌面宿主")
    run_command(
        [
            "npx",
            "tauri",
            "build",
            "--no-bundle",
        ],
        cwd=TAURI_DIR,
        stage="frontend_shell_build",
        code=32,
    )
    if not target.tauri_binary_path.exists():
        raise BuildError(
            32,
            "frontend_shell_build",
            f"未找到 Tauri 可执行文件：{target.tauri_binary_path}",
        )


def assemble_bundle(target: DesktopBuildTarget, release_version: str) -> None:
    print_step(f"整理前端产物到 {target.bin_dir}")
    frontend_target_path = target.bin_dir / target.frontend_entry_name
    shutil.copy2(target.tauri_binary_path, frontend_target_path)
    if TAURI_DEFAULT_CONFIG_DIR.exists():
        shutil.copytree(
            TAURI_DEFAULT_CONFIG_DIR,
            target.bin_dir / "default-config",
            dirs_exist_ok=True,
        )
    else:
        print(f"跳过默认配置拷贝（目录不存在）：{TAURI_DEFAULT_CONFIG_DIR}")
    print(f"打包版本 -> {release_version}")

    if not frontend_target_path.exists():
        raise BuildError(33, "assemble", f"前端产物缺失：{frontend_target_path}")


def format_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size_bytes)
    unit_index = 0
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1
    return f"{value:.2f} {units[unit_index]}"


def print_summary(start_ts: float, target: DesktopBuildTarget, release_version: str) -> None:
    backend_path = target.bin_core_dir / target.daemon_binary_name
    frontend_path = target.bin_dir / target.frontend_entry_name
    elapsed = time.time() - start_ts
    print_step("构建完成")
    print(f"- 平台：{target.display_name}")
    print(f"- 后端：{backend_path} ({format_size(backend_path.stat().st_size)})")
    print(f"- 前端：{frontend_path} ({format_size(frontend_path.stat().st_size)})")
    print(f"- 结构：{target.bin_dir}")
    print(f"- 统一版本：{release_version}")
    print(f"- 总耗时：{elapsed:.1f}s")


def build_desktop_target(target: DesktopBuildTarget) -> int:
    start_ts = time.time()
    try:
        ensure_host_supported(target)
        ensure_bundle_supported(target)
        ensure_required_files(target)
        release_version = load_release_version()
        clean_outputs(target)
        build_backend_release(target, release_version)
        ensure_frontend_deps()
        build_tauri_shell(target)
        assemble_bundle(target, release_version)
        print_summary(start_ts, target, release_version)
        return 0
    except BuildError as err:
        print(f"\n构建失败：{err}", file=sys.stderr)
        return err.code
    except Exception as err:  # pragma: no cover
        print(f"\n构建失败：[unexpected] {err}", file=sys.stderr)
        return 99
