mod desktop_host;
mod mobile_host;
mod platform_contracts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !desktop_host::runtime::ensure_windows_webview_runtime_or_notify() {
        return;
    }

    let app = tauri::Builder::default()
        .manage(desktop_host::runtime::FrontendStartupState::default())
        .manage(desktop_host::runtime::DaemonBaseUrlState::default())
        .manage(desktop_host::runtime::InstalledDesktopAppCandidatesState::default())
        .manage(desktop_host::updates::AppUpdateManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(mobile_host::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let app = app.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        desktop_host::runtime::restore_main_window(app);
    }));
    let app = app.setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            desktop_host::runtime::cleanup_stale_linux_dev_desktop_override();
            desktop_host::runtime::apply_main_window_icon(app.handle());
            desktop_host::runtime::apply_platform_window_chrome(app.handle());
            if desktop_host::runtime::runtime_platform_info().supports_tray {
                if let Err(error) = desktop_host::runtime::ensure_system_tray(app.handle()) {
                    log::error!("failed to initialize system tray: {error}");
                    eprintln!("failed to initialize system tray: {error}");
                }
            }
            desktop_host::runtime::start_frontend_startup_guard(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_host::runtime::runtime_platform_info,
            desktop_host::runtime::ensure_packaged_daemon_running,
            desktop_host::runtime::ensure_macos_packaged_daemon_admin_for_tun,
            desktop_host::runtime::daemon_transport_bootstrap,
            desktop_host::updates::app_update_get_state,
            desktop_host::updates::app_update_check,
            desktop_host::updates::app_update_start_download,
            desktop_host::updates::app_update_install,
            desktop_host::updates::app_update_cancel,
            desktop_host::runtime::linux_sync_system_proxy,
            desktop_host::runtime::window_close_panel_keep_core,
            desktop_host::runtime::window_quit_app,
            desktop_host::runtime::window_quit_all,
            desktop_host::runtime::frontend_ready,
            desktop_host::runtime::frontend_startup_failed,
            desktop_host::runtime::system_read_text_file,
            desktop_host::runtime::system_write_text_file,
            desktop_host::runtime::system_write_temp_text_file,
            desktop_host::runtime::system_get_file_icon_data_url,
            desktop_host::runtime::system_list_installed_app_candidates,
            desktop_host::runtime::system_read_clipboard_file_paths,
            desktop_host::runtime::system_write_clipboard_file,
            mobile_host::mobile_host_get_status,
            mobile_host::mobile_host_bootstrap,
            mobile_host::mobile_host_get_versions,
            mobile_host::mobile_host_list_installed_apps,
            mobile_host::mobile_host_get_installed_app_icon,
            mobile_host::mobile_host_prepare,
            mobile_host::mobile_host_check_config,
            mobile_host::mobile_host_start,
            mobile_host::mobile_host_stop,
            mobile_host::mobile_host_clear_dns_cache,
            mobile_host::mobile_host_probe,
            mobile_host::mobile_host_probe_start,
            mobile_host::mobile_host_probe_cancel,
            mobile_host::mobile_host_get_task_queue,
            mobile_host::mobile_host_switch_selectors,
            mobile_host::mobile_host_dns_health,
            mobile_host::mobile_host_rulesets_status,
            mobile_host::mobile_host_rulesets_update,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = app {
        desktop_host::runtime::show_preinit_startup_error(
            "桌面启动失败",
            &format!(
                "因为桌面宿主初始化失败，前端无法启动。错误代码 TAURI_RUN_FAILED。\n\n详细信息：{error}"
            ),
        );
    }
}
