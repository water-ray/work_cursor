from __future__ import annotations

from scripts.build.common.desktop_builder import DesktopBuildTarget


TARGET = DesktopBuildTarget(
    platform_id="linux",
    display_name="Linux 桌面客户端",
    host_platforms=("linux",),
    go_os="linux",
    go_arch="amd64",
    output_dir_name="Wateray-linux",
    daemon_binary_name="waterayd",
    frontend_entry_name="WaterayApp",
    tauri_binary_name="wateray_tauri",
    icon_path="../scripts/build/assets/linux/wateray.png",
    desktop_bundle_supported=True,
)
