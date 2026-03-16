#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]
SPEC_PATH = ROOT_DIR / "scripts" / "codegen" / "platform_contracts.json"
TS_OUTPUT_PATH = ROOT_DIR / "TauriApp" / "src" / "renderer" / "src" / "platform" / "contracts" / "generated.ts"
RUST_OUTPUT_PATH = ROOT_DIR / "TauriApp" / "src-tauri" / "src" / "platform_contracts" / "generated.rs"
RUST_BUILD_OUTPUT_PATH = ROOT_DIR / "TauriApp" / "src-tauri" / "platform_contracts" / "generated_build.rs"


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


class ContractGenerationError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate shared platform contract artifacts")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check whether generated artifacts are up to date without writing files",
    )
    return parser.parse_args()


def load_spec() -> dict[str, Any]:
    try:
        return json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ContractGenerationError(f"未找到平台契约规范文件：{SPEC_PATH}") from error
    except json.JSONDecodeError as error:
        raise ContractGenerationError(f"平台契约规范 JSON 非法：{error}") from error


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def render_ts_runtime_platform_contracts(platforms: dict[str, Any]) -> str:
    lines = [
        "export type RuntimePlatformContract = {",
        '  kind: "desktop" | "android" | "ios";',
        "  isMobile: boolean;",
        "  supportsWindowControls: boolean;",
        "  supportsTray: boolean;",
        "  supportsPackagedDaemon: boolean;",
        "  supportsSystemProxyMode: boolean;",
        "  supportsLocalFileAccess: boolean;",
        "  supportsInAppUpdates: boolean;",
        "  supportsMobileVpnHost: boolean;",
        "  requiresSandboxDataRoot: boolean;",
        "};",
        "",
        "export const runtimePlatformContracts = {",
    ]
    for key, payload in platforms.items():
        lines.extend(
            [
                f"  {key}: {{",
                f'    kind: "{payload["kind"]}",',
                f'    isMobile: {str(payload["isMobile"]).lower()},',
                f'    supportsWindowControls: {str(payload["supportsWindowControls"]).lower()},',
                f'    supportsTray: {str(payload["supportsTray"]).lower()},',
                f'    supportsPackagedDaemon: {str(payload["supportsPackagedDaemon"]).lower()},',
                f'    supportsSystemProxyMode: {str(payload["supportsSystemProxyMode"]).lower()},',
                f'    supportsLocalFileAccess: {str(payload["supportsLocalFileAccess"]).lower()},',
                f'    supportsInAppUpdates: {str(payload["supportsInAppUpdates"]).lower()},',
                f'    supportsMobileVpnHost: {str(payload["supportsMobileVpnHost"]).lower()},',
                f'    requiresSandboxDataRoot: {str(payload["requiresSandboxDataRoot"]).lower()},',
                "  },",
            ]
        )
    lines.extend(
        [
            "} as const satisfies Record<string, RuntimePlatformContract>;",
            "",
            "export type RuntimePlatformContractKind = keyof typeof runtimePlatformContracts;",
            "",
            "export function resolveRuntimePlatformContract(kind: string): RuntimePlatformContract {",
            "  switch (kind) {",
            '    case "android":',
            "      return runtimePlatformContracts.android;",
            '    case "ios":',
            "      return runtimePlatformContracts.ios;",
            "    default:",
            "      return runtimePlatformContracts.desktop;",
            "  }",
            "}",
        ]
    )
    return "\n".join(lines)


def render_ts_mobile_host_contract(mobile_host: dict[str, Any]) -> str:
    command_lines = ["export const mobileHostContract = {", f'  pluginName: "{mobile_host["pluginName"]}",']
    command_lines.append(
        f'  androidPluginIdentifier: "{mobile_host["androidPluginIdentifier"]}",'
    )
    command_lines.append(
        f'  androidPluginClass: "{mobile_host["androidPluginClass"]}",'
    )
    command_lines.append("  commands: {")
    for command in mobile_host["commands"]:
        command_lines.extend(
            [
                f'    {command["key"]}: {{',
                f'      invokeCommand: "{command["invokeCommand"]}",',
                f'      pluginCommand: "{command["pluginCommand"]}",',
                f'      permission: "{command["permission"]}",',
                "    },",
            ]
        )
    command_lines.extend(
        [
            "  },",
            "} as const;",
            "",
            "export type MobileHostCommandKey = keyof typeof mobileHostContract.commands;",
        ]
    )
    return "\n".join(command_lines)


def render_typescript(spec: dict[str, Any]) -> str:
    runtime_app_targets = spec["runtimeAppTargets"]
    lines = [
        "// This file is auto-generated by scripts/codegen/generate_platform_contracts.py.",
        "// Do not edit manually.",
        "",
        f'export const runtimeAppTargets = {json.dumps(runtime_app_targets)} as const;',
        "export type RuntimeAppTarget = (typeof runtimeAppTargets)[number];",
        "",
        render_ts_runtime_platform_contracts(spec["runtimePlatforms"]),
        "",
        render_ts_mobile_host_contract(spec["mobileHost"]),
        "",
    ]
    return "\n".join(lines)


def render_rust_runtime_platform_contracts(platforms: dict[str, Any]) -> str:
    lines = [
        "#[derive(Clone, Copy, Debug)]",
        "pub struct RuntimePlatformContract {",
        "    pub kind: &'static str,",
        "    pub is_mobile: bool,",
        "    pub supports_window_controls: bool,",
        "    pub supports_tray: bool,",
        "    pub supports_packaged_daemon: bool,",
        "    pub supports_system_proxy_mode: bool,",
        "    pub supports_local_file_access: bool,",
        "    pub supports_in_app_updates: bool,",
        "    pub supports_mobile_vpn_host: bool,",
        "    pub requires_sandbox_data_root: bool,",
        "}",
        "",
    ]
    for key, payload in platforms.items():
        const_name = f"RUNTIME_PLATFORM_{key.upper()}"
        lines.extend(
            [
                f"pub const {const_name}: RuntimePlatformContract = RuntimePlatformContract {{",
                f'    kind: "{payload["kind"]}",',
                f'    is_mobile: {str(payload["isMobile"]).lower()},',
                f'    supports_window_controls: {str(payload["supportsWindowControls"]).lower()},',
                f'    supports_tray: {str(payload["supportsTray"]).lower()},',
                f'    supports_packaged_daemon: {str(payload["supportsPackagedDaemon"]).lower()},',
                f'    supports_system_proxy_mode: {str(payload["supportsSystemProxyMode"]).lower()},',
                f'    supports_local_file_access: {str(payload["supportsLocalFileAccess"]).lower()},',
                f'    supports_in_app_updates: {str(payload["supportsInAppUpdates"]).lower()},',
                f'    supports_mobile_vpn_host: {str(payload["supportsMobileVpnHost"]).lower()},',
                f'    requires_sandbox_data_root: {str(payload["requiresSandboxDataRoot"]).lower()},',
                "};",
                "",
            ]
        )
    lines.extend(
        [
            "pub fn resolve_runtime_platform_contract(kind: &str) -> RuntimePlatformContract {",
            "    match kind {",
            '        "android" => RUNTIME_PLATFORM_ANDROID,',
            '        "ios" => RUNTIME_PLATFORM_IOS,',
            "        _ => RUNTIME_PLATFORM_DESKTOP,",
            "    }",
            "}",
        ]
    )
    return "\n".join(lines)


def render_rust_mobile_host_contract(mobile_host: dict[str, Any]) -> str:
    lines = [
        f'pub const MOBILE_HOST_PLUGIN_NAME: &str = "{mobile_host["pluginName"]}";',
        f'pub const MOBILE_HOST_ANDROID_PLUGIN_IDENTIFIER: &str = "{mobile_host["androidPluginIdentifier"]}";',
        f'pub const MOBILE_HOST_ANDROID_PLUGIN_CLASS: &str = "{mobile_host["androidPluginClass"]}";',
        "",
    ]
    plugin_commands: list[str] = []
    permissions: list[str] = []
    for command in mobile_host["commands"]:
        upper_key = command["key"]
        constant_key = []
        for char in upper_key:
            if char.isupper():
                constant_key.append("_")
            constant_key.append(char.upper())
        suffix = "".join(constant_key).lstrip("_")
        lines.append(
            f'pub const MOBILE_HOST_{suffix}_INVOKE_COMMAND: &str = "{command["invokeCommand"]}";'
        )
        lines.append(
            f'pub const MOBILE_HOST_{suffix}_PLUGIN_COMMAND: &str = "{command["pluginCommand"]}";'
        )
        lines.append(
            f'pub const MOBILE_HOST_{suffix}_PERMISSION: &str = "{command["permission"]}";'
        )
        lines.append("")
        plugin_commands.append(command["pluginCommand"])
        permissions.append(command["permission"])
    plugin_command_list = ", ".join(f'"{value}"' for value in plugin_commands)
    permission_list = ", ".join(f'"{value}"' for value in permissions)
    lines.extend(
        [
            f"pub const MOBILE_HOST_PLUGIN_COMMANDS: &[&str] = &[{plugin_command_list}];",
            f"pub const MOBILE_HOST_PERMISSIONS: &[&str] = &[{permission_list}];",
        ]
    )
    return "\n".join(lines)


def render_rust_runtime(spec: dict[str, Any]) -> str:
    lines = [
        "// This file is auto-generated by scripts/codegen/generate_platform_contracts.py.",
        "// Do not edit manually.",
        "#![allow(dead_code)]",
        "",
        render_rust_runtime_platform_contracts(spec["runtimePlatforms"]),
        "",
        render_rust_mobile_host_contract(spec["mobileHost"]),
        "",
    ]
    return "\n".join(lines)


def render_rust_build(spec: dict[str, Any]) -> str:
    plugin_commands = ", ".join(
        f'"{command["pluginCommand"]}"' for command in spec["mobileHost"]["commands"]
    )
    return "\n".join(
        [
            "// This file is auto-generated by scripts/codegen/generate_platform_contracts.py.",
            "// Do not edit manually.",
            "",
            f'pub const MOBILE_HOST_PLUGIN_NAME: &str = "{spec["mobileHost"]["pluginName"]}";',
            f"pub const MOBILE_HOST_PLUGIN_COMMANDS: &[&str] = &[{plugin_commands}];",
            "",
        ]
    )


def write_or_check(path: Path, content: str, check: bool) -> bool:
    ensure_parent(path)
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == content:
        return False
    if check:
        return True
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def main() -> int:
    try:
        args = parse_args()
        spec = load_spec()
        dirty_paths: list[Path] = []

        for path, content in (
            (TS_OUTPUT_PATH, render_typescript(spec)),
            (RUST_OUTPUT_PATH, render_rust_runtime(spec)),
            (RUST_BUILD_OUTPUT_PATH, render_rust_build(spec)),
        ):
            changed = write_or_check(path, content, args.check)
            if changed:
                dirty_paths.append(path)

        if args.check:
            if dirty_paths:
                for path in dirty_paths:
                    print(f"平台契约生成物过期：{path.relative_to(ROOT_DIR)}", file=sys.stderr)
                return 1
            print("平台契约生成物已是最新")
            return 0

        if dirty_paths:
            for path in dirty_paths:
                print(f"已更新：{path.relative_to(ROOT_DIR)}")
        else:
            print("平台契约生成物无需更新")
        return 0
    except ContractGenerationError as error:
        print(f"生成失败：[platform_contracts] {error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover
        print(f"生成失败：[platform_contracts_unexpected] {error}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
