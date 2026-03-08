#!/usr/bin/env python3
from __future__ import annotations

import os
import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
CORE_DIR = ROOT_DIR / "core"
ELECTRON_DIR = ROOT_DIR / "ElectronApp"
BIN_DIR = ROOT_DIR / "Bin"
BIN_WINDOWS_DIR = BIN_DIR / "Wateray-windows"
BIN_CORE_DIR = BIN_WINDOWS_DIR / "core"
MANIFEST_PATH = ROOT_DIR / "scripts" / "build" / "assets" / "wateray_server.manifest"
TEMP_SYSO_PATH = CORE_DIR / "cmd" / "waterayd" / "zz_wateray_server_windows_amd64.syso"
ELECTRON_PACKAGE_OUT_DIR = ELECTRON_DIR / "out-package"
ELECTRON_UNPACKED_DIR = ELECTRON_PACKAGE_OUT_DIR / "WaterayApp-win32-x64"
ELECTRON_ICON_PATH = ELECTRON_DIR / "ico.ico"
ELECTRON_RULE_SET_DIR = ELECTRON_DIR / "rule-set"
ELECTRON_DEFAULT_CONFIG_DIR = ELECTRON_DIR / "default-config"
VERSION_PATH = ROOT_DIR / "VERSION"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


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


def run_command(command: list[str], cwd: Path, stage: str, code: int, env: dict[str, str] | None = None) -> None:
    resolved = [resolve_executable(command[0]), *command[1:]]
    print(" ".join(resolved))
    try:
        result = subprocess.run(resolved, cwd=str(cwd), env=env)
    except FileNotFoundError as err:
        raise BuildError(code, stage, f"命令不存在：{command[0]}") from err
    if result.returncode != 0:
        raise BuildError(code, stage, f"命令执行失败：{' '.join(command)}")


def ensure_windows() -> None:
    if os.name != "nt":
        raise BuildError(10, "prepare", "仅支持在 Windows 环境执行该脚本")


def ensure_required_files() -> None:
    missing: list[Path] = []
    for path in (
        VERSION_PATH,
        CORE_DIR / "go.mod",
        ELECTRON_DIR / "package.json",
        MANIFEST_PATH,
        ELECTRON_ICON_PATH,
        ELECTRON_RULE_SET_DIR,
    ):
        if not path.exists():
            missing.append(path)
    if missing:
        formatted = ", ".join(str(path) for path in missing)
        raise BuildError(11, "prepare", f"缺少必要文件：{formatted}")


def load_release_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not SEMVER_PATTERN.match(version):
        raise BuildError(12, "prepare", f"VERSION 格式非法（需要 X.Y.Z）：{version!r}")

    package_payload = json.loads((ELECTRON_DIR / "package.json").read_text(encoding="utf-8"))
    package_version = str(package_payload.get("version", "")).strip()
    if package_version != version:
        raise BuildError(
            12,
            "prepare",
            f"VERSION 与 ElectronApp/package.json 版本不一致：{version} != {package_version}",
        )

    package_lock_path = ELECTRON_DIR / "package-lock.json"
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


def clean_outputs() -> None:
    print_step("清理旧产物")
    if BIN_DIR.exists():
        shutil.rmtree(BIN_DIR)
    BIN_CORE_DIR.mkdir(parents=True, exist_ok=True)
    if ELECTRON_PACKAGE_OUT_DIR.exists():
        shutil.rmtree(ELECTRON_PACKAGE_OUT_DIR)


def build_backend_release(release_version: str) -> None:
    print_step("编译后端 WaterayServer.exe（requireAdministrator）")
    if TEMP_SYSO_PATH.exists():
        TEMP_SYSO_PATH.unlink()
    try:
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

        env = os.environ.copy()
        env["GOOS"] = "windows"
        env["GOARCH"] = "amd64"
        ldflags_value = f"-s -w -X main.appVersion={release_version}"
        run_command(
            [
                "go",
                "build",
                "-tags",
                "with_clash_api,with_gvisor",
                "-trimpath",
                "-ldflags",
                ldflags_value,
                "-o",
                str(BIN_CORE_DIR / "WaterayServer.exe"),
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

    if not (BIN_CORE_DIR / "WaterayServer.exe").exists():
        raise BuildError(
            21,
            "backend_build",
            "后端产物缺失：Bin/Wateray-windows/core/WaterayServer.exe",
        )


def ensure_frontend_deps() -> None:
    if (ELECTRON_DIR / "node_modules").exists():
        return
    print_step("安装前端依赖（首次构建）")
    run_command(["npm", "install"], cwd=ELECTRON_DIR, stage="frontend_install", code=30)


def build_frontend_unpacked(release_version: str) -> None:
    ensure_frontend_deps()

    print_step("构建 Electron 前端 bundle")
    run_command(["npm", "run", "build"], cwd=ELECTRON_DIR, stage="frontend_build", code=31)

    print_step("打包 Electron Windows unpacked 目录")
    run_command(
        ["npm", "run", "package:win-unpacked"],
        cwd=ELECTRON_DIR,
        stage="frontend_package",
        code=32,
    )
    if not ELECTRON_UNPACKED_DIR.exists():
        raise BuildError(
            32,
            "frontend_package",
            f"未找到 unpacked 目录：{ELECTRON_UNPACKED_DIR}",
        )

    print_step("整理前端产物到 Bin/Wateray-windows")
    for item in ELECTRON_UNPACKED_DIR.iterdir():
        target = BIN_WINDOWS_DIR / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)
    shutil.copytree(
        ELECTRON_RULE_SET_DIR,
        BIN_WINDOWS_DIR / "rule-set",
        dirs_exist_ok=True,
    )
    if ELECTRON_DEFAULT_CONFIG_DIR.exists():
        shutil.copytree(
            ELECTRON_DEFAULT_CONFIG_DIR,
            BIN_WINDOWS_DIR / "default-config",
            dirs_exist_ok=True,
        )
    else:
        print(f"跳过默认配置拷贝（目录不存在）：{ELECTRON_DEFAULT_CONFIG_DIR}")
    print(f"同步 VERSION -> {release_version}")
    shutil.copy2(VERSION_PATH, BIN_WINDOWS_DIR / "VERSION")

    if not (BIN_WINDOWS_DIR / "WaterayApp.exe").exists():
        raise BuildError(33, "assemble", "前端产物缺失：Bin/Wateray-windows/WaterayApp.exe")


def format_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size_bytes)
    unit_index = 0
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1
    return f"{value:.2f} {units[unit_index]}"


def print_summary(start_ts: float, release_version: str) -> None:
    backend_exe = BIN_CORE_DIR / "WaterayServer.exe"
    frontend_exe = BIN_WINDOWS_DIR / "WaterayApp.exe"
    elapsed = time.time() - start_ts
    print_step("构建完成")
    print(f"- 后端：{backend_exe} ({format_size(backend_exe.stat().st_size)})")
    print(f"- 前端：{frontend_exe} ({format_size(frontend_exe.stat().st_size)})")
    print(f"- 结构：{BIN_WINDOWS_DIR}")
    print("- 目录预期：Bin/Wateray-windows + Bin/Wateray-windows/core")
    print(f"- 统一版本：{release_version}")
    print(f"- 总耗时：{elapsed:.1f}s")


def main() -> int:
    start_ts = time.time()
    try:
        ensure_windows()
        ensure_required_files()
        release_version = load_release_version()
        clean_outputs()
        build_backend_release(release_version)
        build_frontend_unpacked(release_version)
        print_summary(start_ts, release_version)
        return 0
    except BuildError as err:
        print(f"\n构建失败：{err}", file=sys.stderr)
        return err.code
    except Exception as err:  # pragma: no cover - unexpected guard
        print(f"\n构建失败：[unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
