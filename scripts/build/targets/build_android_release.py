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

from scripts.build.common.version_sync import ensure_project_versions_synced
from scripts.build.common.sync_default_rulesets import (
    ensure_default_rule_sets_synced,
    print_rule_set_sync_summary,
)


TAURI_DIR = ROOT_DIR / "TauriApp"
VERSION_PATH = ROOT_DIR / "VERSION"
ANDROID_APK_OUTPUT_DIR = (
    TAURI_DIR / "src-tauri" / "gen" / "android" / "app" / "build" / "outputs" / "apk"
)
ANDROID_LOCAL_PROPERTIES_PATH = TAURI_DIR / "src-tauri" / "gen" / "android" / "local.properties"
ANDROID_BIN_DIR = ROOT_DIR / "Bin" / "Wateray-Android"
BUILD_INFO_PATH = ANDROID_BIN_DIR / "build-info.json"
PACKAGE_NAME = "com.wateray.desktop"
EXPECTED_OUTPUT_ABIS = ("arm64", "x86_64")
TAURI_ANDROID_TARGETS = ("aarch64", "x86_64")
DEFAULT_DEBUG_KEY_ALIAS = "androiddebugkey"
DEFAULT_DEBUG_KEY_PASSWORD = "android"
WINDOWS_SDK_FALLBACKS = (
    Path("E:/Android/sdk"),
    Path("C:/Android/sdk"),
)


@dataclass(frozen=True)
class ApkSigningConfig:
    keystore_path: Path
    keystore_password: str
    key_alias: str
    key_password: str
    label: str


class AndroidReleaseBuildError(RuntimeError):
    pass


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建并签名 Android release APK")
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="跳过 tauri android build，直接复用现有 release APK 输出做签名与拷贝",
    )
    return parser.parse_args()


def read_version() -> str:
    try:
        return ensure_project_versions_synced()
    except Exception as error:
        raise AndroidReleaseBuildError(str(error)) from error


def resolve_npx_command() -> str:
    return "npx.cmd" if os.name == "nt" else "npx"


def prepare_android_environment() -> dict[str, str]:
    env = os.environ.copy()
    home_dir = Path(env.get("HOME", "").strip() or env.get("USERPROFILE", "").strip() or ROOT_DIR)

    sdk_home_raw = env.get("ANDROID_SDK_HOME", "").strip()
    sdk_home_path = Path(sdk_home_raw) if sdk_home_raw else home_dir
    if sdk_home_path.name.lower() == ".android":
        sdk_home_path = sdk_home_path.parent
    env["ANDROID_SDK_HOME"] = str(sdk_home_path)

    user_home_raw = env.get("ANDROID_USER_HOME", "").strip()
    user_home_path = Path(user_home_raw) if user_home_raw else sdk_home_path / ".android"
    env["ANDROID_USER_HOME"] = str(user_home_path)

    sdk_home_path.mkdir(parents=True, exist_ok=True)
    user_home_path.mkdir(parents=True, exist_ok=True)
    env["WATERAY_APP_TARGET"] = "mobile"
    env["VITE_WATERAY_APP_TARGET"] = "mobile"
    return env


def decode_local_properties_value(raw_value: str) -> str:
    return raw_value.replace("\\:", ":").replace("\\\\", "\\")


def resolve_android_sdk_root(env: dict[str, str]) -> Path:
    candidate_values: list[str] = []
    for env_key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = env.get(env_key, "").strip()
        if value:
            candidate_values.append(value)

    if ANDROID_LOCAL_PROPERTIES_PATH.is_file():
        for raw_line in ANDROID_LOCAL_PROPERTIES_PATH.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "sdk.dir":
                decoded = decode_local_properties_value(value.strip())
                if decoded:
                    candidate_values.append(decoded)

    if os.name == "nt":
        local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
        if local_appdata:
            candidate_values.append(str(Path(local_appdata) / "Android" / "Sdk"))
        candidate_values.extend(str(path) for path in WINDOWS_SDK_FALLBACKS)

    for raw_value in candidate_values:
        sdk_root = Path(raw_value)
        if sdk_root.exists():
            return sdk_root

    raise AndroidReleaseBuildError("未找到 Android SDK 根目录，无法定位 apksigner")


def version_sort_key(path: Path) -> tuple[int, ...]:
    parts = path.parent.name.split(".")
    key: list[int] = []
    for part in parts:
        key.append(int(part) if part.isdigit() else -1)
    return tuple(key)


def resolve_apksigner_path(env: dict[str, str]) -> Path:
    sdk_root = resolve_android_sdk_root(env)
    pattern = "build-tools/*/apksigner.bat" if os.name == "nt" else "build-tools/*/apksigner"
    matches = [path for path in sdk_root.glob(pattern) if path.is_file()]
    if not matches:
        raise AndroidReleaseBuildError(f"未在 {sdk_root} 下找到 apksigner")
    return sorted(matches, key=version_sort_key, reverse=True)[0]


def resolve_signing_config(env: dict[str, str]) -> ApkSigningConfig:
    custom_keystore = env.get("WATERAY_ANDROID_KEYSTORE", "").strip()
    if custom_keystore:
        keystore_password = env.get("WATERAY_ANDROID_KEYSTORE_PASSWORD", "").strip()
        key_alias = env.get("WATERAY_ANDROID_KEY_ALIAS", "").strip()
        key_password = env.get("WATERAY_ANDROID_KEY_PASSWORD", "").strip() or keystore_password
        if not keystore_password or not key_alias:
            raise AndroidReleaseBuildError(
                "检测到 WATERAY_ANDROID_KEYSTORE，但缺少签名密码或别名环境变量"
            )
        keystore_path = Path(custom_keystore)
        if not keystore_path.is_file():
            raise AndroidReleaseBuildError(f"自定义 keystore 不存在：{keystore_path}")
        return ApkSigningConfig(
            keystore_path=keystore_path,
            keystore_password=keystore_password,
            key_alias=key_alias,
            key_password=key_password,
            label="custom-keystore",
        )

    debug_keystore = Path(env["ANDROID_USER_HOME"]) / "debug.keystore"
    if not debug_keystore.is_file():
        raise AndroidReleaseBuildError(f"未找到默认 debug.keystore：{debug_keystore}")
    return ApkSigningConfig(
        keystore_path=debug_keystore,
        keystore_password=DEFAULT_DEBUG_KEY_PASSWORD,
        key_alias=DEFAULT_DEBUG_KEY_ALIAS,
        key_password=DEFAULT_DEBUG_KEY_PASSWORD,
        label="debug-keystore",
    )


def run_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    display_command: str | None = None,
) -> int:
    if display_command:
        print(display_command)
    else:
        print(f"执行命令：{' '.join(command)}")
    effective_command = command
    if os.name == "nt" and Path(command[0]).suffix.lower() in {".bat", ".cmd"}:
        effective_command = ["cmd", "/c", *command]
    result = subprocess.run(effective_command, cwd=str(cwd), env=env, check=False)
    return result.returncode


def run_build(env: dict[str, str]) -> int:
    command = [
        resolve_npx_command(),
        "tauri",
        "android",
        "build",
        "--target",
        *TAURI_ANDROID_TARGETS,
        "--apk",
        "--ci",
        "--split-per-abi",
    ]
    return run_command(command, cwd=TAURI_DIR, env=env)


def collect_release_apks() -> list[Path]:
    if not ANDROID_APK_OUTPUT_DIR.exists():
        return []
    return sorted(
        path
        for path in ANDROID_APK_OUTPUT_DIR.glob("**/release/*.apk")
        if path.is_file() and normalize_abi_name(path) in EXPECTED_OUTPUT_ABIS
    )


def normalize_abi_name(path: Path) -> str:
    abi = path.parent.parent.name.strip()
    return abi or "unknown"


def signed_target_file_name(source_path: Path, version: str) -> str:
    abi = normalize_abi_name(source_path)
    return f"Wateray-Android-v{version}-{abi}-release.apk"


def reset_output_dir() -> None:
    if ANDROID_BIN_DIR.exists():
        shutil.rmtree(ANDROID_BIN_DIR)
    ANDROID_BIN_DIR.mkdir(parents=True, exist_ok=True)


def sign_and_copy_release_apks(
    *,
    paths: list[Path],
    version: str,
    apksigner_path: Path,
    signing_config: ApkSigningConfig,
) -> list[dict[str, object]]:
    artifacts: list[dict[str, object]] = []
    for source_path in paths:
        target_path = ANDROID_BIN_DIR / signed_target_file_name(source_path, version)
        if target_path.exists():
            target_path.unlink()

        if "unsigned" in source_path.name.lower():
            sign_command = [
                str(apksigner_path),
                "sign",
                "--ks",
                str(signing_config.keystore_path),
                "--ks-key-alias",
                signing_config.key_alias,
                "--ks-pass",
                f"pass:{signing_config.keystore_password}",
                "--key-pass",
                f"pass:{signing_config.key_password}",
                "--out",
                str(target_path),
                str(source_path),
            ]
            exit_code = run_command(
                sign_command,
                cwd=ROOT_DIR,
                display_command=f"签名 APK：{source_path.name} -> {target_path.name}",
            )
            if exit_code != 0:
                raise AndroidReleaseBuildError(f"APK 签名失败：{source_path.name}")
        else:
            shutil.copy2(source_path, target_path)

        verify_command = [str(apksigner_path), "verify", "--verbose", str(target_path)]
        verify_exit_code = run_command(
            verify_command,
            cwd=ROOT_DIR,
            display_command=f"校验签名：{target_path.name}",
        )
        if verify_exit_code != 0:
            raise AndroidReleaseBuildError(f"APK 签名校验失败：{target_path.name}")

        artifacts.append(
            {
                "abi": normalize_abi_name(source_path),
                "sourceFileName": source_path.name,
                "fileName": target_path.name,
                "relativePath": target_path.relative_to(ROOT_DIR).as_posix(),
                "sizeBytes": target_path.stat().st_size,
                "signed": True,
            }
        )
    return artifacts


def write_build_info(
    *,
    version: str,
    exit_code: int,
    artifacts: list[dict[str, object]],
    env: dict[str, str],
    signing_config: ApkSigningConfig,
) -> None:
    payload = {
        "kind": "android-release-apk",
        "packageName": PACKAGE_NAME,
        "version": version,
        "buildMode": "release",
        "splitPerAbi": True,
        "buildCommandExitCode": exit_code,
        "androidSdkHome": env.get("ANDROID_SDK_HOME", ""),
        "androidUserHome": env.get("ANDROID_USER_HOME", ""),
        "signing": signing_config.label,
        "artifacts": artifacts,
    }
    BUILD_INFO_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def validate_artifacts(artifacts: list[dict[str, object]]) -> None:
    if not artifacts:
        raise AndroidReleaseBuildError("未找到任何 Android release APK 产物")
    actual_abis = {str(item["abi"]) for item in artifacts}
    missing_abis = [abi for abi in EXPECTED_OUTPUT_ABIS if abi not in actual_abis]
    if missing_abis:
        raise AndroidReleaseBuildError(
            "Android release 构建不完整，缺少 ABI 产物：" + ", ".join(missing_abis)
        )


def main() -> int:
    try:
        args = parse_args()
        version = read_version()
        env = prepare_android_environment()
        print_rule_set_sync_summary(ensure_default_rule_sets_synced())
        apksigner_path = resolve_apksigner_path(env)
        signing_config = resolve_signing_config(env)
        reset_output_dir()

        print(f"准备构建 Android release，版本：{version}")
        print(f"ANDROID_SDK_HOME={env.get('ANDROID_SDK_HOME', '')}")
        print(f"ANDROID_USER_HOME={env.get('ANDROID_USER_HOME', '')}")
        print(f"APK 签名工具：{apksigner_path}")
        print(f"签名方式：{signing_config.label}")

        exit_code = 0
        if args.skip_build:
            print("跳过 Android release 构建，直接复用现有 release APK 输出")
        else:
            exit_code = run_build(env)
            if exit_code != 0:
                raise AndroidReleaseBuildError(
                    "Tauri Android release 构建失败，已停止签名与拷贝旧 APK，"
                    "请先检查上方 tauri android build 输出"
                )

        release_apks = collect_release_apks()
        artifacts = sign_and_copy_release_apks(
            paths=release_apks,
            version=version,
            apksigner_path=apksigner_path,
            signing_config=signing_config,
        )
        write_build_info(
            version=version,
            exit_code=exit_code,
            artifacts=artifacts,
            env=env,
            signing_config=signing_config,
        )
        validate_artifacts(artifacts)

        print("Android release 构建完成。")
        for item in artifacts:
            print(f"- {item['relativePath']}")
        return 0
    except AndroidReleaseBuildError as err:
        print(f"构建失败：[android_release] {err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"构建失败：[android_release_unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
