#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import textwrap
import urllib.request
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.build.common.desktop_builder import build_desktop_target
from scripts.build.common.build_manifest import (
    DESKTOP_BUILD_MANIFEST_NAME,
    LINUX_PACKAGE_MANIFEST_NAME,
    build_desktop_bundle_manifest,
    build_linux_package_manifest,
    manifest_matches,
    write_manifest,
)
from scripts.build.platforms.linux import TARGET as LINUX_TARGET


VERSION_PATH = ROOT_DIR / "VERSION"
BIN_DIR = ROOT_DIR / "Bin"
PACKAGE_OUTPUT_DIR = BIN_DIR / "Wateray-linux-packages"
TEMP_ROOT_DIR = BIN_DIR / ".tmp" / "linux-packages"
APPIMAGETOOL_CACHE_DIR = TEMP_ROOT_DIR / "appimagetool"
LINUX_ASSET_DIR = ROOT_DIR / "scripts" / "build" / "assets" / "linux"
APPIMAGETOOL_DOWNLOAD_URL = (
    "https://github.com/AppImage/appimagetool/releases/download/continuous/"
    "appimagetool-x86_64.AppImage"
)
DEB_PACKAGE_NAME = "wateray"
DEB_INSTALL_DIR = "/opt/wateray"
DEB_DATA_ROOT = "/var/lib/wateray"
HELPER_INSTALL_PATH = "/usr/local/libexec/wateray/wateray-service-helper"
HELPER_ASSET_DIR = "/usr/local/share/wateray/linux"
LINUX_DESKTOP_FILE_NAME = "com.singbox.wateray.desktop"
LEGACY_HELPER_DESKTOP_PATH = "/usr/local/share/applications/wateray.desktop"
HELPER_DESKTOP_PATH = f"/usr/local/share/applications/{LINUX_DESKTOP_FILE_NAME}"
LINUX_DESKTOP_ICON_NAME = "com.singbox.wateray"
HELPER_ICON_PATH = f"/usr/local/share/icons/hicolor/128x128/apps/{LINUX_DESKTOP_ICON_NAME}.png"
LEGACY_HELPER_ICON_PATH = "/usr/local/share/icons/hicolor/128x128/apps/wateray.png"
POLKIT_POLICY_PATH = "/usr/share/polkit-1/actions/net.wateray.daemon.policy"
SERVICE_UNIT_PATH = "/etc/systemd/system/waterayd.service"
APPIMAGE_OUTPUT_NAME_TEMPLATE = "Wateray-linux-v{version}-x86_64.AppImage"
DEB_OUTPUT_NAME_TEMPLATE = "wateray_{version}_amd64.deb"
APPIMAGE_DESKTOP_NAME = LINUX_DESKTOP_FILE_NAME
APPIMAGE_ICON_NAME = f"{LINUX_DESKTOP_ICON_NAME}.png"
APPIMAGE_DIRICON_NAME = ".DirIcon"
APPIMAGE_APPDIR_NAME = "Wateray.AppDir"
DEB_DEPENDS = (
    "systemd, pkexec | policykit-1, libasound2 | libasound2t64, "
    "libatk-bridge2.0-0, libatk1.0-0, libc6, libcairo2, libcups2, "
    "libdbus-1-3, libdrm2, libgbm1, libglib2.0-0, libgtk-3-0, libnspr4, "
    "libnss3, libpango-1.0-0, libx11-6, libx11-xcb1, libxcb-dri3-0, "
    "libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, "
    "libxkbcommon0, libxrandr2, libxshmfence1, libxss1, libxtst6, "
    "xdg-utils, zlib1g"
)
LINUX_HELPER_SOURCE_PATH = LINUX_ASSET_DIR / "wateray-service-helper.sh"
LINUX_DESKTOP_TEMPLATE_PATH = LINUX_ASSET_DIR / "wateray.desktop.template"
LINUX_SERVICE_TEMPLATE_PATH = LINUX_ASSET_DIR / "waterayd.service.template"
LINUX_DEV_SERVICE_TEMPLATE_PATH = LINUX_ASSET_DIR / "waterayd-dev.service.template"
LINUX_POLICY_SOURCE_PATH = LINUX_ASSET_DIR / "net.wateray.daemon.policy"
LINUX_ICON_SOURCE_PATH = LINUX_ASSET_DIR / "wateray.png"


class LinuxPackageError(RuntimeError):
    pass


def print_step(title: str) -> None:
    print(f"\n==> {title}")


def resolve_executable(name: str) -> str:
    return shutil.which(name) or name


def run_command(
    command: list[str],
    cwd: Path,
    env: dict[str, str] | None = None,
) -> None:
    resolved = [resolve_executable(command[0]), *command[1:]]
    print(" ".join(resolved))
    try:
        result = subprocess.run(resolved, cwd=str(cwd), env=env, check=False)
    except FileNotFoundError as err:
        raise LinuxPackageError(f"缺少命令：{command[0]}") from err
    if result.returncode != 0:
        raise LinuxPackageError(f"命令执行失败：{' '.join(command)}")


def ensure_linux_host() -> None:
    if sys.platform != "linux":
        raise LinuxPackageError(f"Linux 安装包只能在 Linux 宿主机构建，当前为 {sys.platform}")


def read_version() -> str:
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    if not version:
        raise LinuxPackageError("VERSION 为空，无法生成 Linux 安装包")
    return version


def ensure_file_exists(path: Path, label: str) -> None:
    if path.exists() and path.is_file():
        return
    raise LinuxPackageError(f"{label} 不存在：{path}")


def ensure_dir_exists(path: Path, label: str) -> None:
    if path.exists() and path.is_dir():
        return
    raise LinuxPackageError(f"{label} 不存在：{path}")


def ensure_executable_file(path: Path, label: str) -> None:
    ensure_file_exists(path, label)
    if os.access(path, os.X_OK):
        return
    make_executable(path)


def expected_linux_package_paths(version: str) -> list[Path]:
    return [
        PACKAGE_OUTPUT_DIR / DEB_OUTPUT_NAME_TEMPLATE.format(version=version),
        PACKAGE_OUTPUT_DIR / APPIMAGE_OUTPUT_NAME_TEMPLATE.format(version=version),
    ]


def linux_bundle_is_current(source_dir: Path, version: str) -> bool:
    required_paths = [
        source_dir / "WaterayApp",
        source_dir / "core" / "waterayd",
    ]
    if not all(path.exists() for path in required_paths):
        return False
    expected_manifest = build_desktop_bundle_manifest(
        LINUX_TARGET.platform_id,
        version,
        LINUX_TARGET.output_dir_name,
    )
    return manifest_matches(source_dir / DESKTOP_BUILD_MANIFEST_NAME, expected_manifest)


def linux_packages_are_current(version: str) -> bool:
    if not linux_bundle_is_current(LINUX_TARGET.bin_dir, version):
        return False
    expected_assets = expected_linux_package_paths(version)
    if not all(path.exists() for path in expected_assets):
        return False
    bundle_manifest = build_desktop_bundle_manifest(
        LINUX_TARGET.platform_id,
        version,
        LINUX_TARGET.output_dir_name,
    )
    expected_manifest = build_linux_package_manifest(
        version,
        str(bundle_manifest.get("sourceHash", "")).strip(),
        [path.name for path in expected_assets],
    )
    return manifest_matches(PACKAGE_OUTPUT_DIR / LINUX_PACKAGE_MANIFEST_NAME, expected_manifest)


def validate_linux_bundle(source_dir: Path, version: str) -> None:
    ensure_dir_exists(source_dir, "Linux 客户端目录产物")
    ensure_executable_file(source_dir / "WaterayApp", "Linux 前端可执行文件")
    ensure_executable_file(source_dir / "core" / "waterayd", "Linux 内核可执行文件")
    ensure_executable_file(LINUX_HELPER_SOURCE_PATH, "Linux root helper 脚本")
    ensure_file_exists(LINUX_DESKTOP_TEMPLATE_PATH, "Linux desktop 模板")
    ensure_file_exists(LINUX_SERVICE_TEMPLATE_PATH, "Linux packaged service 模板")
    ensure_file_exists(LINUX_DEV_SERVICE_TEMPLATE_PATH, "Linux dev service 模板")
    ensure_file_exists(LINUX_POLICY_SOURCE_PATH, "Linux polkit policy")
    ensure_file_exists(LINUX_ICON_SOURCE_PATH, "Linux 图标资源")


def ensure_linux_bundle(skip_build: bool, version: str) -> Path:
    source_dir = LINUX_TARGET.bin_dir
    if skip_build:
        print_step("复用现有 Linux 目录产物")
        if not linux_bundle_is_current(source_dir, version):
            raise LinuxPackageError(
                "现有 Linux 目录产物不是当前 VERSION/源码对应的最新构建，请先重新构建或取消 --skip-build"
            )
    else:
        print_step("构建 Linux 目录产物")
        build_exit_code = build_desktop_target(LINUX_TARGET)
        if build_exit_code != 0:
            raise LinuxPackageError(
                f"Linux 目录产物构建失败，请先修复构建问题（exit_code={build_exit_code}）"
            )
    validate_linux_bundle(source_dir, version)
    return source_dir


def reset_directory(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def make_executable(path: Path) -> None:
    current_mode = path.stat().st_mode
    path.chmod(current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def write_text_file(path: Path, content: str, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def render_linux_desktop_entry(exec_value: str, icon_value: str) -> str:
    template = LINUX_DESKTOP_TEMPLATE_PATH.read_text(encoding="utf-8")
    return (
        template.replace("__WATERAY_EXEC__", exec_value).replace("__WATERAY_ICON__", icon_value).strip()
        + "\n"
    )


def render_linux_service_unit(binary_path: str, working_dir: str, install_dir: str, data_root: str) -> str:
    template = LINUX_SERVICE_TEMPLATE_PATH.read_text(encoding="utf-8")
    return (
        template.replace("__WATERAY_BINARY__", binary_path)
        .replace("__WATERAY_WORKING_DIR__", working_dir)
        .replace("__WATERAY_INSTALL_DIR__", install_dir)
        .replace("__WATERAY_DATA_ROOT__", data_root)
        .strip()
        + "\n"
    )


def calculate_installed_size_kib(path: Path) -> int:
    total_size = 0
    for entry in path.rglob("*"):
        if entry.is_file() and not entry.is_symlink():
            total_size += entry.stat().st_size
    return max(1, (total_size + 1023) // 1024)


def build_deb_control(version: str, installed_size_kib: int) -> str:
    return textwrap.dedent(
        f"""\
        Package: {DEB_PACKAGE_NAME}
        Version: {version}
        Section: net
        Priority: optional
        Architecture: amd64
        Maintainer: Wateray Team <noreply@wateray.invalid>
        Homepage: https://wateray.net
        Installed-Size: {installed_size_kib}
        Depends: {DEB_DEPENDS}
        Description: Wateray desktop client
         Wateray is a Tauri + Go VPN desktop client.
         On Linux it keeps the core daemon in a privileged systemd service
         so the Tauri UI can keep running as a normal desktop user.
        """
    )


def build_deb_postinst() -> str:
    return textwrap.dedent(
        f"""\
        #!/bin/sh
        set -e

        refresh_desktop_cache() {{
          if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database /usr/local/share/applications >/dev/null 2>&1 || true
          fi
          if command -v gtk-update-icon-cache >/dev/null 2>&1; then
            gtk-update-icon-cache -q /usr/local/share/icons/hicolor >/dev/null 2>&1 || true
          fi
        }}

        case "$1" in
          configure)
            if command -v systemctl >/dev/null 2>&1; then
              systemctl daemon-reload >/dev/null 2>&1 || true
              systemctl enable waterayd.service >/dev/null 2>&1 || true
              if systemctl is-active --quiet waterayd.service; then
                systemctl restart waterayd.service
              else
                systemctl start waterayd.service
              fi
            fi
            rm -f "{LEGACY_HELPER_DESKTOP_PATH}"
            refresh_desktop_cache
            ;;
        esac

        exit 0
        """
    )


def build_deb_prerm() -> str:
    return textwrap.dedent(
        """\
        #!/bin/sh
        set -e

        case "$1" in
          remove|upgrade|deconfigure)
            if command -v systemctl >/dev/null 2>&1; then
              systemctl disable --now waterayd.service >/dev/null 2>&1 || true
              systemctl daemon-reload >/dev/null 2>&1 || true
            fi
            ;;
        esac

        exit 0
        """
    )


def build_deb_postrm() -> str:
    return textwrap.dedent(
        f"""\
        #!/bin/sh
        set -e

        cleanup_empty_dirs() {{
          rmdir "{HELPER_ASSET_DIR}" >/dev/null 2>&1 || true
          rmdir /usr/local/libexec/wateray >/dev/null 2>&1 || true
          rmdir /usr/local/share/wateray >/dev/null 2>&1 || true
        }}

        refresh_desktop_cache() {{
          if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database /usr/local/share/applications >/dev/null 2>&1 || true
          fi
          if command -v gtk-update-icon-cache >/dev/null 2>&1; then
            gtk-update-icon-cache -q /usr/local/share/icons/hicolor >/dev/null 2>&1 || true
          fi
        }}

        case "$1" in
          remove|purge)
            rm -f "{LEGACY_HELPER_DESKTOP_PATH}"
            rm -f "{LEGACY_HELPER_ICON_PATH}"
            if command -v systemctl >/dev/null 2>&1; then
              systemctl daemon-reload >/dev/null 2>&1 || true
            fi
            refresh_desktop_cache
            cleanup_empty_dirs
            ;;
        esac

        if [ "$1" = "purge" ]; then
          rm -rf "{DEB_DATA_ROOT}"
        fi

        exit 0
        """
    )


def stage_deb_system_assets(package_root: Path) -> None:
    helper_target = package_root / Path(HELPER_INSTALL_PATH).relative_to("/")
    helper_asset_dir = package_root / Path(HELPER_ASSET_DIR).relative_to("/")
    desktop_target = package_root / Path(HELPER_DESKTOP_PATH).relative_to("/")
    icon_target = package_root / Path(HELPER_ICON_PATH).relative_to("/")
    policy_target = package_root / Path(POLKIT_POLICY_PATH).relative_to("/")
    service_target = package_root / Path(SERVICE_UNIT_PATH).relative_to("/")

    helper_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(LINUX_HELPER_SOURCE_PATH, helper_target)
    make_executable(helper_target)

    helper_asset_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(LINUX_SERVICE_TEMPLATE_PATH, helper_asset_dir / LINUX_SERVICE_TEMPLATE_PATH.name)
    shutil.copy2(LINUX_DEV_SERVICE_TEMPLATE_PATH, helper_asset_dir / LINUX_DEV_SERVICE_TEMPLATE_PATH.name)
    shutil.copy2(LINUX_DESKTOP_TEMPLATE_PATH, helper_asset_dir / LINUX_DESKTOP_TEMPLATE_PATH.name)
    shutil.copy2(LINUX_POLICY_SOURCE_PATH, helper_asset_dir / LINUX_POLICY_SOURCE_PATH.name)
    shutil.copy2(LINUX_ICON_SOURCE_PATH, helper_asset_dir / LINUX_ICON_SOURCE_PATH.name)

    write_text_file(
        service_target,
        render_linux_service_unit(
            binary_path=f"{DEB_INSTALL_DIR}/core/waterayd",
            working_dir=f"{DEB_INSTALL_DIR}/core",
            install_dir=DEB_INSTALL_DIR,
            data_root=DEB_DATA_ROOT,
        ),
    )
    write_text_file(
        desktop_target,
        render_linux_desktop_entry(f"{DEB_INSTALL_DIR}/WaterayApp", LINUX_DESKTOP_ICON_NAME),
    )
    icon_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(LINUX_ICON_SOURCE_PATH, icon_target)
    policy_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(LINUX_POLICY_SOURCE_PATH, policy_target)


def build_deb_package(source_dir: Path, version: str, output_dir: Path) -> Path:
    if shutil.which("dpkg-deb") is None:
        raise LinuxPackageError("缺少 dpkg-deb，无法生成 .deb")
    print_step("生成 Debian/Ubuntu .deb")
    work_root = TEMP_ROOT_DIR / "deb"
    package_root = work_root / f"{DEB_PACKAGE_NAME}-{version}"
    reset_directory(package_root)

    install_root = package_root / Path(DEB_INSTALL_DIR).relative_to("/")
    shutil.copytree(source_dir, install_root, symlinks=True, dirs_exist_ok=True)
    stage_deb_system_assets(package_root)

    debian_dir = package_root / "DEBIAN"
    debian_dir.mkdir(parents=True, exist_ok=True)
    write_text_file(
        debian_dir / "control",
        build_deb_control(version, calculate_installed_size_kib(package_root)),
    )
    write_text_file(debian_dir / "postinst", build_deb_postinst(), executable=True)
    write_text_file(debian_dir / "prerm", build_deb_prerm(), executable=True)
    write_text_file(debian_dir / "postrm", build_deb_postrm(), executable=True)

    output_path = output_dir / DEB_OUTPUT_NAME_TEMPLATE.format(version=version)
    if output_path.exists():
        output_path.unlink()
    run_command(
        ["dpkg-deb", "--build", "--root-owner-group", str(package_root), str(output_path)],
        cwd=ROOT_DIR,
    )
    return output_path


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "wateray-linux-packager"})
    try:
        with urllib.request.urlopen(request) as response, destination.open("wb") as output:
            shutil.copyfileobj(response, output)
    except Exception as err:  # pragma: no cover
        raise LinuxPackageError(f"下载失败：{url}") from err


def resolve_appimagetool(override: str) -> Path:
    if override:
        candidate = Path(override).expanduser().resolve()
        if not candidate.exists():
            raise LinuxPackageError(f"指定的 appimagetool 不存在：{candidate}")
        return candidate

    from_path = shutil.which("appimagetool")
    if from_path:
        return Path(from_path).resolve()

    cached_path = APPIMAGETOOL_CACHE_DIR / "appimagetool-x86_64.AppImage"
    if not cached_path.exists():
        print_step("下载 appimagetool")
        download_file(APPIMAGETOOL_DOWNLOAD_URL, cached_path)
        make_executable(cached_path)
    return cached_path


def build_appimage_apprun(version: str) -> str:
    return "\n".join(
        [
            "#!/bin/sh",
            "set -eu",
            "",
            'appdir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
            'data_home="${XDG_DATA_HOME:-$HOME/.local/share}"',
            'install_root="$data_home/wateray/appimage"',
            'current_dir="$install_root/current"',
            'staging_dir="$install_root/.current.$$"',
            f'source_version="{version}"',
            'target_version=""',
            'version_marker=".wateray-appimage-version"',
            "",
            'if [ -f "$current_dir/$version_marker" ]; then',
            "  target_version=$(tr -d '\\n' < \"$current_dir/$version_marker\")",
            "fi",
            "",
            'if [ ! -x "$current_dir/WaterayApp" ] || [ "$source_version" != "$target_version" ]; then',
            '  rm -rf "$staging_dir"',
            '  mkdir -p "$staging_dir"',
            '  cp -a "$appdir/." "$staging_dir/"',
            "  printf '%s\\n' \"$source_version\" > \"$staging_dir/$version_marker\"",
            '  rm -rf "$current_dir"',
            '  mv "$staging_dir" "$current_dir"',
            "fi",
            "",
            'export WATERAY_APP_INSTALL_DIR="$current_dir"',
            'exec "$current_dir/WaterayApp" "$@"',
            "",
        ]
    )


def build_appimage_package(source_dir: Path, version: str, output_dir: Path, appimagetool_path: Path) -> Path:
    print_step("生成 AppImage")
    appdir_root = TEMP_ROOT_DIR / "appimage" / APPIMAGE_APPDIR_NAME
    reset_directory(appdir_root)
    shutil.copytree(source_dir, appdir_root, symlinks=True, dirs_exist_ok=True)

    desktop_content = render_linux_desktop_entry("WaterayApp", LINUX_DESKTOP_ICON_NAME)
    write_text_file(appdir_root / APPIMAGE_DESKTOP_NAME, desktop_content)
    shutil.copy2(LINUX_ICON_SOURCE_PATH, appdir_root / APPIMAGE_ICON_NAME)
    shutil.copy2(LINUX_ICON_SOURCE_PATH, appdir_root / APPIMAGE_DIRICON_NAME)
    write_text_file(appdir_root / "AppRun", build_appimage_apprun(version), executable=True)

    output_path = output_dir / APPIMAGE_OUTPUT_NAME_TEMPLATE.format(version=version)
    if output_path.exists():
        output_path.unlink()

    env = os.environ.copy()
    env["ARCH"] = "x86_64"
    env["APPIMAGE_EXTRACT_AND_RUN"] = "1"
    env["NO_APPSTREAM"] = "1"
    env["VERSION"] = version
    run_command([str(appimagetool_path), str(appdir_root), str(output_path)], cwd=ROOT_DIR, env=env)
    make_executable(output_path)
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建 Wateray Linux 的 .deb 与 AppImage 安装包")
    parser.add_argument(
        "--format",
        choices=("all", "deb", "appimage"),
        default="all",
        help="输出格式：all / deb / appimage，默认 all",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="跳过基础目录构建，直接复用已有的 Bin/Wateray-linux",
    )
    parser.add_argument(
        "--appimagetool",
        default="",
        help="显式指定本地 appimagetool 路径；为空时优先使用 PATH，否则自动下载",
    )
    return parser.parse_args()


def print_summary(version: str, artifacts: list[Path]) -> None:
    print_step("Linux 安装包完成")
    print(f"- 原始目录产物：{LINUX_TARGET.bin_dir}")
    print(f"- 安装包输出：{PACKAGE_OUTPUT_DIR}")
    print(f"- 统一版本：{version}")
    for artifact in artifacts:
        print(f"- 产物：{artifact.name}")


def main() -> int:
    args = parse_args()
    try:
        ensure_linux_host()
        version = read_version()
        source_dir = ensure_linux_bundle(skip_build=args.skip_build, version=version)

        reset_directory(PACKAGE_OUTPUT_DIR)
        artifacts: list[Path] = []

        if args.format in ("all", "deb"):
            artifacts.append(build_deb_package(source_dir, version, PACKAGE_OUTPUT_DIR))
        if args.format in ("all", "appimage"):
            appimagetool_path = resolve_appimagetool(args.appimagetool)
            artifacts.append(build_appimage_package(source_dir, version, PACKAGE_OUTPUT_DIR, appimagetool_path))

        bundle_manifest = build_desktop_bundle_manifest(
            LINUX_TARGET.platform_id,
            version,
            LINUX_TARGET.output_dir_name,
        )
        write_manifest(
            PACKAGE_OUTPUT_DIR / LINUX_PACKAGE_MANIFEST_NAME,
            build_linux_package_manifest(
                version,
                str(bundle_manifest.get("sourceHash", "")).strip(),
                [artifact.name for artifact in artifacts],
            ),
        )

        print_summary(version, artifacts)
        return 0
    except LinuxPackageError as err:
        print(f"\n构建失败：[linux_package] {err}", file=sys.stderr)
        return 1
    except Exception as err:  # pragma: no cover
        print(f"\n构建失败：[linux_package_unexpected] {err}", file=sys.stderr)
        return 99


if __name__ == "__main__":
    raise SystemExit(main())
