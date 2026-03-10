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
ELECTRON_DIR = ROOT_DIR / "ElectronApp"
BIN_DIR = ROOT_DIR / "Bin"
MANIFEST_PATH = ROOT_DIR / "scripts" / "build" / "assets" / "wateray_server.manifest"
TEMP_SYSO_PATH = CORE_DIR / "cmd" / "waterayd" / "zz_wateray_server_windows_amd64.syso"
ELECTRON_PACKAGE_OUT_DIR = ELECTRON_DIR / "out-package"
ELECTRON_PACKAGE_OUT_ROOT = BIN_DIR / ".tmp" / "desktop-package-out"
ELECTRON_PACKAGE_TMP_ROOT = BIN_DIR / ".tmp" / "electron-packager"
ELECTRON_PACKAGE_SRC_ROOT = BIN_DIR / ".tmp" / "desktop-package-src"
ELECTRON_RULE_SET_DIR = ELECTRON_DIR / "rule-set"
ELECTRON_DEFAULT_CONFIG_DIR = ELECTRON_DIR / "default-config"
LINUX_BUILD_ASSET_DIR = ROOT_DIR / "scripts" / "build" / "assets" / "linux"
VERSION_PATH = ROOT_DIR / "VERSION"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
SEMVER_CAPTURE_PATTERN = re.compile(r"(\d+\.\d+\.\d+)")


@dataclass(frozen=True)
class DesktopBuildTarget:
    platform_id: str
    display_name: str
    host_platforms: tuple[str, ...]
    electron_platform: str
    electron_arch: str
    go_os: str
    go_arch: str
    output_dir_name: str
    daemon_binary_name: str
    frontend_entry_name: str
    icon_path: str | None = None
    needs_windows_manifest: bool = False

    @property
    def bin_dir(self) -> Path:
        return BIN_DIR / self.output_dir_name

    @property
    def bin_core_dir(self) -> Path:
        return self.bin_dir / "core"

    @property
    def electron_unpacked_dir(self) -> Path:
        return self.electron_out_dir / f"WaterayApp-{self.electron_platform}-{self.electron_arch}"

    @property
    def electron_out_dir(self) -> Path:
        return ELECTRON_PACKAGE_OUT_ROOT / self.platform_id


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
        result = subprocess.run(resolved, cwd=str(cwd), env=env)
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


def ensure_required_files(target: DesktopBuildTarget) -> None:
    missing: list[Path] = []
    required_paths = [
        VERSION_PATH,
        CORE_DIR / "go.mod",
        ELECTRON_DIR / "package.json",
        ELECTRON_RULE_SET_DIR,
    ]
    if target.icon_path:
        required_paths.append((ELECTRON_DIR / target.icon_path).resolve())
    if target.platform_id == "linux":
        required_paths.append(LINUX_BUILD_ASSET_DIR)
    if target.needs_windows_manifest:
        required_paths.extend(
            [
                MANIFEST_PATH,
                ELECTRON_DIR / "ico.ico",
            ],
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


def load_electron_version() -> str:
    package_payload = json.loads((ELECTRON_DIR / "package.json").read_text(encoding="utf-8"))
    raw_version = str(package_payload.get("devDependencies", {}).get("electron", "")).strip()
    matched = SEMVER_CAPTURE_PATTERN.search(raw_version)
    if not matched:
        raise BuildError(12, "prepare", f"Electron 版本缺失或格式非法：{raw_version!r}")
    return matched.group(1)


def clean_outputs(target: DesktopBuildTarget) -> None:
    print_step("清理旧产物")
    if target.bin_dir.exists():
        shutil.rmtree(target.bin_dir)
    target.bin_core_dir.mkdir(parents=True, exist_ok=True)
    if ELECTRON_PACKAGE_OUT_DIR.exists():
        shutil.rmtree(ELECTRON_PACKAGE_OUT_DIR)
    if target.electron_out_dir.exists():
        shutil.rmtree(target.electron_out_dir)
    package_src_dir = ELECTRON_PACKAGE_SRC_ROOT / target.platform_id
    if package_src_dir.exists():
        shutil.rmtree(package_src_dir)


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
        ldflags_value = f"-s -w -X main.appVersion={release_version}"
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
        raise BuildError(
            21,
            "backend_build",
            f"后端产物缺失：{daemon_path}",
        )


def ensure_frontend_deps() -> None:
    if (ELECTRON_DIR / "node_modules").exists():
        return
    print_step("安装前端依赖（首次构建）")
    run_command(["npm", "install"], cwd=ELECTRON_DIR, stage="frontend_install", code=30)


def sanitize_packaging_manifest(package_src_dir: Path) -> None:
    package_json_path = package_src_dir / "package.json"
    package_payload = json.loads(package_json_path.read_text(encoding="utf-8"))
    # electron-packager v19 may resolve dev-only metadata from sourcedir.
    package_payload.pop("devDependencies", None)
    package_payload.pop("scripts", None)
    package_json_path.write_text(
        json.dumps(package_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def prepare_packaging_source(target: DesktopBuildTarget) -> Path:
    print_step("准备 Electron 精简发布源")
    package_src_dir = ELECTRON_PACKAGE_SRC_ROOT / target.platform_id
    if package_src_dir.exists():
        shutil.rmtree(package_src_dir)
    package_src_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(ELECTRON_DIR / "package.json", package_src_dir / "package.json")
    package_lock_path = ELECTRON_DIR / "package-lock.json"
    if package_lock_path.exists():
        shutil.copy2(package_lock_path, package_src_dir / "package-lock.json")

    built_out_dir = ELECTRON_DIR / "out"
    if not built_out_dir.exists():
        raise BuildError(31, "frontend_build", f"缺少 Electron 构建产物：{built_out_dir}")
    shutil.copytree(built_out_dir, package_src_dir / "out", dirs_exist_ok=True)

    run_command(
        ["npm", "ci", "--omit=dev"],
        cwd=package_src_dir,
        stage="frontend_runtime_deps",
        code=31,
    )
    sanitize_packaging_manifest(package_src_dir)
    return package_src_dir


def build_frontend_unpacked(target: DesktopBuildTarget, release_version: str) -> None:
    ensure_frontend_deps()
    electron_version = load_electron_version()

    print_step("构建 Electron 前端 bundle")
    run_command(["npm", "run", "build"], cwd=ELECTRON_DIR, stage="frontend_build", code=31)
    package_src_dir = prepare_packaging_source(target)

    print_step(f"打包 Electron {target.display_name} unpacked 目录")
    package_command = [
        "npx",
        "electron-packager",
        str(package_src_dir),
        "WaterayApp",
        f"--out={target.electron_out_dir}",
        "--overwrite",
        "--asar",
        f"--platform={target.electron_platform}",
        f"--arch={target.electron_arch}",
        f"--electron-version={electron_version}",
    ]
    if target.icon_path:
        package_command.append(f"--icon={(ELECTRON_DIR / target.icon_path).resolve()}")
    package_env: dict[str, str] | None = None
    package_attempts = 1
    if target.platform_id == "windows":
        package_attempts = 2
        package_tmp_dir = ELECTRON_PACKAGE_TMP_ROOT / target.platform_id
        if package_tmp_dir.exists():
            shutil.rmtree(package_tmp_dir, ignore_errors=True)
        package_tmp_dir.mkdir(parents=True, exist_ok=True)
        package_command.extend(
            [
                "--no-prune",
                f"--tmpdir={package_tmp_dir}",
            ],
        )
        package_env = os.environ.copy()
        package_env["TEMP"] = str(package_tmp_dir)
        package_env["TMP"] = str(package_tmp_dir)
    last_error: BuildError | None = None
    for attempt in range(1, package_attempts + 1):
        try:
            run_command(
                package_command,
                cwd=ELECTRON_DIR,
                stage="frontend_package",
                code=32,
                env=package_env,
            )
            last_error = None
            break
        except BuildError as err:
            last_error = err
            if attempt >= package_attempts:
                break
            print(f"打包失败，准备重试（{attempt}/{package_attempts}）")
            time.sleep(2)
            if target.platform_id == "windows":
                package_tmp_dir = ELECTRON_PACKAGE_TMP_ROOT / target.platform_id
                if package_tmp_dir.exists():
                    shutil.rmtree(package_tmp_dir, ignore_errors=True)
                package_tmp_dir.mkdir(parents=True, exist_ok=True)
    if last_error is not None:
        raise last_error
    if not target.electron_unpacked_dir.exists():
        raise BuildError(
            32,
            "frontend_package",
            f"未找到 unpacked 目录：{target.electron_unpacked_dir}",
        )

    print_step(f"整理前端产物到 {target.bin_dir}")
    for item in target.electron_unpacked_dir.iterdir():
        target_path = target.bin_dir / item.name
        if item.is_dir():
            shutil.copytree(item, target_path, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target_path)
    shutil.copytree(
        ELECTRON_RULE_SET_DIR,
        target.bin_dir / "rule-set",
        dirs_exist_ok=True,
    )
    if ELECTRON_DEFAULT_CONFIG_DIR.exists():
        shutil.copytree(
            ELECTRON_DEFAULT_CONFIG_DIR,
            target.bin_dir / "default-config",
            dirs_exist_ok=True,
        )
    else:
        print(f"跳过默认配置拷贝（目录不存在）：{ELECTRON_DEFAULT_CONFIG_DIR}")
    print(f"同步 VERSION -> {release_version}")
    shutil.copy2(VERSION_PATH, target.bin_dir / "VERSION")
    if target.platform_id == "linux" and LINUX_BUILD_ASSET_DIR.exists():
        shutil.copytree(
            LINUX_BUILD_ASSET_DIR,
            target.bin_dir / "linux",
            dirs_exist_ok=True,
        )

    frontend_path = target.bin_dir / target.frontend_entry_name
    if not frontend_path.exists():
        raise BuildError(33, "assemble", f"前端产物缺失：{frontend_path}")


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
    if frontend_path.is_file():
        frontend_label = format_size(frontend_path.stat().st_size)
    else:
        frontend_label = "bundle"
    print(f"- 前端：{frontend_path} ({frontend_label})")
    print(f"- 结构：{target.bin_dir}")
    print(f"- 统一版本：{release_version}")
    print(f"- 总耗时：{elapsed:.1f}s")


def build_desktop_target(target: DesktopBuildTarget) -> int:
    start_ts = time.time()
    try:
        ensure_host_supported(target)
        ensure_required_files(target)
        release_version = load_release_version()
        clean_outputs(target)
        build_backend_release(target, release_version)
        build_frontend_unpacked(target, release_version)
        print_summary(start_ts, target, release_version)
        return 0
    except BuildError as err:
        print(f"\n构建失败：{err}", file=sys.stderr)
        return err.code
    except Exception as err:  # pragma: no cover
        print(f"\n构建失败：[unexpected] {err}", file=sys.stderr)
        return 99
