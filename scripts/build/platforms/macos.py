from __future__ import annotations

from scripts.build.common.desktop_builder import DesktopBuildTarget


TARGET = DesktopBuildTarget(
    platform_id="macos",
    display_name="macOS 桌面客户端",
    host_platforms=("darwin",),
    electron_platform="darwin",
    electron_arch="arm64",
    go_os="darwin",
    go_arch="arm64",
    output_dir_name="Wateray-macos",
    daemon_binary_name="waterayd",
    frontend_entry_name="WaterayApp.app",
)
