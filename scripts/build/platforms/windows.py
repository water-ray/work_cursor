from __future__ import annotations

from scripts.build.common.desktop_builder import DesktopBuildTarget


TARGET = DesktopBuildTarget(
    platform_id="windows",
    display_name="Windows 桌面客户端",
    host_platforms=("win32",),
    go_os="windows",
    go_arch="amd64",
    output_dir_name="Wateray-windows",
    daemon_binary_name="WaterayServer.exe",
    frontend_entry_name="WaterayApp.exe",
    tauri_binary_name="wateray_tauri.exe",
    icon_path="ico.ico",
    needs_windows_manifest=True,
    desktop_bundle_supported=True,
)
