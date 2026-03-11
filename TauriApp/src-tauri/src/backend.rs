use std::fs;
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(target_os = "linux")]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(target_os = "linux"))]
use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};
use tokio::time::sleep;

use tauri_plugin_http::reqwest;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(target_os = "windows")]
use webview2_com_sys::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
#[cfg(target_os = "windows")]
use windows::core::{PCWSTR, PWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::CoTaskMemFree;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, SW_HIDE, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
};

const DEFAULT_DAEMON_BASE_URL: &str = "http://127.0.0.1:39080";
const DAEMON_PROBE_PATH: &str = "/v1/state?withLogs=0";
const DAEMON_PROBE_TIMEOUT_MS: u64 = 1200;
const DAEMON_READY_TIMEOUT_MS: u64 = 12_000;
const DAEMON_READY_POLL_INTERVAL_MS: u64 = 300;
const DAEMON_SHUTDOWN_TIMEOUT_MS: u64 = 1200;
const FRONTEND_READY_TIMEOUT_DEV_MS: u64 = 20_000;
const FRONTEND_READY_TIMEOUT_RELEASE_MS: u64 = 12_000;
const MAX_TEXT_FILE_BYTES: usize = 16 * 1024 * 1024;
#[cfg(target_os = "windows")]
const STARTUP_ERROR_WEBVIEW2_MISSING: &str = "WEBVIEW2_RUNTIME_MISSING";
const STARTUP_ERROR_FRONTEND_TIMEOUT: &str = "FRONTEND_READY_TIMEOUT";
const STARTUP_ERROR_FRONTEND_BOOTSTRAP: &str = "FRONTEND_BOOTSTRAP_FAILED";
const TRAY_ID: &str = "wateray-tray";
const TRAY_MENU_OPEN_MAIN_WINDOW: &str = "tray-open-main-window";
const TRAY_MENU_QUIT_PANEL_ONLY: &str = "tray-quit-panel-only";
const TRAY_MENU_QUIT_ALL: &str = "tray-quit-all";
#[cfg(target_os = "linux")]
const LINUX_PACKAGED_SERVICE_NAME: &str = "waterayd";
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

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

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

fn should_restore_main_window_from_tray_event(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        }
            | TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
    )
}

fn close_panel_keep_core(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        hide_main_window(&app);
        sleep(Duration::from_millis(10)).await;
        app.exit(0);
    });
}

fn quit_all(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        hide_main_window(&app);
        #[cfg(target_os = "linux")]
        if let Err(error) = clear_linux_system_proxy() {
            eprintln!("failed to clear linux system proxy before quit: {error}");
        }
        shutdown_daemon_best_effort().await;
        sleep(Duration::from_millis(10)).await;
        app.exit(0);
    });
}

pub fn apply_main_window_icon(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(icon) = app.default_window_icon().cloned() else {
        return;
    };
    let _ = window.set_icon(icon);
}

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
        .text(TRAY_MENU_QUIT_PANEL_ONLY, "普通退出（仅面板）")
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
            TRAY_MENU_QUIT_PANEL_ONLY => close_panel_keep_core(app.clone()),
            TRAY_MENU_QUIT_ALL => quit_all(app.clone()),
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

fn daemon_base_url() -> String {
    std::env::var("WATERAY_DAEMON_URL")
        .unwrap_or_else(|_| DEFAULT_DAEMON_BASE_URL.to_string())
        .trim()
        .to_string()
}

fn is_dev_mode() -> bool {
    if let Ok(mode) = std::env::var("WATERAY_APP_MODE") {
        if mode.trim().eq_ignore_ascii_case("dev") {
            return true;
        }
    }
    cfg!(debug_assertions)
}

fn frontend_ready_timeout_ms() -> u64 {
    if is_dev_mode() {
        FRONTEND_READY_TIMEOUT_DEV_MS
    } else {
        FRONTEND_READY_TIMEOUT_RELEASE_MS
    }
}

fn format_frontend_timeout_message(timeout_ms: u64) -> String {
    let timeout_seconds = timeout_ms / 1000;
    if is_dev_mode() {
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
    let unique_suffix = SystemTime::now()
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
        fs::write(&asset_path, asset.bytes)
            .map_err(|error| format!("写入 Linux 临时资源失败 {}: {error}", asset_path.display()))?;
        fs::set_permissions(&asset_path, fs::Permissions::from_mode(asset.mode)).map_err(|error| {
            format!("设置 Linux 临时资源权限失败 {}: {error}", asset_path.display())
        })?;
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
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(DAEMON_PROBE_TIMEOUT_MS))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    let url = format!("{}{}", daemon_base_url(), DAEMON_PROBE_PATH);
    match client.get(url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
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

async fn shutdown_daemon_best_effort() {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(DAEMON_SHUTDOWN_TIMEOUT_MS))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };

    let url = format!("{}/v1/system/shutdown", daemon_base_url());
    let _ = client
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json; charset=utf-8")
        .body("{}")
        .send()
        .await;
}

pub async fn ensure_packaged_daemon_running_impl() -> Result<(), String> {
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
    close_panel_keep_core(app);
    Ok(())
}

#[tauri::command]
pub fn window_quit_app(app: AppHandle) -> Result<(), String> {
    window_close_panel_keep_core(app)
}

#[tauri::command]
pub fn window_quit_all(app: AppHandle) -> Result<(), String> {
    quit_all(app);
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
