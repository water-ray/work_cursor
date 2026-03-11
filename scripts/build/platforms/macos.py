from __future__ import annotations

from scripts.build.common.desktop_builder import DesktopBuildTarget


TARGET = DesktopBuildTarget(
    platform_id="macos",
    display_name="macOS 桌面客户端",
    host_platforms=("darwin",),
    go_os="darwin",
    go_arch="arm64",
    output_dir_name="Wateray-macos",
    daemon_binary_name="waterayd",
    frontend_entry_name="WaterayApp.app",
    tauri_binary_name="wateray_tauri",
)
