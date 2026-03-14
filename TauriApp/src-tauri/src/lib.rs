mod app_update;
mod backend;
mod mobile_host;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !backend::ensure_windows_webview_runtime_or_notify() {
        return;
    }

    let app = tauri::Builder::default()
        .manage(backend::FrontendStartupState::default())
        .manage(app_update::AppUpdateManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(mobile_host::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            backend::cleanup_stale_linux_dev_desktop_override();
            backend::apply_main_window_icon(app.handle());
            if backend::runtime_platform_info().supports_tray {
                if let Err(error) = backend::ensure_system_tray(app.handle()) {
                    log::error!("failed to initialize system tray: {error}");
                    eprintln!("failed to initialize system tray: {error}");
                }
            }
            backend::start_frontend_startup_guard(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend::runtime_platform_info,
            backend::ensure_packaged_daemon_running,
            app_update::app_update_get_state,
            app_update::app_update_check,
            app_update::app_update_start_download,
            app_update::app_update_install,
            app_update::app_update_cancel,
            backend::linux_sync_system_proxy,
            backend::window_close_panel_keep_core,
            backend::window_quit_app,
            backend::window_quit_all,
            backend::frontend_ready,
            backend::frontend_startup_failed,
            backend::system_read_text_file,
            backend::system_write_text_file,
            backend::system_write_temp_text_file,
            backend::system_read_clipboard_file_paths,
            backend::system_write_clipboard_file,
            mobile_host::mobile_host_get_status,
            mobile_host::mobile_host_prepare,
            mobile_host::mobile_host_check_config,
            mobile_host::mobile_host_start,
            mobile_host::mobile_host_stop,
            mobile_host::mobile_host_probe,
            mobile_host::mobile_host_dns_health,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = app {
        backend::show_preinit_startup_error(
            "桌面启动失败",
            &format!(
                "因为桌面宿主初始化失败，前端无法启动。错误代码 TAURI_RUN_FAILED。\n\n详细信息：{error}"
            ),
        );
    }
}
