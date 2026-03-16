#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[2]
RENDERER_DIR = ROOT_DIR / "TauriApp" / "src" / "renderer" / "src"
SHARED_DIR = RENDERER_DIR / "shared"
APPS_DESKTOP_DIR = RENDERER_DIR / "apps" / "desktop"
APPS_MOBILE_DIR = RENDERER_DIR / "apps" / "mobile"
CAPABILITIES_PATH = ROOT_DIR / "TauriApp" / "src-tauri" / "capabilities" / "default.json"
KOTLIN_PLUGIN_PATH = (
    ROOT_DIR
    / "TauriApp"
    / "src-tauri"
    / "gen"
    / "android"
    / "app"
    / "src"
    / "main"
    / "java"
    / "com"
    / "wateray"
    / "desktop"
    / "mobilehost"
    / "MobileHostPlugin.kt"
)
TASKS_PATH = ROOT_DIR / ".vscode" / "tasks.json"
CONTRACT_SPEC_PATH = ROOT_DIR / "scripts" / "codegen" / "platform_contracts.json"
CODEGEN_SCRIPT_PATH = ROOT_DIR / "scripts" / "codegen" / "generate_platform_contracts.py"

IMPORT_PATTERN = re.compile(r"""(?:from|import\()\s*['"](?P<path>[^'"]+)['"]""")
DIRECT_GLOBAL_PATTERN = re.compile(r"window\.wateray(?:Desktop|Platform)")


class ValidationError(RuntimeError):
    pass


def iter_code_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.suffix in {".ts", ".tsx"})


def normalize_import_path(import_path: str) -> str:
    return import_path.replace("\\", "/")


def validate_import_boundaries() -> None:
    errors: list[str] = []

    def check_no_cross_imports(source_dir: Path, forbidden_tokens: tuple[str, ...], label: str) -> None:
        for path in iter_code_files(source_dir):
            text = path.read_text(encoding="utf-8")
            for match in IMPORT_PATTERN.finditer(text):
                import_path = normalize_import_path(match.group("path"))
                if any(token in import_path for token in forbidden_tokens):
                    errors.append(f"{label} 发现跨层引用：{path.relative_to(ROOT_DIR)} -> {import_path}")

    check_no_cross_imports(
        SHARED_DIR,
        ("/apps/desktop", "/apps/mobile", "/desktop_host", "/mobile_host"),
        "shared",
    )
    check_no_cross_imports(APPS_DESKTOP_DIR, ("/apps/mobile",), "apps/desktop")
    check_no_cross_imports(APPS_MOBILE_DIR, ("/apps/desktop",), "apps/mobile")

    if errors:
        raise ValidationError("\n".join(errors))


def validate_no_direct_globals() -> None:
    errors: list[str] = []
    for relative_dir in ("pages", "hooks", "components", "apps", "shared"):
        root = RENDERER_DIR / relative_dir
        for path in iter_code_files(root):
            text = path.read_text(encoding="utf-8")
            if DIRECT_GLOBAL_PATTERN.search(text):
                errors.append(f"禁止在 UI/Hook/Shared 直接访问全局平台对象：{path.relative_to(ROOT_DIR)}")
    if errors:
        raise ValidationError("\n".join(errors))


def validate_codegen_is_fresh() -> None:
    result = subprocess.run(
        [sys.executable, str(CODEGEN_SCRIPT_PATH), "--check"],
        cwd=str(ROOT_DIR),
        check=False,
    )
    if result.returncode != 0:
        raise ValidationError("平台契约生成物已过期，请先重新生成")


def validate_mobile_host_permissions() -> None:
    spec = json.loads(CONTRACT_SPEC_PATH.read_text(encoding="utf-8"))
    capabilities = json.loads(CAPABILITIES_PATH.read_text(encoding="utf-8"))
    permissions = {
        item
        for item in capabilities.get("permissions", [])
        if isinstance(item, str)
    }
    missing = [
        command["permission"]
        for command in spec["mobileHost"]["commands"]
        if command["permission"] not in permissions
    ]
    if missing:
        raise ValidationError("default.json 缺少 mobile host 权限：" + ", ".join(missing))


def validate_mobile_host_kotlin_commands() -> None:
    spec = json.loads(CONTRACT_SPEC_PATH.read_text(encoding="utf-8"))
    text = KOTLIN_PLUGIN_PATH.read_text(encoding="utf-8")
    missing = []
    for command in spec["mobileHost"]["commands"]:
        signature = f"fun {command['pluginCommand']}"
        if signature not in text:
            missing.append(command["pluginCommand"])
    if missing:
        raise ValidationError("Android MobileHostPlugin 缺少命令实现：" + ", ".join(missing))


def validate_tasks_semantics() -> None:
    text = TASKS_PATH.read_text(encoding="utf-8")
    banned_labels = (
        "桌面：构建：Windows",
        "桌面：构建：Linux",
        "桌面：构建：macOS",
        "桌面：构建：当前宿主",
        "移动：构建：Android release",
    )
    matched = [label for label in banned_labels if label in text]
    if matched:
        raise ValidationError("tasks.json 仍存在旧平台语义任务：" + ", ".join(matched))


def main() -> int:
    try:
        validate_import_boundaries()
        validate_no_direct_globals()
        validate_codegen_is_fresh()
        validate_mobile_host_permissions()
        validate_mobile_host_kotlin_commands()
        validate_tasks_semantics()
        print("平台边界校验通过")
        return 0
    except ValidationError as error:
        print(f"校验失败：[platform_boundaries] {error}", file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover
        print(f"校验失败：[platform_boundaries_unexpected] {error}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
