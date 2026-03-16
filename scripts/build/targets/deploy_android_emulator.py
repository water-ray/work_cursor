#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.targets import build_android_release


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


class AndroidEmulatorDeployError(RuntimeError):
    pass


@dataclass(frozen=True)
class BuildArtifact:
    abi: str
    path: Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建并更新安装到指定 Android 模拟器")
    parser.add_argument(
        "--serial",
        default="emulator-5554",
        help="目标设备 serial，默认 emulator-5554",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="跳过重新构建，直接使用现有 release APK 安装",
    )
    return parser.parse_args()


def run_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    capture_output: bool = False,
    display_command: str | None = None,
) -> subprocess.CompletedProcess[str]:
    if display_command:
        print(display_command)
    elif capture_output:
        print(f"执行命令：{' '.join(command)}")
    effective_command = command
    if os.name == "nt" and Path(command[0]).suffix.lower() in {".bat", ".cmd"}:
        effective_command = ["cmd", "/c", *command]
    return subprocess.run(
        effective_command,
        cwd=str(cwd),
        env=env,
        capture_output=capture_output,
        text=True,
        check=False,
    )


def resolve_adb_path(env: dict[str, str]) -> Path:
    candidates: list[Path] = []
    executable_name = "adb.exe" if os.name == "nt" else "adb"

    which_result = shutil.which(executable_name, path=env.get("PATH", ""))
    if which_result:
        candidates.append(Path(which_result))

    try:
        sdk_root = build_android_release.resolve_android_sdk_root(env)
        candidates.append(sdk_root / "platform-tools" / executable_name)
    except Exception:
        pass

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    raise AndroidEmulatorDeployError("未找到 adb，请确认 Android SDK platform-tools 已安装")


def run_build(args: argparse.Namespace, env: dict[str, str]) -> None:
    build_script_path = ROOT_DIR / "scripts" / "build" / "targets" / "build_android_release.py"
    command = [sys.executable, str(build_script_path)]
    if args.skip_build:
        command.append("--skip-build")
    result = run_command(
        command,
        cwd=ROOT_DIR,
        env=env,
        display_command="开始构建 Android release APK...",
    )
    if result.returncode != 0:
        raise AndroidEmulatorDeployError("Android release 构建失败，已停止安装")


def ensure_device_available(adb_path: Path, serial: str) -> None:
    run_command([str(adb_path), "start-server"], cwd=ROOT_DIR)
    result = run_command(
        [str(adb_path), "-s", serial, "get-state"],
        cwd=ROOT_DIR,
        capture_output=True,
        display_command=f"检查设备状态：{serial}",
    )
    state = (result.stdout or "").strip().lower()
    if result.returncode != 0 or state != "device":
        stderr = (result.stderr or "").strip()
        raise AndroidEmulatorDeployError(
            f"目标设备不可用：{serial}"
            + (f"；{stderr}" if stderr else "")
        )


def normalize_device_abi(raw_value: str) -> str:
    value = raw_value.strip().lower()
    if value in {"arm64-v8a", "arm64", "aarch64"}:
        return "arm64"
    if value in {"x86_64", "x64"}:
        return "x86_64"
    return ""


def query_device_supported_abis(adb_path: Path, serial: str) -> list[str]:
    supported: list[str] = []
    for prop_name in (
        "ro.product.cpu.abilist64",
        "ro.product.cpu.abilist",
        "ro.product.cpu.abi",
    ):
        result = run_command(
            [str(adb_path), "-s", serial, "shell", "getprop", prop_name],
            cwd=ROOT_DIR,
            capture_output=True,
        )
        if result.returncode != 0:
            continue
        raw_output = (result.stdout or "").strip()
        if not raw_output:
            continue
        for item in raw_output.split(","):
            normalized = normalize_device_abi(item)
            if normalized and normalized not in supported:
                supported.append(normalized)
        if supported:
            return supported
    raise AndroidEmulatorDeployError("无法识别目标设备 ABI，无法匹配合适的 APK")


def load_build_artifacts() -> tuple[str, list[BuildArtifact]]:
    if not build_android_release.BUILD_INFO_PATH.is_file():
        raise AndroidEmulatorDeployError(
            f"未找到构建信息文件：{build_android_release.BUILD_INFO_PATH}"
        )

    payload = json.loads(
        build_android_release.BUILD_INFO_PATH.read_text(encoding="utf-8")
    )
    package_name = str(
        payload.get("packageName") or build_android_release.PACKAGE_NAME
    ).strip()
    artifacts: list[BuildArtifact] = []
    for item in payload.get("artifacts", []):
        abi = str(item.get("abi", "")).strip()
        relative_path = str(item.get("relativePath", "")).strip()
        if not abi or not relative_path:
            continue
        artifact_path = ROOT_DIR / Path(relative_path)
        if artifact_path.is_file():
            artifacts.append(BuildArtifact(abi=abi, path=artifact_path))

    if not artifacts:
        raise AndroidEmulatorDeployError("未找到可安装的 Android APK 产物")
    return package_name or build_android_release.PACKAGE_NAME, artifacts


def select_matching_artifact(
    artifacts: list[BuildArtifact],
    supported_abis: list[str],
) -> BuildArtifact:
    artifact_by_abi = {item.abi: item for item in artifacts}
    for abi in supported_abis:
        matched = artifact_by_abi.get(abi)
        if matched:
            return matched
    available = ", ".join(sorted(artifact_by_abi))
    wanted = ", ".join(supported_abis)
    raise AndroidEmulatorDeployError(
        f"未找到适配目标设备 ABI 的 APK；设备支持 {wanted}，现有产物 {available}"
    )


def is_package_installed(adb_path: Path, serial: str, package_name: str) -> bool:
    result = run_command(
        [str(adb_path), "-s", serial, "shell", "pm", "path", package_name],
        cwd=ROOT_DIR,
        capture_output=True,
    )
    return result.returncode == 0 and "package:" in (result.stdout or "")


def install_apk(
    *,
    adb_path: Path,
    serial: str,
    package_name: str,
    artifact: BuildArtifact,
) -> None:
    already_installed = is_package_installed(adb_path, serial, package_name)
    install_label = (
        "保留现有数据更新安装"
        if already_installed
        else "首次安装"
    )
    result = run_command(
        [str(adb_path), "-s", serial, "install", "-r", str(artifact.path)],
        cwd=ROOT_DIR,
        capture_output=True,
        display_command=f"{install_label}：{artifact.path.name} -> {serial}",
    )
    output = "\n".join(
        part.strip()
        for part in ((result.stdout or ""), (result.stderr or ""))
        if part.strip()
    )
    if result.returncode != 0 or "Success" not in output:
        raise AndroidEmulatorDeployError(
            "安装失败："
            + (output if output else "adb install -r 未返回成功结果")
        )

    print(f"安装完成：{artifact.path}")
    if already_installed:
        print("本次使用 adb install -r 更新，已保留应用数据与配置文件。")
    else:
        print("当前为首次安装。后续重复执行本脚本会保留应用数据与配置文件。")


def main() -> int:
    try:
        args = parse_args()
        env = build_android_release.prepare_android_environment()
        adb_path = resolve_adb_path(env)
        ensure_device_available(adb_path, args.serial)
        run_build(args, env)
        package_name, artifacts = load_build_artifacts()
        supported_abis = query_device_supported_abis(adb_path, args.serial)
        artifact = select_matching_artifact(artifacts, supported_abis)
        print(f"设备 ABI：{', '.join(supported_abis)}")
        print(f"选中 APK：{artifact.path.name}")
        install_apk(
            adb_path=adb_path,
            serial=args.serial,
            package_name=package_name,
            artifact=artifact,
        )
        return 0
    except AndroidEmulatorDeployError as error:
        print(f"部署失败：[android_emulator_deploy] {error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover
        print(f"部署失败：[android_emulator_deploy_unexpected] {error}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
