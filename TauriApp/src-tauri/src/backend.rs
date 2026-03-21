#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::fs;
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

#[cfg(not(target_os = "linux"))]
use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::io::BufReader;
#[cfg(target_os = "windows")]
use std::os::windows::{ffi::OsStrExt, process::CommandExt};

#[cfg(target_os = "macos")]
use icns::IconFamily;
#[cfg(target_os = "macos")]
use plist::{Dictionary as PlistDictionary, Value as PlistValue};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use tauri::menu::MenuBuilder;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};
use tokio::time::sleep;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_http::reqwest;

use crate::platform_contracts;

#[cfg(target_os = "windows")]
use webview2_com_sys::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
#[cfg(target_os = "windows")]
use windows::core::{PCWSTR, PWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
#[cfg(target_os = "windows")]
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::CoTaskMemFree;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, ShellExecuteW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SMALLICON,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, MessageBoxW, DI_NORMAL, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
    MB_TOPMOST, SW_HIDE,
};

const DEFAULT_DAEMON_BASE_URL: &str = "http://127.0.0.1:59500";
const DEFAULT_DAEMON_CONTROL_PORT_CANDIDATES: &[u16] = &[59500, 59501, 59502];
const DAEMON_TRANSPORT_BOOTSTRAP_PATH: &str = "/v1/transport/bootstrap";
const DAEMON_PROBE_TIMEOUT_MS: u64 = 1200;
const DAEMON_READY_TIMEOUT_MS: u64 = 12_000;
const DAEMON_READY_POLL_INTERVAL_MS: u64 = 300;
const DAEMON_SHUTDOWN_TIMEOUT_MS: u64 = 1200;
const FRONTEND_EXIT_DISPATCH_DELAY_MS: u64 = 50;
const FRONTEND_READY_TIMEOUT_MOBILE_MS: u64 = 60_000;
const FRONTEND_READY_TIMEOUT_DEV_MS: u64 = 20_000;
const FRONTEND_READY_TIMEOUT_RELEASE_MS: u64 = 12_000;
const MAX_TEXT_FILE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_FILE_ICON_SIZE_PX: u32 = 20;
const MIN_FILE_ICON_SIZE_PX: u32 = 16;
const MAX_FILE_ICON_SIZE_PX: u32 = 128;
const FILE_ICON_CACHE_MISS_SENTINEL: &str = "__WATERAY_ICON_MISS__";
#[cfg(target_os = "windows")]
const STARTUP_ERROR_WEBVIEW2_MISSING: &str = "WEBVIEW2_RUNTIME_MISSING";
const STARTUP_ERROR_FRONTEND_TIMEOUT: &str = "FRONTEND_READY_TIMEOUT";
const STARTUP_ERROR_FRONTEND_BOOTSTRAP: &str = "FRONTEND_BOOTSTRAP_FAILED";
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const TRAY_ID: &str = "wateray-tray";
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const TRAY_MENU_OPEN_MAIN_WINDOW: &str = "tray-open-main-window";
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const TRAY_MENU_QUIT_PANEL_ONLY: &str = "tray-quit-panel-only";
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const TRAY_MENU_QUIT_ALL: &str = "tray-quit-all";
#[cfg(target_os = "linux")]
const LINUX_PACKAGED_SERVICE_NAME: &str = "waterayd";
#[cfg(target_os = "linux")]
const LINUX_DEV_DESKTOP_OVERRIDE_MARKER: &str = "X-Wateray-DevDesktop=true";
#[cfg(target_os = "linux")]
const LINUX_DEV_DESKTOP_FILE_NAME: &str = "com.singbox.wateray.desktop";
#[cfg(target_os = "linux")]
const LINUX_ELECTRON_DEV_DESKTOP_FILE_NAME: &str = "wateray-dev-local.desktop";
#[cfg(target_os = "linux")]
const LINUX_TAURI_DEV_ICON_PREFIX: &str = "wateray-tauri-dev-";
#[cfg(target_os = "linux")]
const LINUX_ELECTRON_DEV_ICON_PREFIX: &str = "wateray-dev-local-";
#[cfg(target_os = "linux")]
const LINUX_EMBEDDED_INSTALL_SCRIPT_NAME: &str = "install-system-service.sh";
#[cfg(target_os = "linux")]
const LINUX_EMBEDDED_HELPER_SCRIPT_NAME: &str = "wateray-service-helper.sh";
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_INSTALL_SCRIPT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/install-system-service.sh"
));
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_HELPER_SCRIPT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/wateray-service-helper.sh"
));
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_PACKAGED_SERVICE_TEMPLATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/waterayd.service.template"
));
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_DEV_SERVICE_TEMPLATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/waterayd-dev.service.template"
));
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_DESKTOP_TEMPLATE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/wateray.desktop.template"
));
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_POLICY: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/net.wateray.daemon.policy"
));
#[cfg(target_os = "linux")]
const EMBEDDED_LINUX_ICON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/build/assets/linux/wateray.png"
));

#[derive(Serialize)]
pub struct ClipboardWriteResult {
    mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlatformInfo {
    pub kind: String,
    pub is_mobile: bool,
    pub supports_window_controls: bool,
    pub supports_tray: bool,
    pub supports_packaged_daemon: bool,
    pub supports_system_proxy_mode: bool,
    pub supports_local_file_access: bool,
    pub supports_in_app_updates: bool,
    pub supports_mobile_vpn_host: bool,
    pub requires_sandbox_data_root: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackInternalPortBundle {
    pub command_server_port: Option<u16>,
    pub clash_api_controller_port: Option<u16>,
    pub probe_socks_port: Option<u16>,
    pub dns_health_proxy_socks_port: Option<u16>,
    pub dns_health_direct_socks_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackTransportBootstrap {
    pub protocol_version: u16,
    pub platform_kind: String,
    pub session_id: String,
    pub auth_token: String,
    pub expires_at_ms: i64,
    pub control_port_candidates: Vec<u16>,
    pub active_control_port: u16,
    pub ws_path: Option<String>,
    pub internal_ports: Option<LoopbackInternalPortBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledDesktopAppCandidate {
    pub name: String,
    pub path: String,
    pub executable_name: String,
    pub bundle_id: String,
}

#[cfg(target_os = "linux")]
struct LinuxSystemdUnitState {
    installed: bool,
    active_state: String,
}

#[cfg(target_os = "linux")]
struct EmbeddedLinuxAsset {
    file_name: &'static str,
    bytes: &'static [u8],
    mode: u32,
}

#[cfg(target_os = "linux")]
struct LinuxDesktopEntryInfo {
    name: String,
    exec_value: String,
    icon_value: String,
    desktop_id: String,
}

#[cfg(target_os = "linux")]
static EMBEDDED_LINUX_RELEASE_ASSETS: &[EmbeddedLinuxAsset] = &[
    EmbeddedLinuxAsset {
        file_name: LINUX_EMBEDDED_INSTALL_SCRIPT_NAME,
        bytes: EMBEDDED_LINUX_INSTALL_SCRIPT,
        mode: 0o755,
    },
    EmbeddedLinuxAsset {
        file_name: LINUX_EMBEDDED_HELPER_SCRIPT_NAME,
        bytes: EMBEDDED_LINUX_HELPER_SCRIPT,
        mode: 0o755,
    },
    EmbeddedLinuxAsset {
        file_name: "waterayd.service.template",
        bytes: EMBEDDED_LINUX_PACKAGED_SERVICE_TEMPLATE,
        mode: 0o644,
    },
    EmbeddedLinuxAsset {
        file_name: "waterayd-dev.service.template",
        bytes: EMBEDDED_LINUX_DEV_SERVICE_TEMPLATE,
        mode: 0o644,
    },
    EmbeddedLinuxAsset {
        file_name: "wateray.desktop.template",
        bytes: EMBEDDED_LINUX_DESKTOP_TEMPLATE,
        mode: 0o644,
    },
    EmbeddedLinuxAsset {
        file_name: "net.wateray.daemon.policy",
        bytes: EMBEDDED_LINUX_POLICY,
        mode: 0o644,
    },
    EmbeddedLinuxAsset {
        file_name: "wateray.png",
        bytes: EMBEDDED_LINUX_ICON,
        mode: 0o644,
    },
];

#[derive(Default)]
pub struct FrontendStartupState {
    ready: AtomicBool,
    failed: AtomicBool,
}

impl FrontendStartupState {
    fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    fn is_resolved(&self) -> bool {
        self.ready.load(Ordering::SeqCst) || self.failed.load(Ordering::SeqCst)
    }

    fn try_mark_failed(&self) -> bool {
        if self.ready.load(Ordering::SeqCst) {
            return false;
        }
        !self.failed.swap(true, Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct DaemonBaseUrlState {
    base_url: Mutex<Option<String>>,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct InstalledDesktopAppCandidatesCache {
    refreshed_this_launch: bool,
    candidates: Vec<InstalledDesktopAppCandidate>,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct InstalledDesktopAppCandidatesState {
    cache: Mutex<InstalledDesktopAppCandidatesCache>,
}

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct InstalledDesktopAppCandidatesState;

impl DaemonBaseUrlState {
    fn remember(&self, raw_base_url: &str) {
        let Some(normalized_base_url) = normalize_daemon_base_url(raw_base_url) else {
            return;
        };
        if let Ok(mut guard) = self.base_url.lock() {
            *guard = Some(normalized_base_url);
        }
    }

    fn get(&self) -> Option<String> {
        self.base_url.lock().ok().and_then(|guard| guard.clone())
    }
}

#[cfg(target_os = "android")]
fn runtime_platform_kind() -> &'static str {
    "android"
}

#[cfg(target_os = "ios")]
fn runtime_platform_kind() -> &'static str {
    "ios"
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn runtime_platform_kind() -> &'static str {
    "desktop"
}

fn is_mobile_platform() -> bool {
    runtime_platform_kind() != "desktop"
}

#[tauri::command]
pub fn runtime_platform_info() -> RuntimePlatformInfo {
    let contract = platform_contracts::resolve_runtime_platform_contract(runtime_platform_kind());
    let supports_packaged_daemon = if cfg!(target_os = "macos") {
        false
    } else {
        contract.supports_packaged_daemon
    };
    let supports_system_proxy_mode = contract.supports_system_proxy_mode;
    let supports_in_app_updates = if cfg!(target_os = "macos") {
        false
    } else {
        contract.supports_in_app_updates
    };
    RuntimePlatformInfo {
        kind: contract.kind.to_string(),
        is_mobile: contract.is_mobile,
        supports_window_controls: contract.supports_window_controls,
        supports_tray: contract.supports_tray,
        supports_packaged_daemon,
        supports_system_proxy_mode,
        supports_local_file_access: contract.supports_local_file_access,
        supports_in_app_updates,
        supports_mobile_vpn_host: contract.supports_mobile_vpn_host,
        requires_sandbox_data_root: contract.requires_sandbox_data_root,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn hide_main_window(_app: &AppHandle) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn restore_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_skip_taskbar(false);
    let _ = window.show();
    if matches!(window.is_minimized(), Ok(true)) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();
}

fn trace_window_flow(_stage: &str, _detail: &str) {}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn hide_tray_icon(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(false);
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn hide_tray_icon(_app: &AppHandle) {}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn should_restore_main_window_from_tray_event(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } | TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

#[cfg(target_os = "macos")]
fn schedule_frontend_exit(_app: AppHandle) {
    trace_window_flow("schedule_frontend_exit", "");
    std::thread::spawn(move || {
        // Let async command responses flush before touching the webview/window lifecycle.
        std::thread::sleep(Duration::from_millis(FRONTEND_EXIT_DISPATCH_DELAY_MS));
        trace_window_flow("frontend_exit_task.begin", "mode=macos");
        trace_window_flow("frontend_exit_task.process_exit", "mode=macos");
        std::process::exit(0);
    });
}

#[cfg(not(target_os = "macos"))]
fn schedule_frontend_exit(app: AppHandle) {
    trace_window_flow("schedule_frontend_exit", "");
    std::thread::spawn(move || {
        // Let async command responses flush before touching the webview/window lifecycle.
        std::thread::sleep(Duration::from_millis(FRONTEND_EXIT_DISPATCH_DELAY_MS));
        trace_window_flow("frontend_exit_task.begin", "");
        hide_main_window(&app);
        hide_tray_icon(&app);
        std::thread::sleep(Duration::from_millis(10));
        trace_window_flow("frontend_exit_task.app_exit", "");
        app.exit(0);
    });
}

fn close_panel_keep_core_now(app: AppHandle) {
    trace_window_flow("close_panel_keep_core.begin", "");
    schedule_frontend_exit(app);
}

async fn close_panel_keep_core(app: AppHandle) {
    close_panel_keep_core_now(app);
}

#[cfg(target_os = "macos")]
fn quit_all_after_daemon_shutdown(app: AppHandle) {
    trace_window_flow("quit_all.begin", "");
    trace_window_flow("quit_all.daemon_shutdown_already_handled", "");
    trace_window_flow("quit_all.after_daemon_shutdown", "");
    schedule_frontend_exit(app);
}

async fn quit_all(
    app: AppHandle,
    explicit_daemon_base_url: Option<String>,
    daemon_shutdown_handled: bool,
) {
    trace_window_flow("quit_all.begin", "");
    #[cfg(target_os = "linux")]
    if let Err(error) = clear_linux_system_proxy() {
        eprintln!("failed to clear linux system proxy before quit: {error}");
    }
    if daemon_shutdown_handled {
        trace_window_flow("quit_all.daemon_shutdown_already_handled", "");
    } else {
        let remembered_daemon_base_url = app
            .try_state::<DaemonBaseUrlState>()
            .and_then(|state| state.get());
        shutdown_daemon_best_effort(explicit_daemon_base_url, remembered_daemon_base_url).await;
    }
    trace_window_flow("quit_all.after_daemon_shutdown", "");
    schedule_frontend_exit(app);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn apply_main_window_icon(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(icon) = app.default_window_icon().cloned() else {
        return;
    };
    let _ = window.set_icon(icon);
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn apply_main_window_icon(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
pub fn apply_platform_window_chrome(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    trace_window_flow("platform_window_chrome.apply_native_macos", "");
    if let Err(error) = window.set_decorations(true) {
        trace_window_flow("platform_window_chrome.error", &error.to_string());
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply_platform_window_chrome(_app: &AppHandle) {}

#[cfg(target_os = "linux")]
pub fn cleanup_stale_linux_dev_desktop_override() {
    if is_dev_mode() {
        return;
    }

    let home_dir = match std::env::var("HOME") {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return;
            }
            PathBuf::from(trimmed)
        }
        Err(_) => return,
    };
    let applications_dir = home_dir.join(".local").join("share").join("applications");
    if !applications_dir.is_dir() {
        return;
    }

    let mut cleaned = false;
    let tauri_dev_desktop_path = applications_dir.join(LINUX_DEV_DESKTOP_FILE_NAME);
    if let Ok(content) = fs::read_to_string(&tauri_dev_desktop_path) {
        if content.contains(LINUX_DEV_DESKTOP_OVERRIDE_MARKER) {
            let _ = fs::remove_file(&tauri_dev_desktop_path);
            cleaned = true;
        }
    }

    let electron_dev_desktop_path = applications_dir.join(LINUX_ELECTRON_DEV_DESKTOP_FILE_NAME);
    if electron_dev_desktop_path.exists() {
        let _ = fs::remove_file(&electron_dev_desktop_path);
        cleaned = true;
    }

    if let Ok(entries) = fs::read_dir(&applications_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            let is_dev_icon = file_name.starts_with(LINUX_TAURI_DEV_ICON_PREFIX)
                || file_name.starts_with(LINUX_ELECTRON_DEV_ICON_PREFIX);
            if is_dev_icon {
                let _ = fs::remove_file(path);
                cleaned = true;
            }
        }
    }

    if cleaned {
        let _ = Command::new("update-desktop-database")
            .arg(&applications_dir)
            .output();
    }
}

#[cfg(not(target_os = "linux"))]
pub fn cleanup_stale_linux_dev_desktop_override() {}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub fn ensure_system_tray(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "未找到默认窗口图标".to_string())?;

    let menu = MenuBuilder::new(app)
        .text(TRAY_MENU_OPEN_MAIN_WINDOW, "打开主界面")
        .separator()
        .text(TRAY_MENU_QUIT_PANEL_ONLY, "后台运行（关面板）")
        .separator()
        .text(TRAY_MENU_QUIT_ALL, "完全退出（含内核）")
        .build()
        .map_err(|error| format!("创建托盘菜单失败：{error}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Wateray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_OPEN_MAIN_WINDOW => restore_main_window(app),
            TRAY_MENU_QUIT_PANEL_ONLY => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    close_panel_keep_core(app_handle).await;
                });
            }
            TRAY_MENU_QUIT_ALL => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    quit_all(app_handle, None, false).await;
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if should_restore_main_window_from_tray_event(&event) {
                restore_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map(|_| ())
        .map_err(|error| format!("创建托盘图标失败：{error}"))
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub fn ensure_system_tray(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

fn normalize_file_name(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return "wateray_export.json".to_string();
    }

    let base = Path::new(text)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .unwrap_or("");

    if base.is_empty() {
        return "wateray_export.json".to_string();
    }

    if Path::new(base).extension().is_none() {
        format!("{base}.json")
    } else {
        base.to_string()
    }
}

fn ensure_text_file(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("读取文件信息失败：{} ({})", path.display(), error))?;
    if !metadata.is_file() {
        return Err("target path is not a file".to_string());
    }
    Ok(())
}

fn normalize_file_icon_size(size_px: Option<u32>) -> u32 {
    size_px
        .unwrap_or(DEFAULT_FILE_ICON_SIZE_PX)
        .clamp(MIN_FILE_ICON_SIZE_PX, MAX_FILE_ICON_SIZE_PX)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn image_mime_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.trim();
    if extension.is_empty() {
        return None;
    }
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn encode_image_data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn read_image_file_data_url(path: &Path) -> Option<String> {
    let mime = image_mime_from_path(path)?;
    let bytes = fs::read(path).ok()?;
    Some(encode_image_data_url(mime, &bytes))
}

fn build_file_icon_cache_key(target_path: &Path, size_px: u32) -> String {
    let normalized_path =
        fs::canonicalize(target_path).unwrap_or_else(|_| target_path.to_path_buf());
    let metadata = fs::metadata(&normalized_path).ok();
    let modified_ms = metadata
        .as_ref()
        .and_then(|item| item.modified().ok())
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let file_len = metadata.as_ref().map(|item| item.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(normalized_path.to_string_lossy().as_bytes());
    hasher.update(b"\n");
    hasher.update(size_px.to_string().as_bytes());
    hasher.update(b"\n");
    hasher.update(modified_ms.to_string().as_bytes());
    hasher.update(b"\n");
    hasher.update(file_len.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn resolve_file_icon_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|path| path.join("cache").join("appicons"))
}

#[cfg(target_os = "macos")]
fn resolve_installed_app_candidates_cache_path(app: &AppHandle) -> Option<PathBuf> {
    Some(resolve_file_icon_cache_dir(app)?.join("macos-installed-apps.json"))
}

#[cfg(target_os = "macos")]
fn read_cached_macos_installed_app_candidates(
    app: &AppHandle,
) -> Option<Vec<InstalledDesktopAppCandidate>> {
    let cache_path = resolve_installed_app_candidates_cache_path(app)?;
    let cached = fs::read_to_string(cache_path).ok()?;
    serde_json::from_str::<Vec<InstalledDesktopAppCandidate>>(&cached).ok()
}

#[cfg(target_os = "macos")]
fn write_cached_macos_installed_app_candidates(
    app: &AppHandle,
    candidates: &[InstalledDesktopAppCandidate],
) {
    let Some(cache_dir) = resolve_file_icon_cache_dir(app) else {
        return;
    };
    if fs::create_dir_all(&cache_dir).is_err() {
        return;
    }
    let Some(cache_path) = resolve_installed_app_candidates_cache_path(app) else {
        return;
    };
    let Ok(payload) = serde_json::to_string_pretty(candidates) else {
        return;
    };
    let _ = fs::write(cache_path, payload.as_bytes());
}

#[cfg(target_os = "macos")]
fn collect_macos_installed_app_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home_dir) = std::env::var_os("HOME").map(PathBuf::from) {
        roots.push(home_dir.join("Applications"));
    }
    roots.push(PathBuf::from("/Applications"));
    roots.push(PathBuf::from("/System/Applications"));
    roots.push(PathBuf::from("/System/Cryptexes/App/System/Applications"));
    roots.push(PathBuf::from("/System/Library/CoreServices/Applications"));
    roots
}

#[cfg(target_os = "macos")]
fn build_macos_installed_app_candidate(app_path: &Path) -> Option<InstalledDesktopAppCandidate> {
    if !app_path.is_dir() {
        return None;
    }
    let info_plist_path = app_path.join("Contents/Info.plist");
    if !info_plist_path.is_file() {
        return None;
    }
    let fallback_name = app_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let metadata = read_macos_bundle_metadata(&info_plist_path).unwrap_or_default();
    let name = if !metadata.display_name.is_empty() {
        metadata.display_name
    } else if !metadata.bundle_name.is_empty() {
        metadata.bundle_name
    } else {
        fallback_name.to_string()
    };
    let executable_name = metadata.executable_name;
    let bundle_id = metadata.bundle_id;
    let normalized_name = name.trim().to_string();
    if normalized_name.is_empty() {
        return None;
    }
    Some(InstalledDesktopAppCandidate {
        name: normalized_name,
        path: app_path.to_string_lossy().to_string(),
        executable_name,
        bundle_id,
    })
}

#[cfg(target_os = "macos")]
fn scan_macos_installed_app_candidates() -> Vec<InstalledDesktopAppCandidate> {
    let mut app_paths = Vec::new();
    let mut stack = collect_macos_installed_app_roots()
        .into_iter()
        .map(|path| (path, 0usize))
        .collect::<Vec<_>>();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("app"))
                .unwrap_or(false)
            {
                if !app_paths.iter().any(|existing| existing == &path) {
                    app_paths.push(path);
                }
                continue;
            }
            if depth < 4 {
                stack.push((path, depth + 1));
            }
        }
    }
    let mut candidates = app_paths
        .into_iter()
        .filter_map(|path| build_macos_installed_app_candidate(&path))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| {
                left.path
                    .to_ascii_lowercase()
                    .cmp(&right.path.to_ascii_lowercase())
            })
    });
    candidates
}

#[cfg(target_os = "macos")]
fn list_installed_app_candidates_impl(
    app: &AppHandle,
    state: &InstalledDesktopAppCandidatesState,
) -> Vec<InstalledDesktopAppCandidate> {
    if let Ok(mut guard) = state.cache.lock() {
        if guard.refreshed_this_launch {
            return guard.candidates.clone();
        }
        let scanned = scan_macos_installed_app_candidates();
        let resolved = if scanned.is_empty() {
            read_cached_macos_installed_app_candidates(app).unwrap_or_default()
        } else {
            scanned
        };
        if !resolved.is_empty() {
            write_cached_macos_installed_app_candidates(app, &resolved);
        }
        guard.refreshed_this_launch = true;
        guard.candidates = resolved.clone();
        return resolved;
    }
    let scanned = scan_macos_installed_app_candidates();
    if !scanned.is_empty() {
        write_cached_macos_installed_app_candidates(app, &scanned);
        return scanned;
    }
    read_cached_macos_installed_app_candidates(app).unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn scan_linux_installed_app_candidates() -> Vec<InstalledDesktopAppCandidate> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry_path in collect_linux_desktop_entry_paths() {
        let Some(info) = parse_linux_desktop_entry_info(&entry_path) else {
            continue;
        };
        let executable_name = resolve_linux_exec_program(&info.exec_value)
            .and_then(|value| {
                Path::new(value.trim())
                    .file_stem()
                    .or_else(|| Path::new(value.trim()).file_name())
                    .and_then(|item| item.to_str())
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let candidate_path = entry_path.to_string_lossy().trim().to_string();
        if candidate_path.is_empty() {
            continue;
        }
        let dedupe_key = format!(
            "{}::{}",
            info.desktop_id.to_ascii_lowercase(),
            candidate_path.to_ascii_lowercase()
        );
        if !seen.insert(dedupe_key) {
            continue;
        }
        candidates.push(InstalledDesktopAppCandidate {
            name: info.name,
            path: candidate_path,
            executable_name,
            bundle_id: info.desktop_id,
        });
    }
    candidates.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| {
                left.path
                    .to_ascii_lowercase()
                    .cmp(&right.path.to_ascii_lowercase())
            })
    });
    candidates
}

#[cfg(target_os = "linux")]
fn list_installed_app_candidates_impl(
    _app: &AppHandle,
    _state: &InstalledDesktopAppCandidatesState,
) -> Vec<InstalledDesktopAppCandidate> {
    scan_linux_installed_app_candidates()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
fn list_installed_app_candidates_impl(
    _app: &AppHandle,
    _state: &InstalledDesktopAppCandidatesState,
) -> Vec<InstalledDesktopAppCandidate> {
    Vec::new()
}

fn resolve_file_icon_cache_path(
    app: &AppHandle,
    target_path: &Path,
    size_px: u32,
) -> Option<PathBuf> {
    Some(resolve_file_icon_cache_dir(app)?.join(format!(
        "{}.txt",
        build_file_icon_cache_key(target_path, size_px)
    )))
}

fn read_cached_file_icon_data_url(
    app: &AppHandle,
    target_path: &Path,
    size_px: u32,
) -> Option<Option<String>> {
    let cache_path = resolve_file_icon_cache_path(app, target_path, size_px)?;
    let cached = fs::read_to_string(cache_path).ok()?;
    let normalized = cached.trim();
    if normalized.is_empty() || normalized == FILE_ICON_CACHE_MISS_SENTINEL {
        let _ = fs::remove_file(resolve_file_icon_cache_path(app, target_path, size_px)?);
        return None;
    }
    Some(Some(normalized.to_string()))
}

fn write_cached_file_icon_data_url(
    app: &AppHandle,
    target_path: &Path,
    size_px: u32,
    data_url: Option<&str>,
) {
    let Some(cache_path) = resolve_file_icon_cache_path(app, target_path, size_px) else {
        return;
    };
    let Some(payload) = data_url else {
        let _ = fs::remove_file(cache_path);
        return;
    };
    let Some(cache_dir) = resolve_file_icon_cache_dir(app) else {
        return;
    };
    if fs::create_dir_all(&cache_dir).is_err() {
        return;
    }
    let _ = fs::write(cache_path, payload.as_bytes());
}

fn resolve_file_icon_data_url_uncached(target_path: &Path, size_px: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        return resolve_macos_file_icon_data_url(target_path, size_px);
    }
    #[cfg(target_os = "windows")]
    {
        return resolve_windows_file_icon_data_url(target_path, size_px);
    }
    #[cfg(target_os = "linux")]
    {
        return resolve_linux_file_icon_data_url(target_path, size_px);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (target_path, size_px);
        None
    }
}

fn resolve_file_icon_data_url(app: &AppHandle, target_path: &Path, size_px: u32) -> Option<String> {
    if let Some(cached) = read_cached_file_icon_data_url(app, target_path, size_px) {
        return cached;
    }
    let data_url = resolve_file_icon_data_url_uncached(target_path, size_px);
    write_cached_file_icon_data_url(app, target_path, size_px, data_url.as_deref());
    data_url
}

#[cfg(target_os = "macos")]
fn resolve_known_macos_owner_bundle_roots(target_path: &Path) -> Vec<PathBuf> {
    let normalized_path =
        fs::canonicalize(target_path).unwrap_or_else(|_| target_path.to_path_buf());
    let normalized_text = normalized_path.to_string_lossy().to_ascii_lowercase();
    let mut bundles = Vec::new();
    if normalized_text.contains("/library/apple/system/library/stagedframeworks/safari/")
        || (normalized_text.contains("/webkit.framework/")
            && normalized_text.contains("com.apple.webkit.networking"))
    {
        let safari_app = PathBuf::from("/Applications/Safari.app");
        if safari_app.is_dir() {
            bundles.push(safari_app);
        }
    }
    bundles
}

#[cfg(target_os = "macos")]
fn collect_macos_bundle_roots(target_path: &Path) -> Vec<PathBuf> {
    let mut bundles = Vec::new();
    if target_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("app"))
        .unwrap_or(false)
    {
        bundles.push(target_path.to_path_buf());
    }
    for ancestor in target_path.ancestors() {
        if ancestor
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
        {
            if !bundles.iter().any(|path| path == ancestor) {
                bundles.push(ancestor.to_path_buf());
            }
        }
    }
    bundles
}

#[cfg(target_os = "macos")]
fn read_macos_plist_string(dict: &PlistDictionary, key_path: &str) -> String {
    dict.get(key_path)
        .and_then(|value| value.as_string())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct MacosBundleMetadata {
    display_name: String,
    bundle_name: String,
    executable_name: String,
    bundle_id: String,
    icon_file: String,
}

#[cfg(target_os = "macos")]
fn read_macos_bundle_metadata(info_plist_path: &Path) -> Option<MacosBundleMetadata> {
    let plist_value = PlistValue::from_file(info_plist_path).ok()?;
    let dict = plist_value.as_dictionary()?;
    Some(MacosBundleMetadata {
        display_name: read_macos_plist_string(dict, "CFBundleDisplayName"),
        bundle_name: read_macos_plist_string(dict, "CFBundleName"),
        executable_name: read_macos_plist_string(dict, "CFBundleExecutable"),
        bundle_id: read_macos_plist_string(dict, "CFBundleIdentifier"),
        icon_file: read_macos_plist_string(dict, "CFBundleIconFile"),
    })
}

#[cfg(target_os = "macos")]
fn resolve_macos_bundle_icon_path(bundle_root: &Path) -> Option<PathBuf> {
    let info_plist_path = bundle_root.join("Contents/Info.plist");
    if !info_plist_path.is_file() {
        return None;
    }
    let resources_dir = bundle_root.join("Contents/Resources");
    let mut candidates = Vec::new();
    let metadata = read_macos_bundle_metadata(&info_plist_path).unwrap_or_default();
    if !metadata.icon_file.is_empty() {
        let direct_candidate = resources_dir.join(&metadata.icon_file);
        candidates.push(direct_candidate.clone());
        if Path::new(&metadata.icon_file).extension().is_none() {
            candidates.push(resources_dir.join(format!("{}.icns", metadata.icon_file)));
        }
    }
    if !metadata.executable_name.is_empty() {
        candidates.push(resources_dir.join(format!("{}.icns", metadata.executable_name)));
    }
    if let Some(existing) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(existing);
    }
    fs::read_dir(&resources_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case("icns"))
                    .unwrap_or(false)
        })
}

#[cfg(target_os = "macos")]
fn read_macos_icns_data_url(icon_path: &Path, size_px: u32) -> Option<String> {
    let file = fs::File::open(icon_path).ok()?;
    let family = IconFamily::read(BufReader::new(file)).ok()?;
    let requested_size = size_px.clamp(MIN_FILE_ICON_SIZE_PX, MAX_FILE_ICON_SIZE_PX);
    let available_icons = family.available_icons();
    let icon_type = available_icons.into_iter().max_by_key(|icon_type| {
        let width = icon_type.pixel_width();
        let height = icon_type.pixel_height();
        let max_side = width.max(height);
        (
            u8::from(max_side >= requested_size),
            max_side,
            width.saturating_mul(height),
        )
    })?;
    let image = family.get_icon_with_type(icon_type).ok()?;
    let mut png_bytes = Vec::new();
    image.write_png(&mut png_bytes).ok()?;
    Some(encode_image_data_url("image/png", &png_bytes))
}

#[cfg(target_os = "macos")]
fn resolve_macos_file_icon_data_url(target_path: &Path, size_px: u32) -> Option<String> {
    let icon_path = resolve_known_macos_owner_bundle_roots(target_path)
        .into_iter()
        .chain(collect_macos_bundle_roots(target_path))
        .into_iter()
        .find_map(|bundle_root| resolve_macos_bundle_icon_path(&bundle_root))?;
    let is_icns = icon_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("icns"))
        .unwrap_or(false);
    if is_icns {
        return read_macos_icns_data_url(&icon_path, size_px);
    }
    read_image_file_data_url(&icon_path)
}

#[cfg(target_os = "windows")]
fn encode_windows_rgba_png_data_url(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes)
    ))
}

#[cfg(target_os = "windows")]
fn render_windows_icon_data_url(
    icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    width: i32,
    height: i32,
) -> Option<String> {
    if width <= 0 || height <= 0 {
        return None;
    }
    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels_ptr: *mut c_void = std::ptr::null_mut();
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.0.is_null() {
        return None;
    }
    let hbitmap = unsafe {
        CreateDIBSection(
            Some(hdc),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut pixels_ptr,
            None,
            0,
        )
    }
    .ok()?;
    if hbitmap.0.is_null() || pixels_ptr.is_null() {
        unsafe {
            let _ = DeleteDC(hdc);
        }
        return None;
    }
    let previous_object = unsafe { SelectObject(hdc, HGDIOBJ(hbitmap.0)) };
    let pixel_len = width as usize * height as usize * 4;
    unsafe {
        std::ptr::write_bytes(pixels_ptr as *mut u8, 0, pixel_len);
    }
    let data_url =
        if unsafe { DrawIconEx(hdc, 0, 0, icon, width, height, 0, None, DI_NORMAL) }.is_ok() {
            let bgra = unsafe { std::slice::from_raw_parts(pixels_ptr as *const u8, pixel_len) };
            let mut rgba = Vec::with_capacity(pixel_len);
            for chunk in bgra.chunks_exact(4) {
                rgba.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]]);
            }
            encode_windows_rgba_png_data_url(&rgba, width as u32, height as u32)
        } else {
            None
        };
    unsafe {
        if !previous_object.0.is_null() {
            let _ = SelectObject(hdc, previous_object);
        }
        let _ = DeleteObject(HGDIOBJ(hbitmap.0));
        let _ = DeleteDC(hdc);
    }
    data_url
}

#[cfg(target_os = "windows")]
fn resolve_windows_file_icon_data_url(target_path: &Path, size_px: u32) -> Option<String> {
    let path_wide = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<u16>>();
    let icon_size = size_px.clamp(MIN_FILE_ICON_SIZE_PX, MAX_FILE_ICON_SIZE_PX) as i32;
    let mut file_info = SHFILEINFOW::default();
    let flags = SHGFI_ICON
        | if icon_size <= 16 {
            SHGFI_SMALLICON
        } else {
            SHGFI_LARGEICON
        };
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(path_wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if result == 0 || file_info.hIcon.0.is_null() {
        return None;
    }
    let data_url = render_windows_icon_data_url(file_info.hIcon, icon_size, icon_size);
    unsafe {
        let _ = DestroyIcon(file_info.hIcon);
    }
    data_url
}

#[cfg(target_os = "linux")]
fn resolve_linux_file_icon_data_url(target_path: &Path, size_px: u32) -> Option<String> {
    let normalized_target = normalize_linux_icon_target_path(target_path);
    if normalized_target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("desktop"))
        .unwrap_or(false)
    {
        let icon_path = parse_linux_desktop_entry_info(&normalized_target)
            .and_then(|info| resolve_linux_icon_value_path(&info.icon_value, size_px))?;
        return read_image_file_data_url(&icon_path);
    }
    let icon_path = resolve_linux_desktop_entry_icon_path(&normalized_target, size_px)
        .or_else(|| resolve_linux_nearby_desktop_entry_icon_path(&normalized_target, size_px))
        .or_else(|| resolve_linux_nearby_image_icon_path(&normalized_target, size_px))
        .or_else(|| resolve_linux_executable_icon_path(&normalized_target, size_px))?;
    read_image_file_data_url(&icon_path)
}

#[cfg(target_os = "linux")]
fn strip_linux_deleted_suffix_text(value: &str) -> &str {
    let trimmed = value.trim();
    trimmed.strip_suffix(" (deleted)").unwrap_or(trimmed)
}

#[cfg(target_os = "linux")]
fn normalize_linux_icon_target_path(target_path: &Path) -> PathBuf {
    if let Ok(canonicalized) = fs::canonicalize(target_path) {
        return canonicalized;
    }
    let raw_text = target_path.to_string_lossy();
    let normalized_text = strip_linux_deleted_suffix_text(&raw_text);
    if normalized_text != raw_text {
        let normalized_path = PathBuf::from(normalized_text);
        return fs::canonicalize(&normalized_path).unwrap_or(normalized_path);
    }
    target_path.to_path_buf()
}

#[cfg(target_os = "linux")]
fn resolve_linux_desktop_entry_icon_path(target_path: &Path, size_px: u32) -> Option<PathBuf> {
    let mut best_match: Option<(i32, PathBuf)> = None;
    for entry_path in collect_linux_desktop_entry_paths() {
        let Some((exec_value, icon_value)) = parse_linux_desktop_entry(&entry_path) else {
            continue;
        };
        let score = score_linux_desktop_entry_match(&exec_value, target_path);
        if score <= 0 {
            continue;
        }
        if let Some(icon_path) = resolve_linux_icon_value_path(&icon_value, size_px) {
            match &best_match {
                Some((best_score, _)) if *best_score >= score => {}
                _ => best_match = Some((score, icon_path)),
            }
        }
    }
    best_match.map(|(_, path)| path)
}

#[cfg(target_os = "linux")]
fn resolve_linux_nearby_desktop_entry_icon_path(target_path: &Path, size_px: u32) -> Option<PathBuf> {
    let mut best_match: Option<(i32, PathBuf)> = None;
    for dir in collect_linux_nearby_search_dirs(target_path) {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("desktop"))
                .unwrap_or(false)
            {
                continue;
            }
            let Some((exec_value, icon_value)) = parse_linux_desktop_entry(&path) else {
                continue;
            };
            let score = score_linux_desktop_entry_match(&exec_value, target_path);
            if score <= 0 {
                continue;
            }
            let Some(icon_path) = resolve_linux_icon_value_path(&icon_value, size_px) else {
                continue;
            };
            let score = score + 40;
            match &best_match {
                Some((best_score, _)) if *best_score >= score => {}
                _ => best_match = Some((score, icon_path)),
            }
        }
    }
    best_match.map(|(_, path)| path)
}

#[cfg(target_os = "linux")]
fn collect_linux_nearby_search_dirs(target_path: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut current = target_path.parent().map(Path::to_path_buf);
    for _ in 0..2 {
        let Some(dir) = current.take() else {
            break;
        };
        if !result.iter().any(|existing| existing == &dir) {
            result.push(dir.clone());
        }
        current = dir.parent().map(Path::to_path_buf);
    }
    result
}

#[cfg(target_os = "linux")]
fn collect_linux_desktop_entry_paths() -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut stack = collect_linux_desktop_entry_roots()
        .into_iter()
        .map(|path| (path, 0usize))
        .collect::<Vec<_>>();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 4 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("desktop"))
                .unwrap_or(false)
            {
                result.push(path);
            }
        }
    }
    result
}

#[cfg(target_os = "linux")]
fn collect_linux_desktop_entry_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        roots.push(PathBuf::from(data_home).join("applications"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home_dir = PathBuf::from(home);
        roots.push(home_dir.join(".local/share/applications"));
    }
    roots.push(PathBuf::from("/usr/local/share/applications"));
    roots.push(PathBuf::from("/usr/share/applications"));
    roots
}

#[cfg(target_os = "linux")]
fn parse_linux_desktop_entry(entry_path: &Path) -> Option<(String, String)> {
    let info = parse_linux_desktop_entry_info(entry_path)?;
    Some((info.exec_value, info.icon_value))
}

#[cfg(target_os = "linux")]
fn parse_linux_desktop_entry_boolean(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

#[cfg(target_os = "linux")]
fn parse_linux_desktop_entry_info(entry_path: &Path) -> Option<LinuxDesktopEntryInfo> {
    let content = fs::read_to_string(entry_path).ok()?;
    let mut in_desktop_entry = false;
    let mut name_value: Option<String> = None;
    let mut exec_value: Option<String> = None;
    let mut icon_value: Option<String> = None;
    let mut desktop_type = String::new();
    let mut hidden = false;
    let mut no_display = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_desktop_entry = trimmed == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        if trimmed.starts_with("Name[") {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Name=") {
            let normalized = value.trim();
            if !normalized.is_empty() {
                name_value = Some(normalized.to_string());
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Exec=") {
            exec_value = Some(value.trim().to_string());
            continue;
        }
        if trimmed.starts_with("Icon[") {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Icon=") {
            icon_value = Some(value.trim().to_string());
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Type=") {
            desktop_type = value.trim().to_string();
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("NoDisplay=") {
            no_display = parse_linux_desktop_entry_boolean(value);
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("Hidden=") {
            hidden = parse_linux_desktop_entry_boolean(value);
        }
    }
    if !desktop_type.is_empty() && !desktop_type.eq_ignore_ascii_case("Application") {
        return None;
    }
    if hidden || no_display {
        return None;
    }
    let desktop_id = entry_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)?;
    Some(LinuxDesktopEntryInfo {
        name: name_value.unwrap_or_else(|| desktop_id.clone()),
        exec_value: exec_value?,
        icon_value: icon_value?,
        desktop_id,
    })
}

#[cfg(target_os = "linux")]
fn score_linux_desktop_entry_match(exec_value: &str, target_path: &Path) -> i32 {
    let Some(program) = resolve_linux_exec_program(exec_value) else {
        return 0;
    };
    let normalized_target = normalize_linux_icon_target_path(target_path);
    let normalized_target_text = normalized_target.to_string_lossy().to_ascii_lowercase();
    let target_name = normalized_target
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| strip_linux_deleted_suffix_text(value).to_ascii_lowercase())
        .unwrap_or_default();
    let target_stem = normalized_target
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| strip_linux_deleted_suffix_text(value).to_ascii_lowercase())
        .unwrap_or_default();
    let program_path = PathBuf::from(&program);
    if program_path.is_absolute() && linux_paths_equal(&program_path, &normalized_target) {
        return 320;
    }
    let program_name = program_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let program_stem = program_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let mut score = 0;
    if !program_name.is_empty() && program_name == target_name {
        score += 180;
    }
    if !program_stem.is_empty() && program_stem == target_stem {
        score += 160;
    }
    if !program_name.is_empty() && normalized_target_text.contains(&format!("/{program_name}")) {
        score += 40;
    }
    if !program_stem.is_empty() && normalized_target_text.contains(&format!("/{program_stem}")) {
        score += 36;
    }
    if !program_name.is_empty() && target_name.contains(&program_name) {
        score += 28;
    }
    if !program_stem.is_empty() && target_stem.contains(&program_stem) {
        score += 24;
    }
    let target_tokens = tokenize_linux_match_text(&format!("{target_name} {target_stem}"));
    let program_tokens =
        tokenize_linux_match_text(&format!("{program_name} {program_stem} {program}"));
    let shared_tokens = target_tokens
        .iter()
        .filter(|token| program_tokens.iter().any(|candidate| candidate == *token))
        .count() as i32;
    if shared_tokens > 0 {
        score += shared_tokens * 56;
        if target_tokens.len() == 1 {
            score += 40;
        }
    }
    score
}

#[cfg(target_os = "linux")]
fn linux_paths_equal(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(lhs), Ok(rhs)) => lhs == rhs,
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn resolve_linux_exec_program(exec_value: &str) -> Option<String> {
    let tokens = tokenize_linux_exec_command(exec_value);
    if tokens.is_empty() {
        return None;
    }
    let mut index = 0usize;
    if tokens
        .get(index)
        .map(|value| value.eq_ignore_ascii_case("env"))
        .unwrap_or(false)
    {
        index += 1;
        while index < tokens.len() && tokens[index].contains('=') {
            index += 1;
        }
    }
    while index < tokens.len() {
        let token = tokens[index].trim();
        if token.is_empty() || token.starts_with('%') {
            index += 1;
            continue;
        }
        return Some(token.to_string());
    }
    None
}

#[cfg(target_os = "linux")]
fn tokenize_linux_exec_command(raw: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if quote != Some('\'') => {
                escaped = true;
            }
            '"' | '\'' if quote.is_none() => {
                quote = Some(ch);
            }
            '"' | '\'' if quote == Some(ch) => {
                quote = None;
            }
            _ if ch.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(target_os = "linux")]
fn tokenize_linux_match_text(raw: &str) -> Vec<String> {
    raw.to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|token| token.len() >= 3)
        .fold(Vec::<String>::new(), |mut values, token| {
            if !values.iter().any(|existing| existing == token) {
                values.push(token.to_string());
            }
            values
        })
}

#[cfg(target_os = "linux")]
fn collect_linux_executable_icon_names(target_path: &Path) -> Vec<String> {
    let mut result = Vec::new();
    let push_unique = |items: &mut Vec<String>, value: &str| {
        let trimmed = strip_linux_deleted_suffix_text(value);
        if trimmed.is_empty() {
            return;
        }
        if items.iter().any(|item| item.eq_ignore_ascii_case(trimmed)) {
            return;
        }
        items.push(trimmed.to_string());
    };
    if let Some(file_name) = target_path.file_name().and_then(|value| value.to_str()) {
        push_unique(&mut result, file_name);
    }
    if let Some(file_stem) = target_path.file_stem().and_then(|value| value.to_str()) {
        push_unique(&mut result, file_stem);
        for suffix in [".bin", "-bin", ".sh", "-wrapper", "-wrapped", "-launcher"] {
            if let Some(stripped) = file_stem.strip_suffix(suffix) {
                push_unique(&mut result, stripped);
            }
        }
        if file_stem.eq_ignore_ascii_case("AppRun") {
            if let Some(parent_name) = target_path
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
            {
                push_unique(&mut result, parent_name);
            }
        }
    }
    result
}

#[cfg(target_os = "linux")]
fn resolve_linux_nearby_image_icon_path(target_path: &Path, size_px: u32) -> Option<PathBuf> {
    let icon_names = collect_linux_executable_icon_names(target_path);
    if icon_names.is_empty() {
        return None;
    }
    let mut best_match: Option<(i32, PathBuf)> = None;
    for (dir_index, dir) in collect_linux_nearby_search_dirs(target_path).into_iter().enumerate() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if image_mime_from_path(&path).is_none() {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(strip_linux_deleted_suffix_text)
                .unwrap_or("");
            if !icon_names
                .iter()
                .any(|icon_name| stem.eq_ignore_ascii_case(strip_linux_deleted_suffix_text(icon_name)))
            {
                continue;
            }
            let proximity_bonus = if dir_index == 0 { 48 } else { 24 };
            let score = score_linux_icon_path(&path, size_px) + proximity_bonus;
            match &best_match {
                Some((best_score, _)) if *best_score >= score => {}
                _ => best_match = Some((score, path)),
            }
        }
    }
    best_match.map(|(_, path)| path)
}

#[cfg(target_os = "linux")]
fn resolve_linux_executable_icon_path(target_path: &Path, size_px: u32) -> Option<PathBuf> {
    for icon_name in collect_linux_executable_icon_names(target_path) {
        if let Some(icon_path) = resolve_linux_icon_value_path(&icon_name, size_px) {
            return Some(icon_path);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn resolve_linux_icon_value_path(icon_value: &str, size_px: u32) -> Option<PathBuf> {
    let trimmed = icon_value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let icon_path = PathBuf::from(trimmed);
    if icon_path.is_absolute() && icon_path.is_file() {
        return image_mime_from_path(&icon_path).map(|_| icon_path);
    }
    let icon_name = if trimmed.contains('/') || trimmed.contains('\\') {
        Path::new(trimmed)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(trimmed)
    } else {
        // Linux desktop Icon= commonly uses icon theme names like
        // "org.telegram.desktop". Dots are part of the icon name, not a file
        // extension, so keep the raw value for theme lookup.
        trimmed
    };
    search_linux_icon_path(icon_name, size_px)
}

#[cfg(target_os = "linux")]
fn search_linux_icon_path(icon_name: &str, size_px: u32) -> Option<PathBuf> {
    let normalized_icon_name = icon_name.trim();
    if normalized_icon_name.is_empty() {
        return None;
    }
    let mut best_match: Option<(i32, PathBuf)> = None;
    for root in collect_linux_icon_roots() {
        let mut stack = vec![(root, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if depth < 8 {
                        stack.push((path, depth + 1));
                    }
                    continue;
                }
                let stem = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(str::trim)
                    .unwrap_or("");
                if !linux_icon_stem_matches(normalized_icon_name, stem)
                    || image_mime_from_path(&path).is_none()
                {
                    continue;
                }
                let score = score_linux_icon_path(&path, size_px);
                match &best_match {
                    Some((best_score, _)) if *best_score >= score => {}
                    _ => best_match = Some((score, path)),
                }
            }
        }
    }
    best_match.map(|(_, path)| path)
}

#[cfg(target_os = "linux")]
fn linux_icon_stem_matches(expected_icon_name: &str, candidate_stem: &str) -> bool {
    normalize_linux_icon_stem(expected_icon_name).eq_ignore_ascii_case(&normalize_linux_icon_stem(candidate_stem))
}

#[cfg(target_os = "linux")]
fn normalize_linux_icon_stem(value: &str) -> String {
    let mut normalized = value.trim().to_ascii_lowercase();
    for suffix in [
        "-symbolic-ltr",
        "-symbolic-rtl",
        "_symbolic_ltr",
        "_symbolic_rtl",
        ".symbolic-ltr",
        ".symbolic-rtl",
        "-symbolic",
        "_symbolic",
        ".symbolic",
        "-ltr",
        "-rtl",
        "_ltr",
        "_rtl",
    ] {
        if normalized.ends_with(suffix) {
            normalized.truncate(normalized.len() - suffix.len());
            break;
        }
    }
    normalized
}

#[cfg(target_os = "linux")]
fn collect_linux_icon_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home_dir = PathBuf::from(home);
        roots.push(home_dir.join(".local/share/icons"));
        roots.push(home_dir.join(".icons"));
    }
    roots.push(PathBuf::from("/usr/local/share/icons"));
    roots.push(PathBuf::from("/usr/share/icons"));
    roots.push(PathBuf::from("/usr/share/pixmaps"));
    roots
}

#[cfg(target_os = "linux")]
fn score_linux_icon_path(path: &Path, size_px: u32) -> i32 {
    let mut score = match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => 40,
        Some("svg") => 36,
        Some("jpg") | Some("jpeg") => 24,
        Some("gif") => 16,
        Some("webp") => 20,
        Some("ico") => 18,
        _ => 0,
    };
    if let Some(icon_size) = parse_linux_icon_directory_size(path) {
        let diff = (icon_size - size_px as i32).abs().min(96);
        score += 128 - diff;
    } else if path.to_string_lossy().contains("/scalable/") {
        score += 96;
    }
    if path.to_string_lossy().contains("/apps/") {
        score += 12;
    }
    score
}

#[cfg(target_os = "linux")]
fn parse_linux_icon_directory_size(path: &Path) -> Option<i32> {
    for ancestor in path.ancestors() {
        let name = ancestor.file_name()?.to_str()?.trim();
        let Some((width, height)) = name.split_once('x') else {
            continue;
        };
        let Some(parsed_width) = width.parse::<i32>().ok() else {
            continue;
        };
        let Some(parsed_height) = height.parse::<i32>().ok() else {
            continue;
        };
        if parsed_width > 0 && parsed_width == parsed_height {
            return Some(parsed_width);
        }
    }
    None
}

fn resolve_daemon_candidate_base_urls() -> Vec<String> {
    if let Ok(raw_url) = std::env::var("WATERAY_DAEMON_URL") {
        let normalized = raw_url.trim().trim_end_matches('/').to_string();
        if !normalized.is_empty() {
            return vec![normalized];
        }
    }
    DEFAULT_DAEMON_CONTROL_PORT_CANDIDATES
        .iter()
        .map(|port| format!("http://127.0.0.1:{port}"))
        .collect()
}

fn normalize_daemon_base_url(raw_base_url: &str) -> Option<String> {
    let normalized = raw_base_url.trim().trim_end_matches('/').to_string();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn build_daemon_base_url_candidates(
    explicit_base_url: Option<String>,
    remembered_base_url: Option<String>,
) -> Vec<String> {
    let mut candidates = Vec::new();
    for raw_candidate in explicit_base_url
        .into_iter()
        .chain(remembered_base_url.into_iter())
    {
        let Some(normalized_candidate) = normalize_daemon_base_url(&raw_candidate) else {
            continue;
        };
        if !candidates
            .iter()
            .any(|current| current == &normalized_candidate)
        {
            candidates.push(normalized_candidate);
        }
    }
    for candidate in resolve_daemon_candidate_base_urls() {
        if !candidates.iter().any(|current| current == &candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

async fn build_local_reqwest_client(timeout_ms: u64) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .ok()
}

async fn find_reachable_daemon_base_url() -> Option<String> {
    let client = build_local_reqwest_client(DAEMON_PROBE_TIMEOUT_MS).await?;
    for base_url in resolve_daemon_candidate_base_urls() {
        let url = format!("{}{}", base_url, DAEMON_TRANSPORT_BOOTSTRAP_PATH);
        if let Ok(response) = client.get(url).send().await {
            if response.status().is_success() {
                return Some(base_url);
            }
        }
    }
    None
}

async fn read_daemon_transport_bootstrap(
    base_url: &str,
) -> Result<LoopbackTransportBootstrap, String> {
    let client = build_local_reqwest_client(DAEMON_PROBE_TIMEOUT_MS)
        .await
        .ok_or_else(|| "无法创建本地 loopback 客户端".to_string())?;
    let url = format!("{base_url}{DAEMON_TRANSPORT_BOOTSTRAP_PATH}");
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("读取 loopback bootstrap 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "读取 loopback bootstrap 失败：HTTP {}",
            response.status()
        ));
    }
    let payload = response
        .text()
        .await
        .map_err(|error| format!("读取 loopback bootstrap 响应体失败：{error}"))?;
    serde_json::from_str::<LoopbackTransportBootstrap>(&payload)
        .map_err(|error| format!("解析 loopback bootstrap 失败：{error}"))
}

fn is_dev_mode() -> bool {
    if let Ok(mode) = std::env::var("WATERAY_APP_MODE") {
        if mode.trim().eq_ignore_ascii_case("dev") {
            return true;
        }
    }
    cfg!(debug_assertions)
}

fn is_frontend_dev_server_mode() -> bool {
    !is_mobile_platform() && is_dev_mode()
}

fn frontend_ready_timeout_ms() -> u64 {
    if is_mobile_platform() {
        FRONTEND_READY_TIMEOUT_MOBILE_MS
    } else if is_frontend_dev_server_mode() {
        FRONTEND_READY_TIMEOUT_DEV_MS
    } else {
        FRONTEND_READY_TIMEOUT_RELEASE_MS
    }
}

fn format_frontend_timeout_message(timeout_ms: u64) -> String {
    let timeout_seconds = timeout_ms / 1000;
    if is_mobile_platform() {
        return format!(
            "因为移动端前端页面在 {timeout_seconds} 秒内未完成加载，前端无法启动。错误代码 {STARTUP_ERROR_FRONTEND_TIMEOUT}。\n\n可能原因：模拟器或真机首次冷启动较慢、前端资源初始化卡住，或 WebView 页面未成功加载。"
        );
    }
    if is_frontend_dev_server_mode() {
        return format!(
            "因为开发态前端页面在 {timeout_seconds} 秒内未完成加载，前端无法启动。错误代码 {STARTUP_ERROR_FRONTEND_TIMEOUT}。\n\n可能原因：Vite 服务未启动、1420 端口被占用，或 localhost/127.0.0.1 无法访问。"
        );
    }
    format!(
        "因为前端页面在 {timeout_seconds} 秒内未完成加载，前端无法启动。错误代码 {STARTUP_ERROR_FRONTEND_TIMEOUT}。\n\n可能原因：打包资源损坏、前端入口初始化失败，或 WebView 页面未成功加载。"
    )
}

fn format_frontend_bootstrap_failed_message(detail: &str) -> String {
    let normalized_detail = detail.trim();
    if normalized_detail.is_empty() {
        return format!(
            "因为前端初始化抛出异常，前端无法启动。错误代码 {STARTUP_ERROR_FRONTEND_BOOTSTRAP}。"
        );
    }
    format!(
        "因为前端初始化抛出异常，前端无法启动。错误代码 {STARTUP_ERROR_FRONTEND_BOOTSTRAP}。\n\n详细信息：{normalized_detail}"
    )
}

fn show_startup_error_dialog_and_exit(app: AppHandle, title: &'static str, message: String) {
    hide_main_window(&app);
    std::thread::spawn(move || {
        let _ = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show();
        app.exit(1);
    });
}

pub fn start_frontend_startup_guard(app: AppHandle) {
    let timeout_ms = frontend_ready_timeout_ms();
    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_millis(timeout_ms)).await;
        let state = app.state::<FrontendStartupState>();
        if state.is_resolved() || !state.try_mark_failed() {
            return;
        }
        show_startup_error_dialog_and_exit(
            app,
            "前端启动失败",
            format_frontend_timeout_message(timeout_ms),
        );
    });
}

#[cfg(target_os = "windows")]
fn encode_wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn show_windows_error_message_box(title: &str, message: &str) {
    let wide_title = encode_wide_null(title);
    let wide_message = encode_wide_null(message);
    unsafe {
        MessageBoxW(
            None,
            PCWSTR::from_raw(wide_message.as_ptr()),
            PCWSTR::from_raw(wide_title.as_ptr()),
            MB_OK | MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}

#[cfg(target_os = "windows")]
fn detect_webview2_runtime_version() -> Result<String, String> {
    let mut version_ptr = PWSTR::null();
    unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version_ptr) }
        .map_err(|error| error.to_string())?;
    if version_ptr.is_null() {
        return Err("empty version pointer".to_string());
    }

    let value = unsafe { version_ptr.to_string().map_err(|error| error.to_string())? };
    unsafe {
        CoTaskMemFree(Some(version_ptr.0.cast()));
    }
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        return Err("empty version string".to_string());
    }
    Ok(normalized)
}

#[cfg(target_os = "windows")]
pub fn ensure_windows_webview_runtime_or_notify() -> bool {
    match detect_webview2_runtime_version() {
        Ok(_) => true,
        Err(detail) => {
            let message = format!(
                "因为当前系统未检测到可用的 Microsoft Edge WebView2 Runtime，前端无法启动。错误代码 {STARTUP_ERROR_WEBVIEW2_MISSING}。\n\n安装方式：\n1. 打开 https://developer.microsoft.com/en-us/microsoft-edge/webview2/ 下载并安装 Evergreen Runtime。\n2. 无网环境可使用 x64 离线安装包：https://go.microsoft.com/fwlink/?linkid=2124701\n3. 安装完成后重新启动应用。\n\n检测详情：{detail}"
            );
            show_windows_error_message_box("缺少 WebView2 Runtime", &message);
            false
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_windows_webview_runtime_or_notify() -> bool {
    true
}

#[cfg(target_os = "windows")]
pub fn show_preinit_startup_error(title: &str, message: &str) {
    show_windows_error_message_box(title, message);
}

#[cfg(not(target_os = "windows"))]
pub fn show_preinit_startup_error(title: &str, message: &str) {
    eprintln!("{title}: {message}");
}

#[cfg(target_os = "linux")]
fn trim_command_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

#[cfg(target_os = "linux")]
fn format_command_failure(context: &str, output: &std::process::Output) -> String {
    let stderr = trim_command_text(&output.stderr);
    let stdout = trim_command_text(&output.stdout);
    let exit_code = output
        .status
        .code()
        .map_or_else(|| "signal".to_string(), |value| value.to_string());
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit_code={exit_code}")
    };
    format!("{context}失败：{detail}")
}

#[cfg(target_os = "linux")]
fn run_command_capture(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(path) = cwd {
        command.current_dir(path);
    }
    command
        .output()
        .map_err(|error| format!("执行命令失败 {program}: {error}"))
}

#[cfg(target_os = "linux")]
fn run_gsettings_set(schema: &str, key: &str, value: &str) -> Result<(), String> {
    let args = vec![
        "set".to_string(),
        schema.to_string(),
        key.to_string(),
        value.to_string(),
    ];
    let output = run_command_capture("gsettings", &args, None)?;
    if output.status.success() {
        return Ok(());
    }
    Err(format_command_failure(
        &format!("同步 Linux 系统代理 {schema}.{key}"),
        &output,
    ))
}

#[cfg(target_os = "linux")]
fn apply_linux_system_proxy(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Linux 系统代理端口无效".to_string());
    }
    let port_text = port.to_string();
    run_gsettings_set("org.gnome.system.proxy", "use-same-proxy", "true")?;
    run_gsettings_set("org.gnome.system.proxy.http", "host", "127.0.0.1")?;
    run_gsettings_set("org.gnome.system.proxy.http", "port", &port_text)?;
    run_gsettings_set("org.gnome.system.proxy.https", "host", "127.0.0.1")?;
    run_gsettings_set("org.gnome.system.proxy.https", "port", &port_text)?;
    run_gsettings_set("org.gnome.system.proxy.socks", "host", "127.0.0.1")?;
    run_gsettings_set("org.gnome.system.proxy.socks", "port", &port_text)?;
    run_gsettings_set("org.gnome.system.proxy", "mode", "manual")
}

#[cfg(target_os = "linux")]
fn clear_linux_system_proxy() -> Result<(), String> {
    run_gsettings_set("org.gnome.system.proxy", "mode", "none")
}

#[cfg(target_os = "linux")]
fn run_pkexec_command(
    executable_path: &Path,
    args: &[String],
    cwd: &Path,
    context: &str,
) -> Result<(), String> {
    let mut command = Command::new("pkexec");
    command.arg(executable_path);
    command.args(args);
    command.current_dir(cwd);
    let output = command
        .output()
        .map_err(|error| format!("执行 pkexec 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format_command_failure(context, &output))
}

#[cfg(target_os = "linux")]
fn resolve_current_install_dir() -> Result<PathBuf, String> {
    let current_executable =
        std::env::current_exe().map_err(|error| format!("获取当前程序路径失败：{error}"))?;
    current_executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法解析当前安装目录".to_string())
}

#[cfg(target_os = "linux")]
fn extract_embedded_linux_packaged_assets() -> Result<PathBuf, String> {
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("获取 Linux 临时资源时间戳失败：{error}"))?
        .as_millis();
    let extraction_dir = std::env::temp_dir().join(format!(
        "wateray-linux-assets-{}-{unique_suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&extraction_dir)
        .map_err(|error| format!("创建 Linux 临时资源目录失败：{error}"))?;
    for asset in EMBEDDED_LINUX_RELEASE_ASSETS {
        let asset_path = extraction_dir.join(asset.file_name);
        fs::write(&asset_path, asset.bytes).map_err(|error| {
            format!("写入 Linux 临时资源失败 {}: {error}", asset_path.display())
        })?;
        fs::set_permissions(&asset_path, fs::Permissions::from_mode(asset.mode)).map_err(
            |error| {
                format!(
                    "设置 Linux 临时资源权限失败 {}: {error}",
                    asset_path.display()
                )
            },
        )?;
    }
    Ok(extraction_dir)
}

#[cfg(target_os = "linux")]
fn cleanup_embedded_linux_packaged_assets(extraction_dir: &Path) {
    let _ = fs::remove_dir_all(extraction_dir);
}

#[cfg(target_os = "linux")]
fn query_linux_packaged_service_state() -> Result<LinuxSystemdUnitState, String> {
    let unit_name = format!("{LINUX_PACKAGED_SERVICE_NAME}.service");
    let unit_path = PathBuf::from("/etc/systemd/system").join(&unit_name);

    let output = Command::new("systemctl")
        .arg("show")
        .arg(&unit_name)
        .arg("--property=LoadState")
        .arg("--property=ActiveState")
        .arg("--property=FragmentPath")
        .output()
        .map_err(|error| format!("读取 systemd 服务状态失败：{error}"))?;

    let mut load_state = "not-found".to_string();
    let mut active_state = "inactive".to_string();
    let mut fragment_path = String::new();

    if output.status.success() {
        let stdout_text = trim_command_text(&output.stdout);
        for line in stdout_text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let normalized = value.trim().to_string();
            if normalized.is_empty() && key.trim() != "FragmentPath" {
                continue;
            }
            match key.trim() {
                "LoadState" => load_state = normalized,
                "ActiveState" => active_state = normalized,
                "FragmentPath" => fragment_path = normalized,
                _ => {}
            }
        }
    }

    let installed =
        unit_path.exists() || !fragment_path.is_empty() || load_state.as_str() != "not-found";

    Ok(LinuxSystemdUnitState {
        installed,
        active_state,
    })
}

#[cfg(target_os = "linux")]
fn install_or_repair_linux_packaged_service() -> Result<(), String> {
    let install_dir = resolve_current_install_dir()?;
    let extraction_dir = extract_embedded_linux_packaged_assets()?;
    let install_result = run_pkexec_command(
        &extraction_dir.join(LINUX_EMBEDDED_INSTALL_SCRIPT_NAME),
        &[
            "--install-dir".to_string(),
            install_dir.display().to_string(),
        ],
        &extraction_dir,
        "安装或修复 Linux 系统服务",
    );
    cleanup_embedded_linux_packaged_assets(&extraction_dir);
    install_result
}

#[cfg(target_os = "linux")]
async fn ensure_linux_packaged_service_running() -> Result<(), String> {
    if is_daemon_reachable().await {
        return Ok(());
    }

    // Fresh installs or recent restarts can leave systemd active while the HTTP control plane
    // is still coming up, so prefer waiting before escalating to a repair flow.
    if let Ok(service_state) = query_linux_packaged_service_state() {
        if service_state.installed
            && matches!(
                service_state.active_state.as_str(),
                "active" | "activating" | "reloading"
            )
            && wait_daemon_ready().await
        {
            return Ok(());
        }
    }

    install_or_repair_linux_packaged_service()?;

    if wait_daemon_ready().await {
        return Ok(());
    }

    Err(format!(
        "Linux 系统服务已尝试启动，但在 {} 秒内未就绪",
        DAEMON_READY_TIMEOUT_MS / 1000
    ))
}

fn should_manage_packaged_daemon() -> bool {
    if is_dev_mode() {
        return false;
    }

    if let Ok(daemon_url) = std::env::var("WATERAY_DAEMON_URL") {
        let normalized = daemon_url.trim();
        if !normalized.is_empty() && normalized != DEFAULT_DAEMON_BASE_URL {
            return false;
        }
    }

    true
}

#[cfg(not(target_os = "linux"))]
fn resolve_daemon_executable_path() -> Result<PathBuf, String> {
    let current_executable =
        std::env::current_exe().map_err(|error| format!("获取当前程序路径失败：{error}"))?;
    let executable_dir = current_executable
        .parent()
        .ok_or_else(|| "无法解析当前程序目录".to_string())?;
    Ok(executable_dir
        .join("core")
        .join(if cfg!(target_os = "windows") {
            "WaterayServer.exe"
        } else {
            "waterayd"
        }))
}

#[cfg(target_os = "windows")]
fn is_permission_denied_error(error: &std::io::Error) -> bool {
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_ELEVATION_REQUIRED: i32 = 740;
    error.kind() == std::io::ErrorKind::PermissionDenied
        || error.raw_os_error() == Some(ERROR_ACCESS_DENIED)
        || error.raw_os_error() == Some(ERROR_ELEVATION_REQUIRED)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn is_permission_denied_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied
}

#[cfg(target_os = "windows")]
fn spawn_daemon_detached(daemon_executable_path: &Path) -> Result<(), std::io::Error> {
    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let daemon_dir = daemon_executable_path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "无法解析内核目录"))?;

    let mut command = Command::new(daemon_executable_path);
    command
        .current_dir(daemon_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);

    command.spawn()?;
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn spawn_daemon_detached(daemon_executable_path: &Path) -> Result<(), std::io::Error> {
    let daemon_dir = daemon_executable_path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "无法解析内核目录"))?;

    let mut command = Command::new(daemon_executable_path);
    command
        .current_dir(daemon_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command.spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_daemon_elevated_via_uac(daemon_executable_path: &Path) -> bool {
    let daemon_dir = match daemon_executable_path.parent() {
        Some(value) => value,
        None => return false,
    };

    let wide_verb = encode_wide_null("runas");
    let wide_file = encode_wide_null(&daemon_executable_path.to_string_lossy());
    let wide_dir = encode_wide_null(&daemon_dir.to_string_lossy());
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR::from_raw(wide_verb.as_ptr()),
            PCWSTR::from_raw(wide_file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::from_raw(wide_dir.as_ptr()),
            SW_HIDE,
        )
    };

    (result.0 as isize) > 32
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn spawn_daemon_elevated_via_uac(_daemon_executable_path: &Path) -> bool {
    false
}

async fn is_daemon_reachable() -> bool {
    find_reachable_daemon_base_url().await.is_some()
}

async fn wait_daemon_ready() -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(DAEMON_READY_TIMEOUT_MS);
    while std::time::Instant::now() < deadline {
        if is_daemon_reachable().await {
            return true;
        }
        sleep(Duration::from_millis(DAEMON_READY_POLL_INTERVAL_MS)).await;
    }
    false
}

async fn post_daemon_shutdown(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<reqwest::StatusCode, String> {
    let url = format!("{}/v1/system/shutdown", base_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json; charset=utf-8")
        .body("{}")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    Ok(response.status())
}

async fn shutdown_daemon_best_effort(
    explicit_daemon_base_url: Option<String>,
    remembered_daemon_base_url: Option<String>,
) {
    trace_window_flow("shutdown_daemon_best_effort.begin", "");
    let Some(client) = build_local_reqwest_client(DAEMON_SHUTDOWN_TIMEOUT_MS).await else {
        trace_window_flow("shutdown_daemon_best_effort.skip", "client_build_failed");
        return;
    };
    let candidates =
        build_daemon_base_url_candidates(explicit_daemon_base_url, remembered_daemon_base_url);
    for base_url in candidates {
        trace_window_flow(
            "shutdown_daemon_best_effort.try",
            &format!("base_url={base_url}"),
        );
        match post_daemon_shutdown(&client, &base_url).await {
            Ok(status) => {
                trace_window_flow(
                    "shutdown_daemon_best_effort.done",
                    &format!("base_url={base_url}; status={status}"),
                );
                return;
            }
            Err(error) => {
                trace_window_flow(
                    "shutdown_daemon_best_effort.try_failed",
                    &format!("base_url={base_url}; error={error}"),
                );
            }
        }
    }
    trace_window_flow("shutdown_daemon_best_effort.skip", "daemon_unreachable");
}

pub async fn ensure_packaged_daemon_running_impl() -> Result<(), String> {
    if is_mobile_platform() {
        return Ok(());
    }

    if !should_manage_packaged_daemon() {
        return Ok(());
    }

    if is_daemon_reachable().await {
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        return ensure_linux_packaged_service_running().await;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let daemon_executable_path = resolve_daemon_executable_path()?;
        if !daemon_executable_path.exists() {
            return Err(format!(
                "发布态内核文件不存在：{}",
                daemon_executable_path.display()
            ));
        }

        match spawn_daemon_detached(&daemon_executable_path) {
            Ok(()) => {}
            Err(error) => {
                if !is_permission_denied_error(&error) {
                    return Err(format!("拉起内核失败：{error}"));
                }

                if !spawn_daemon_elevated_via_uac(&daemon_executable_path) {
                    return Err(format!(
                        "启动内核需要管理员权限，请在系统弹出的授权窗口中允许 {} 运行。",
                        daemon_executable_path.display()
                    ));
                }
            }
        }

        if wait_daemon_ready().await {
            return Ok(());
        }

        Err(format!(
            "内核进程已尝试启动，但在 {} 秒内未就绪：{}",
            DAEMON_READY_TIMEOUT_MS / 1000,
            daemon_executable_path.display()
        ))
    }
}

#[tauri::command]
pub async fn ensure_packaged_daemon_running() -> Result<(), String> {
    ensure_packaged_daemon_running_impl().await
}

#[tauri::command]
pub async fn daemon_transport_bootstrap(
    daemon_base_url_state: State<'_, DaemonBaseUrlState>,
) -> Result<LoopbackTransportBootstrap, String> {
    trace_window_flow("command.daemon_transport_bootstrap.begin", "");
    if let Err(error) = ensure_packaged_daemon_running_impl().await {
        trace_window_flow("command.daemon_transport_bootstrap.error", &error);
        return Err(error);
    }
    let Some(base_url) = find_reachable_daemon_base_url().await else {
        let error = "桌面端 loopback 控制面未就绪".to_string();
        trace_window_flow("command.daemon_transport_bootstrap.error", &error);
        return Err(error);
    };
    let bootstrap = match read_daemon_transport_bootstrap(&base_url).await {
        Ok(value) => value,
        Err(error) => {
            trace_window_flow("command.daemon_transport_bootstrap.error", &error);
            return Err(error);
        }
    };
    daemon_base_url_state.remember(&base_url);
    trace_window_flow(
        "command.daemon_transport_bootstrap.ok",
        &format!("base_url={base_url}"),
    );
    Ok(bootstrap)
}

#[cfg(target_os = "linux")]
fn linux_sync_system_proxy_impl(enabled: bool, port: Option<u16>) -> Result<(), String> {
    if !enabled {
        return clear_linux_system_proxy();
    }
    let resolved_port = port.unwrap_or(0);
    apply_linux_system_proxy(resolved_port)
}

#[cfg(not(target_os = "linux"))]
fn linux_sync_system_proxy_impl(_enabled: bool, _port: Option<u16>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn linux_sync_system_proxy(enabled: bool, port: Option<u16>) -> Result<(), String> {
    linux_sync_system_proxy_impl(enabled, port)
}

#[tauri::command]
pub fn window_close_panel_keep_core(app: AppHandle) -> Result<(), String> {
    trace_window_flow("command.window_close_panel_keep_core", "");
    #[cfg(target_os = "macos")]
    {
        trace_window_flow("command.window_close_panel_keep_core.sync_path", "");
        close_panel_keep_core_now(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::async_runtime::spawn(async move {
            trace_window_flow("command.window_close_panel_keep_core.task_begin", "");
            close_panel_keep_core(app).await;
        });
        Ok(())
    }
}

#[tauri::command]
pub fn window_quit_app(app: AppHandle) -> Result<(), String> {
    trace_window_flow("command.window_quit_app", "");
    #[cfg(target_os = "macos")]
    {
        trace_window_flow("command.window_quit_app.sync_path", "");
        close_panel_keep_core_now(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::async_runtime::spawn(async move {
            trace_window_flow("command.window_quit_app.task_begin", "");
            close_panel_keep_core(app).await;
        });
        Ok(())
    }
}

#[tauri::command]
pub fn window_quit_all(
    app: AppHandle,
    daemon_base_url: Option<String>,
    daemon_shutdown_handled: Option<bool>,
) -> Result<(), String> {
    trace_window_flow(
        "command.window_quit_all",
        daemon_base_url.as_deref().unwrap_or(""),
    );
    let handled = daemon_shutdown_handled.unwrap_or(false);
    #[cfg(target_os = "macos")]
    if handled {
        trace_window_flow(
            "command.window_quit_all.sync_path",
            daemon_base_url.as_deref().unwrap_or(""),
        );
        quit_all_after_daemon_shutdown(app);
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    tauri::async_runtime::spawn(async move {
        trace_window_flow(
            "command.window_quit_all.task_begin",
            daemon_base_url.as_deref().unwrap_or(""),
        );
        quit_all(app, daemon_base_url, handled).await;
    });
    #[cfg(target_os = "macos")]
    tauri::async_runtime::spawn(async move {
        trace_window_flow(
            "command.window_quit_all.task_begin",
            daemon_base_url.as_deref().unwrap_or(""),
        );
        quit_all(app, daemon_base_url, handled).await;
    });
    Ok(())
}

#[tauri::command]
pub fn frontend_ready(state: State<'_, FrontendStartupState>) {
    state.mark_ready();
}

#[tauri::command]
pub fn frontend_startup_failed(
    app: AppHandle,
    state: State<'_, FrontendStartupState>,
    message: String,
) {
    if !state.try_mark_failed() {
        return;
    }
    show_startup_error_dialog_and_exit(
        app,
        "前端启动失败",
        format_frontend_bootstrap_failed_message(&message),
    );
}

#[tauri::command]
pub fn system_read_text_file(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("file path is required".to_string());
    }

    let target_path = PathBuf::from(trimmed);
    ensure_text_file(&target_path)?;
    let buffer = fs::read(&target_path)
        .map_err(|error| format!("读取文件失败：{} ({error})", target_path.display()))?;
    if buffer.len() > MAX_TEXT_FILE_BYTES {
        return Err("file content is too large".to_string());
    }
    String::from_utf8(buffer).map_err(|error| format!("文件不是 UTF-8 文本：{error}"))
}

#[tauri::command]
pub fn system_write_text_file(path: String, content: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("file path is required".to_string());
    }

    let target_path = PathBuf::from(trimmed);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败：{} ({error})", parent.display()))?;
    }
    fs::write(&target_path, content.as_bytes())
        .map_err(|error| format!("写入文件失败：{} ({error})", target_path.display()))?;
    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn system_write_temp_text_file(file_name: String, content: String) -> Result<String, String> {
    let normalized_file_name = normalize_file_name(&file_name);
    let export_dir = std::env::temp_dir().join("wateray").join("config-export");
    fs::create_dir_all(&export_dir)
        .map_err(|error| format!("创建临时目录失败：{} ({error})", export_dir.display()))?;
    let file_path = export_dir.join(normalized_file_name);
    fs::write(&file_path, content.as_bytes())
        .map_err(|error| format!("写入临时文件失败：{} ({error})", file_path.display()))?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn system_get_file_icon_data_url(
    app: AppHandle,
    path: String,
    size_px: Option<u32>,
) -> Result<Option<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let target_path = PathBuf::from(trimmed);
    if !target_path.exists() {
        return Ok(None);
    }
    Ok(resolve_file_icon_data_url(
        &app,
        &target_path,
        normalize_file_icon_size(size_px),
    ))
}

#[tauri::command]
pub fn system_list_installed_app_candidates(
    app: AppHandle,
    state: State<'_, InstalledDesktopAppCandidatesState>,
) -> Result<Vec<InstalledDesktopAppCandidate>, String> {
    Ok(list_installed_app_candidates_impl(&app, state.inner()))
}

#[tauri::command]
pub fn system_read_clipboard_file_paths() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$items = @(Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue); if ($items) { $items | ForEach-Object { $_ } }",
            ])
            .output()
            .map_err(|error| format!("读取剪贴板文件失败：{error}"))?;

        if !output.status.success() {
            return Ok(Vec::new());
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for line in text.lines() {
            let normalized = line.trim().replace('/', "\\");
            if normalized.is_empty() {
                continue;
            }
            let key = normalized.to_lowercase();
            if seen.insert(key) {
                result.push(normalized);
            }
        }

        return Ok(result);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn system_write_clipboard_file(path: String) -> Result<ClipboardWriteResult, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("file path is required".to_string());
    }

    let target_path = PathBuf::from(trimmed);
    ensure_text_file(&target_path)?;

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Set-Clipboard -Path $env:WATERAY_CLIPBOARD_PATH",
            ])
            .env("WATERAY_CLIPBOARD_PATH", target_path.as_os_str())
            .output()
            .map_err(|error| format!("写入剪贴板文件失败：{error}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(if stderr.trim().is_empty() {
                "写入剪贴板文件失败".to_string()
            } else {
                stderr.trim().to_string()
            });
        }

        return Ok(ClipboardWriteResult {
            mode: "windows_file_object".to_string(),
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("文件剪贴板仅在当前迁移阶段的 Windows 版本中支持".to_string())
    }
}
