use std::cmp::Ordering;
use std::fs;
use std::io::Write;
#[cfg(target_family = "unix")]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_http::reqwest;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::backend;

const UPDATE_STATE_EVENT_NAME: &str = "wateray:app-update-state";
const DEFAULT_UPDATE_FEED_URL: &str =
    "https://github.com/water-ray/wateray-release/releases/latest/download/latest-github.json";
const UPDATE_REQUEST_TIMEOUT_SECS: u64 = 20;
const DOWNLOAD_PROGRESS_EMIT_STEP_BYTES: u64 = 256 * 1024;
const BUNDLE_MANIFEST_FILE_NAME: &str = "bundle-manifest.json";

#[cfg(target_os = "windows")]
const WINDOWS_FRONTEND_EXECUTABLE_NAME: &str = "WaterayApp.exe";
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x00000008;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "linux")]
const LINUX_FRONTEND_EXECUTABLE_NAME: &str = "WaterayApp";
#[cfg(target_os = "linux")]
const LINUX_DEB_INSTALL_DIR: &str = "/opt/wateray";
#[cfg(target_os = "linux")]
const APPIMAGE_RUNTIME_MANIFEST_FILE_NAME: &str = "appimage-current.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCandidate {
    version: String,
    release_tag: String,
    release_name: String,
    release_page_url: String,
    generated_at: String,
    notes_file: String,
    asset_name: String,
    asset_label: String,
    asset_kind: String,
    size_bytes: u64,
    sha256: String,
    download_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    current_version: String,
    current_platform: String,
    install_kind: String,
    supported: bool,
    stage: String,
    status_message: String,
    last_error: String,
    last_checked_at_ms: u64,
    download_progress_percent: u64,
    downloaded_bytes: u64,
    total_bytes: u64,
    candidate: Option<AppUpdateCandidate>,
}

impl Default for AppUpdateState {
    fn default() -> Self {
        Self {
            current_version: String::new(),
            current_platform: "unknown".to_string(),
            install_kind: "unknown".to_string(),
            supported: false,
            stage: "idle".to_string(),
            status_message: String::new(),
            last_error: String::new(),
            last_checked_at_ms: 0,
            download_progress_percent: 0,
            downloaded_bytes: 0,
            total_bytes: 0,
            candidate: None,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseAsset {
    name: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    size_bytes: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    download_url: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseMetadata {
    version: String,
    #[serde(default)]
    release_tag: String,
    #[serde(default)]
    release_name: String,
    #[serde(default)]
    release_page_url: String,
    #[serde(default)]
    generated_at: String,
    #[serde(default)]
    notes_file: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Clone)]
struct SelectedRelease {
    metadata: ReleaseMetadata,
    asset: ReleaseAsset,
}

#[derive(Default)]
struct AppUpdateSession {
    public_state: AppUpdateState,
    selected_release: Option<SelectedRelease>,
    downloaded_file_path: Option<PathBuf>,
}

#[derive(Default)]
pub struct AppUpdateManager {
    session: Mutex<AppUpdateSession>,
    cancel_requested: AtomicBool,
}

struct UpdateRuntimeContext {
    current_version: String,
    current_platform: String,
    install_kind: String,
    supported: bool,
    unsupported_reason: String,
    install_dir: PathBuf,
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsUpdaterPlan {
    current_pid: u32,
    install_dir: String,
    zip_path: String,
    staging_dir: String,
    backup_dir: String,
    tmp_install_dir: String,
    frontend_exe_name: String,
}

#[cfg(target_os = "linux")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppImageRuntimeManifest {
    version: String,
    asset_name: String,
    sha256: String,
    active_path: String,
    installed_at_ms: u64,
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_update_feed_url() -> String {
    let custom = std::env::var("WATERAY_UPDATE_FEED_URL").unwrap_or_default();
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        DEFAULT_UPDATE_FEED_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_dev_mode() -> bool {
    if let Ok(mode) = std::env::var("WATERAY_APP_MODE") {
        if mode.trim().eq_ignore_ascii_case("dev") {
            return true;
        }
    }
    cfg!(debug_assertions)
}

fn detect_current_platform_id() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        "android" => "android",
        "ios" => "ios",
        _ => "unknown",
    }
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

fn lock_session(manager: &AppUpdateManager) -> std::sync::MutexGuard<'_, AppUpdateSession> {
    manager
        .session
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn emit_update_state(app: &AppHandle, state: &AppUpdateState) {
    let _ = app.emit(UPDATE_STATE_EVENT_NAME, state.clone());
}

fn clear_download_progress(state: &mut AppUpdateState) {
    state.download_progress_percent = 0;
    state.downloaded_bytes = 0;
    state.total_bytes = 0;
}

fn safe_asset_file_name(raw: &str) -> Result<String, String> {
    let file_name = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .unwrap_or("");
    if file_name.is_empty() {
        return Err("更新资产文件名无效".to_string());
    }
    Ok(file_name.to_string())
}

fn resolve_current_install_dir() -> Result<PathBuf, String> {
    let current_executable =
        std::env::current_exe().map_err(|error| format!("获取当前程序路径失败：{error}"))?;
    current_executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法解析当前安装目录".to_string())
}

fn read_version_from_bundle_manifest(install_dir: &Path) -> Option<String> {
    let manifest_path = install_dir.join(BUNDLE_MANIFEST_FILE_NAME);
    let payload = serde_json::from_slice::<serde_json::Value>(&fs::read(&manifest_path).ok()?).ok()?;
    let version = payload.get("version")?.as_str()?.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn read_version_file(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let version = content.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn search_version_file_near_executable() -> Option<String> {
    let current_executable = std::env::current_exe().ok()?;
    let mut current_dir = current_executable.parent()?.to_path_buf();
    for _ in 0..8 {
        let candidate = current_dir.join("VERSION");
        if candidate.is_file() {
            if let Some(version) = read_version_file(&candidate) {
                return Some(version);
            }
        }
        if !current_dir.pop() {
            break;
        }
    }
    None
}

fn resolve_runtime_version(app: &AppHandle, install_dir: &Path) -> String {
    if let Some(version) = read_version_from_bundle_manifest(install_dir) {
        return version;
    }
    if let Some(version) = search_version_file_near_executable() {
        return version;
    }
    app.package_info().version.to_string()
}

#[cfg(target_os = "linux")]
fn detect_linux_install_kind(install_dir: &Path) -> (String, bool, String) {
    let normalized = install_dir.to_string_lossy().replace('\\', "/");
    if normalized == LINUX_DEB_INSTALL_DIR || normalized.starts_with(&format!("{LINUX_DEB_INSTALL_DIR}/")) {
        return ("deb".to_string(), true, String::new());
    }
    if normalized.contains("/wateray/appimage/current") {
        return ("appimage".to_string(), true, String::new());
    }
    (
        "unknown".to_string(),
        false,
        "当前 Linux 运行来源暂不支持一键更新，请使用 .deb 或 AppImage 发布包。".to_string(),
    )
}

fn build_runtime_context(app: &AppHandle) -> Result<UpdateRuntimeContext, String> {
    let current_platform = detect_current_platform_id().to_string();
    let install_dir = resolve_current_install_dir()?;
    let current_version = resolve_runtime_version(app, &install_dir);

    if is_dev_mode() {
        return Ok(UpdateRuntimeContext {
            current_version,
            current_platform,
            install_kind: "unknown".to_string(),
            supported: false,
            unsupported_reason: "开发模式暂不支持应用自动更新。".to_string(),
            install_dir,
        });
    }

    match current_platform.as_str() {
        "windows" => Ok(UpdateRuntimeContext {
            current_version,
            current_platform,
            install_kind: "portable-zip".to_string(),
            supported: true,
            unsupported_reason: String::new(),
            install_dir,
        }),
        "linux" => {
            #[cfg(target_os = "linux")]
            {
                let (install_kind, supported, unsupported_reason) =
                    detect_linux_install_kind(&install_dir);
                Ok(UpdateRuntimeContext {
                    current_version,
                    current_platform,
                    install_kind,
                    supported,
                    unsupported_reason,
                    install_dir,
                })
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(UpdateRuntimeContext {
                    current_version,
                    current_platform,
                    install_kind: "unknown".to_string(),
                    supported: false,
                    unsupported_reason: "当前平台更新功能未完成。".to_string(),
                    install_dir,
                })
            }
        }
        "macos" | "android" | "ios" => Ok(UpdateRuntimeContext {
            current_version,
            current_platform,
            install_kind: "unknown".to_string(),
            supported: false,
            unsupported_reason: "当前平台更新功能未完成。".to_string(),
            install_dir,
        }),
        _ => Ok(UpdateRuntimeContext {
            current_version,
            current_platform,
            install_kind: "unknown".to_string(),
            supported: false,
            unsupported_reason: "当前平台更新功能未完成。".to_string(),
            install_dir,
        }),
    }
}

fn sync_state_with_runtime(state: &mut AppUpdateState, context: &UpdateRuntimeContext) {
    state.current_version = context.current_version.clone();
    state.current_platform = context.current_platform.clone();
    state.install_kind = context.install_kind.clone();
    state.supported = context.supported;
    if !context.supported {
        state.stage = "unsupported".to_string();
        state.status_message = context.unsupported_reason.clone();
        state.last_error.clear();
        state.candidate = None;
        clear_download_progress(state);
    } else if state.stage == "unsupported" {
        state.stage = "idle".to_string();
        state.status_message.clear();
    }
}

fn build_error_state(platform: &str, message: &str) -> AppUpdateState {
    let mut state = AppUpdateState::default();
    state.current_platform = platform.to_string();
    state.stage = "error".to_string();
    state.status_message = message.to_string();
    state.last_error = message.to_string();
    state
}

fn build_public_candidate(metadata: &ReleaseMetadata, asset: &ReleaseAsset) -> AppUpdateCandidate {
    AppUpdateCandidate {
        version: metadata.version.clone(),
        release_tag: metadata.release_tag.clone(),
        release_name: metadata.release_name.clone(),
        release_page_url: metadata.release_page_url.clone(),
        generated_at: metadata.generated_at.clone(),
        notes_file: metadata.notes_file.clone(),
        asset_name: asset.name.clone(),
        asset_label: asset.label.clone(),
        asset_kind: asset.kind.clone(),
        size_bytes: asset.size_bytes,
        sha256: asset.sha256.clone(),
        download_url: asset.download_url.clone(),
    }
}

fn parse_semver_triplet(raw: &str) -> Option<(u64, u64, u64)> {
    let mut parts = raw.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn compare_semver_versions(left: &str, right: &str) -> Ordering {
    match (parse_semver_triplet(left), parse_semver_triplet(right)) {
        (Some(lhs), Some(rhs)) => lhs.cmp(&rhs),
        _ => left.trim().cmp(right.trim()),
    }
}

fn resolve_env_dir(name: &str) -> Option<PathBuf> {
    let value = std::env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

#[cfg(target_os = "linux")]
fn resolve_home_dir() -> Option<PathBuf> {
    resolve_env_dir("HOME")
}

fn resolve_update_cache_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(base) = resolve_env_dir("LOCALAPPDATA") {
            return base.join("Wateray").join("updates");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(base) = resolve_env_dir("XDG_CACHE_HOME") {
            return base.join("wateray").join("updates");
        }
        if let Some(home_dir) = resolve_home_dir() {
            return home_dir.join(".cache").join("wateray").join("updates");
        }
    }
    std::env::temp_dir().join("wateray").join("updates")
}

fn resolve_downloads_dir() -> PathBuf {
    resolve_update_cache_root().join("downloads")
}

#[cfg(target_os = "linux")]
fn resolve_linux_appimage_root() -> PathBuf {
    if let Some(base) = resolve_env_dir("XDG_DATA_HOME") {
        return base.join("wateray").join("appimage");
    }
    if let Some(home_dir) = resolve_home_dir() {
        return home_dir
            .join(".local")
            .join("share")
            .join("wateray")
            .join("appimage");
    }
    std::env::temp_dir().join("wateray").join("appimage")
}

fn downloaded_asset_path(asset_name: &str) -> Result<PathBuf, String> {
    let normalized = safe_asset_file_name(asset_name)?;
    Ok(resolve_downloads_dir().join(normalized))
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("创建目录失败：{} ({error})", path.display()))
}

fn write_script_file(prefix: &str, extension: &str, content: &str) -> Result<PathBuf, String> {
    let scripts_dir = resolve_update_cache_root().join("scripts");
    ensure_directory(&scripts_dir)?;
    let path = scripts_dir.join(format!("{prefix}-{}{}", current_timestamp_ms(), extension));
    fs::write(&path, content.as_bytes())
        .map_err(|error| format!("写入更新脚本失败：{} ({error})", path.display()))?;
    #[cfg(target_family = "unix")]
    {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("设置脚本权限失败：{} ({error})", path.display()))?;
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn write_json_file(prefix: &str, payload: &serde_json::Value) -> Result<PathBuf, String> {
    let scripts_dir = resolve_update_cache_root().join("scripts");
    ensure_directory(&scripts_dir)?;
    let path = scripts_dir.join(format!("{prefix}-{}.json", current_timestamp_ms()));
    let content = serde_json::to_vec_pretty(payload)
        .map_err(|error| format!("序列化更新计划失败：{error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("写入更新计划失败：{} ({error})", path.display()))?;
    Ok(path)
}

fn compute_sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取文件失败：{} ({error})", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_matches_sha256(path: &Path, expected_sha256: &str) -> bool {
    let normalized_expected = expected_sha256.trim();
    if normalized_expected.is_empty() || !path.is_file() {
        return false;
    }
    match compute_sha256(path) {
        Ok(actual) => actual.eq_ignore_ascii_case(normalized_expected),
        Err(_) => false,
    }
}

fn update_download_progress(state: &mut AppUpdateState, downloaded_bytes: u64, total_bytes: u64) {
    state.downloaded_bytes = downloaded_bytes;
    state.total_bytes = total_bytes;
    state.download_progress_percent = if total_bytes == 0 {
        0
    } else {
        downloaded_bytes.saturating_mul(100).min(total_bytes.saturating_mul(100)) / total_bytes
    };
}

fn clear_selected_release(session: &mut AppUpdateSession) {
    session.selected_release = None;
    session.downloaded_file_path = None;
    session.public_state.candidate = None;
    clear_download_progress(&mut session.public_state);
}

fn validate_release_metadata(metadata: &ReleaseMetadata) -> Result<(), String> {
    if metadata.version.trim().is_empty() {
        return Err("更新清单缺少版本号".to_string());
    }
    if metadata.assets.is_empty() {
        return Err("更新清单缺少发布资产".to_string());
    }
    Ok(())
}

fn select_release_asset(
    metadata: &ReleaseMetadata,
    context: &UpdateRuntimeContext,
) -> Result<ReleaseAsset, String> {
    metadata
        .assets
        .iter()
        .find(|asset| {
            asset.platform.trim().eq_ignore_ascii_case(&context.current_platform)
                && asset.kind.trim().eq_ignore_ascii_case(&context.install_kind)
                && !asset.name.trim().is_empty()
                && !asset.download_url.trim().is_empty()
                && !asset.sha256.trim().is_empty()
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "发布源缺少适用于当前平台/安装方式的更新包：{} / {}",
                context.current_platform, context.install_kind
            )
        })
}

async fn fetch_latest_release_metadata() -> Result<ReleaseMetadata, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(UPDATE_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("创建更新请求失败：{error}"))?;
    let response = client
        .get(resolve_update_feed_url())
        .send()
        .await
        .map_err(|error| format!("读取更新清单失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("读取更新清单失败：HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取更新清单内容失败：{error}"))?;
    let metadata =
        serde_json::from_slice::<ReleaseMetadata>(&bytes).map_err(|error| format!("解析更新清单失败：{error}"))?;
    validate_release_metadata(&metadata)?;
    Ok(metadata)
}

#[cfg(target_os = "linux")]
fn run_pkexec_script(script_path: &Path, args: &[String], context: &str) -> Result<(), String> {
    let mut command = Command::new("pkexec");
    command.arg(script_path);
    command.args(args);
    let output = command
        .output()
        .map_err(|error| format!("执行 pkexec 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format_command_failure(context, &output))
}

#[cfg(target_os = "windows")]
fn spawn_detached_command(program: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|error| format!("启动外置更新进程失败：{error}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn spawn_detached_command(program: &str, args: &[String]) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|error| format!("启动外置更新进程失败：{error}"))?;
    Ok(())
}

fn emit_state_after_update(
    app: &AppHandle,
    session: &AppUpdateSession,
) -> AppUpdateState {
    let state = session.public_state.clone();
    emit_update_state(app, &state);
    state
}

impl AppUpdateManager {
    fn snapshot(&self, app: &AppHandle) -> AppUpdateState {
        match build_runtime_context(app) {
            Ok(context) => {
                let mut session = lock_session(self);
                sync_state_with_runtime(&mut session.public_state, &context);
                session.public_state.clone()
            }
            Err(error) => build_error_state(detect_current_platform_id(), &error),
        }
    }

    fn update_error_state(&self, app: &AppHandle, message: &str) -> AppUpdateState {
        let mut session = lock_session(self);
        session.public_state = build_error_state(detect_current_platform_id(), message);
        emit_state_after_update(app, &session)
    }

    fn mutate_state<F>(&self, app: &AppHandle, mutate: F) -> Result<AppUpdateState, String>
    where
        F: FnOnce(&mut AppUpdateSession, &UpdateRuntimeContext),
    {
        let context = build_runtime_context(app)?;
        let mut session = lock_session(self);
        sync_state_with_runtime(&mut session.public_state, &context);
        mutate(&mut session, &context);
        Ok(emit_state_after_update(app, &session))
    }

    async fn check_impl(&self, app: &AppHandle) -> Result<AppUpdateState, String> {
        let context = match build_runtime_context(app) {
            Ok(context) => context,
            Err(error) => {
                let _ = self.update_error_state(app, &error);
                return Err(error);
            }
        };

        if !context.supported {
            return self.mutate_state(app, |session, context| {
                clear_selected_release(session);
                session.public_state.stage = "unsupported".to_string();
                session.public_state.status_message = context.unsupported_reason.clone();
                session.public_state.last_error.clear();
                session.public_state.last_checked_at_ms = current_timestamp_ms();
            });
        }

        self.cancel_requested.store(false, AtomicOrdering::SeqCst);
        let _ = self.mutate_state(app, |session, _| {
            session.public_state.stage = "checking".to_string();
            session.public_state.status_message = "正在检查更新。".to_string();
            session.public_state.last_error.clear();
            clear_download_progress(&mut session.public_state);
        })?;

        let metadata = match fetch_latest_release_metadata().await {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = self.mutate_state(app, |session, _| {
                    session.public_state.stage = "error".to_string();
                    session.public_state.status_message = error.clone();
                    session.public_state.last_error = error.clone();
                    session.public_state.last_checked_at_ms = current_timestamp_ms();
                })?;
                return Err(error);
            }
        };

        let asset = match select_release_asset(&metadata, &context) {
            Ok(asset) => asset,
            Err(error) => {
                let _ = self.mutate_state(app, |session, _| {
                    clear_selected_release(session);
                    session.public_state.stage = "error".to_string();
                    session.public_state.status_message = error.clone();
                    session.public_state.last_error = error.clone();
                    session.public_state.last_checked_at_ms = current_timestamp_ms();
                })?;
                return Err(error);
            }
        };

        let comparison = compare_semver_versions(metadata.version.trim(), context.current_version.trim());
        let cached_path = downloaded_asset_path(&asset.name)?;
        let cached_ready = file_matches_sha256(&cached_path, &asset.sha256);

        self.mutate_state(app, |session, _| {
            session.public_state.last_checked_at_ms = current_timestamp_ms();
            session.public_state.last_error.clear();
            if comparison != Ordering::Greater {
                clear_selected_release(session);
                session.public_state.stage = "no_update".to_string();
                session.public_state.status_message =
                    format!("当前已是最新版本 {}", context.current_version.trim());
                return;
            }

            let selected = SelectedRelease {
                metadata: metadata.clone(),
                asset: asset.clone(),
            };
            session.public_state.candidate = Some(build_public_candidate(&metadata, &asset));
            session.selected_release = Some(selected);
            session.downloaded_file_path = if cached_ready {
                Some(cached_path.clone())
            } else {
                None
            };
            if cached_ready {
                session.public_state.stage = "downloaded".to_string();
                session.public_state.status_message =
                    format!("新版本 {} 已准备完成，可以立即安装。", metadata.version.trim());
                update_download_progress(
                    &mut session.public_state,
                    asset.size_bytes,
                    asset.size_bytes,
                );
            } else {
                session.public_state.stage = "available".to_string();
                session.public_state.status_message =
                    format!("发现新版本 {}，可以开始下载。", metadata.version.trim());
                clear_download_progress(&mut session.public_state);
            }
        })
    }

    async fn ensure_selected_release(&self, app: &AppHandle) -> Result<AppUpdateState, String> {
        let current_state = self.snapshot(app);
        if current_state.candidate.is_some() {
            return Ok(current_state);
        }
        self.check_impl(app).await
    }

    async fn download_impl(&self, app: &AppHandle) -> Result<AppUpdateState, String> {
        let initial_state = self.ensure_selected_release(app).await?;
        if !initial_state.supported {
            return Ok(initial_state);
        }
        if initial_state.stage == "downloaded" {
            return Ok(initial_state);
        }
        let selected_release = {
            let session = lock_session(self);
            session.selected_release.clone()
        }
        .ok_or_else(|| "当前没有可下载的更新。".to_string())?;

        let final_path = downloaded_asset_path(&selected_release.asset.name)?;
        if file_matches_sha256(&final_path, &selected_release.asset.sha256) {
            return self.mutate_state(app, |session, _| {
                session.downloaded_file_path = Some(final_path.clone());
                session.public_state.stage = "downloaded".to_string();
                session.public_state.status_message =
                    format!("新版本 {} 已准备完成，可以立即安装。", selected_release.metadata.version);
                session.public_state.last_error.clear();
                update_download_progress(
                    &mut session.public_state,
                    selected_release.asset.size_bytes,
                    selected_release.asset.size_bytes,
                );
            });
        }

        ensure_directory(&resolve_downloads_dir())?;
        let part_path = final_path.with_extension("part");
        if part_path.exists() {
            let _ = fs::remove_file(&part_path);
        }

        self.cancel_requested.store(false, AtomicOrdering::SeqCst);
        let total_bytes = selected_release.asset.size_bytes;
        let _ = self.mutate_state(app, |session, _| {
            session.public_state.stage = "downloading".to_string();
            session.public_state.status_message =
                format!("正在下载新版本 {}。", selected_release.metadata.version);
            session.public_state.last_error.clear();
            update_download_progress(&mut session.public_state, 0, total_bytes);
        })?;

        let download_result: Result<AppUpdateState, String> = async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(UPDATE_REQUEST_TIMEOUT_SECS * 6))
                .build()
                .map_err(|error| format!("创建下载请求失败：{error}"))?;
            let mut response = client
                .get(selected_release.asset.download_url.trim())
                .send()
                .await
                .map_err(|error| format!("下载更新失败：{error}"))?;
            if !response.status().is_success() {
                return Err(format!("下载更新失败：HTTP {}", response.status()));
            }

            let response_total = response.content_length().unwrap_or(total_bytes);
            let mut file = fs::File::create(&part_path)
                .map_err(|error| format!("创建更新缓存失败：{} ({error})", part_path.display()))?;
            let mut hasher = Sha256::new();
            let mut downloaded_bytes = 0_u64;
            let mut last_emitted_bytes = 0_u64;

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| format!("读取下载数据失败：{error}"))?
            {
                if self.cancel_requested.load(AtomicOrdering::SeqCst) {
                    drop(file);
                    let _ = fs::remove_file(&part_path);
                    return self.mutate_state(app, |session, _| {
                        session.downloaded_file_path = None;
                        session.public_state.stage = "available".to_string();
                        session.public_state.status_message = "已取消更新下载。".to_string();
                        session.public_state.last_error.clear();
                        clear_download_progress(&mut session.public_state);
                    });
                }

                file.write_all(&chunk)
                    .map_err(|error| format!("写入更新缓存失败：{} ({error})", part_path.display()))?;
                hasher.update(&chunk);
                downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);

                if downloaded_bytes == response_total
                    || downloaded_bytes.saturating_sub(last_emitted_bytes)
                        >= DOWNLOAD_PROGRESS_EMIT_STEP_BYTES
                {
                    last_emitted_bytes = downloaded_bytes;
                    let _ = self.mutate_state(app, |session, _| {
                        session.public_state.stage = "downloading".to_string();
                        session.public_state.status_message =
                            format!("正在下载新版本 {}。", selected_release.metadata.version);
                        session.public_state.last_error.clear();
                        update_download_progress(
                            &mut session.public_state,
                            downloaded_bytes,
                            response_total,
                        );
                    })?;
                }
            }

            file.flush()
                .map_err(|error| format!("刷新下载缓存失败：{} ({error})", part_path.display()))?;
            drop(file);

            let actual_sha256 = format!("{:x}", hasher.finalize());
            if !actual_sha256.eq_ignore_ascii_case(selected_release.asset.sha256.trim()) {
                let _ = fs::remove_file(&part_path);
                return Err("下载完成，但 SHA-256 校验失败。".to_string());
            }

            if final_path.exists() {
                let _ = fs::remove_file(&final_path);
            }

            fs::rename(&part_path, &final_path).map_err(|error| {
                format!(
                    "保存下载完成的更新文件失败：{} -> {} ({error})",
                    part_path.display(),
                    final_path.display()
                )
            })?;

            self.mutate_state(app, |session, _| {
                session.downloaded_file_path = Some(final_path.clone());
                session.public_state.stage = "downloaded".to_string();
                session.public_state.status_message =
                    format!("新版本 {} 已准备完成，可以立即安装。", selected_release.metadata.version);
                session.public_state.last_error.clear();
                update_download_progress(
                    &mut session.public_state,
                    response_total,
                    response_total,
                );
            })
        }
        .await;

        match download_result {
            Ok(state) => Ok(state),
            Err(error) => {
                let _ = self.mutate_state(app, |session, _| {
                    session.downloaded_file_path = None;
                    session.public_state.stage = "error".to_string();
                    session.public_state.status_message = error.clone();
                    session.public_state.last_error = error.clone();
                    clear_download_progress(&mut session.public_state);
                })?;
                Err(error)
            }
        }
    }

    async fn install_impl(&self, app: &AppHandle) -> Result<AppUpdateState, String> {
        let current_state = self.snapshot(app);
        if !current_state.supported {
            return Ok(current_state);
        }

        let maybe_state = if current_state.stage != "downloaded" {
            self.download_impl(app).await?
        } else {
            current_state
        };
        if maybe_state.stage != "downloaded" {
            return Ok(maybe_state);
        }

        let context = build_runtime_context(app)?;
        let (selected_release, downloaded_file_path) = {
            let session = lock_session(self);
            (
                session.selected_release.clone(),
                session.downloaded_file_path.clone(),
            )
        };
        let selected_release =
            selected_release.ok_or_else(|| "缺少待安装的更新资产信息。".to_string())?;
        let downloaded_file_path =
            downloaded_file_path.ok_or_else(|| "缺少已下载的更新文件。".to_string())?;

        let _ = self.mutate_state(app, |session, _| {
            session.public_state.stage = "installing".to_string();
            session.public_state.status_message =
                format!("正在安装新版本 {}。", selected_release.metadata.version);
            session.public_state.last_error.clear();
        })?;

        let install_result = match context.current_platform.as_str() {
            "windows" => {
                #[cfg(target_os = "windows")]
                {
                    let update_root = resolve_update_cache_root();
                    ensure_directory(&update_root)?;
                    let plan = WindowsUpdaterPlan {
                        current_pid: std::process::id(),
                        install_dir: context.install_dir.to_string_lossy().to_string(),
                        zip_path: downloaded_file_path.to_string_lossy().to_string(),
                        staging_dir: update_root.join("staging").to_string_lossy().to_string(),
                        backup_dir: update_root.join("backup").to_string_lossy().to_string(),
                        tmp_install_dir: update_root
                            .join("installing")
                            .to_string_lossy()
                            .to_string(),
                        frontend_exe_name: WINDOWS_FRONTEND_EXECUTABLE_NAME.to_string(),
                    };
                    let plan_value =
                        serde_json::to_value(&plan).map_err(|error| format!("序列化更新计划失败：{error}"))?;
                    let plan_path = write_json_file("windows-update-plan", &plan_value)?;
                    let script_path =
                        write_script_file("windows-apply-update", ".ps1", windows_update_script())?;
                    spawn_detached_command(
                        "powershell.exe",
                        &[
                            "-NoProfile".to_string(),
                            "-ExecutionPolicy".to_string(),
                            "Bypass".to_string(),
                            "-File".to_string(),
                            script_path.to_string_lossy().to_string(),
                            plan_path.to_string_lossy().to_string(),
                        ],
                    )?;
                    let state = self.mutate_state(app, |session, _| {
                        session.public_state.stage = "installing".to_string();
                        session.public_state.status_message =
                            "更新已准备完成，客户端即将退出并自动替换到新版本。".to_string();
                        session.public_state.last_error.clear();
                    })?;
                    backend::window_quit_all(app.clone())?;
                    Ok(state)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let error = "当前宿主无法执行 Windows 更新流程。".to_string();
                    let _ = self.mutate_state(app, |session, _| {
                        session.public_state.stage = "error".to_string();
                        session.public_state.status_message = error.clone();
                        session.public_state.last_error = error.clone();
                    })?;
                    Err(error)
                }
            }
            "linux" => {
                #[cfg(target_os = "linux")]
                {
                    match context.install_kind.as_str() {
                        "deb" => {
                            let installer_script = write_script_file(
                                "linux-install-deb",
                                ".sh",
                                linux_deb_installer_script(),
                            )?;
                            run_pkexec_script(
                                &installer_script,
                                &[downloaded_file_path.to_string_lossy().to_string()],
                                "安装 Linux .deb 更新",
                            )?;
                            let relaunch_script = write_script_file(
                                "linux-relaunch-client",
                                ".sh",
                                linux_relaunch_script(),
                            )?;
                            let relaunch_program =
                                relaunch_script.to_string_lossy().to_string();
                            spawn_detached_command(
                                relaunch_program.as_str(),
                                &[
                                    std::process::id().to_string(),
                                    context
                                        .install_dir
                                        .join(LINUX_FRONTEND_EXECUTABLE_NAME)
                                        .to_string_lossy()
                                        .to_string(),
                                ],
                            )?;
                            let state = self.mutate_state(app, |session, _| {
                                session.public_state.stage = "installing".to_string();
                                session.public_state.status_message =
                                    "Linux .deb 更新已安装完成，客户端即将自动重启。".to_string();
                                session.public_state.last_error.clear();
                            })?;
                            backend::window_close_panel_keep_core(app.clone())?;
                            Ok(state)
                        }
                        "appimage" => {
                            let appimage_root = resolve_linux_appimage_root();
                            let releases_dir = appimage_root.join("releases");
                            ensure_directory(&releases_dir)?;
                            let release_path = releases_dir.join(safe_asset_file_name(
                                &selected_release.asset.name,
                            )?);
                            fs::copy(&downloaded_file_path, &release_path).map_err(|error| {
                                format!(
                                    "写入 AppImage 发布文件失败：{} -> {} ({error})",
                                    downloaded_file_path.display(),
                                    release_path.display()
                                )
                            })?;
                            fs::set_permissions(&release_path, fs::Permissions::from_mode(0o755))
                                .map_err(|error| {
                                    format!(
                                        "设置 AppImage 可执行权限失败：{} ({error})",
                                        release_path.display()
                                    )
                                })?;
                            let manifest = AppImageRuntimeManifest {
                                version: selected_release.metadata.version.clone(),
                                asset_name: selected_release.asset.name.clone(),
                                sha256: selected_release.asset.sha256.clone(),
                                active_path: release_path.to_string_lossy().to_string(),
                                installed_at_ms: current_timestamp_ms(),
                            };
                            let manifest_path =
                                appimage_root.join(APPIMAGE_RUNTIME_MANIFEST_FILE_NAME);
                            ensure_directory(&appimage_root)?;
                            let manifest_bytes = serde_json::to_vec_pretty(&manifest)
                                .map_err(|error| format!("序列化 AppImage 运行清单失败：{error}"))?;
                            fs::write(&manifest_path, manifest_bytes).map_err(|error| {
                                format!(
                                    "写入 AppImage 运行清单失败：{} ({error})",
                                    manifest_path.display()
                                )
                            })?;

                            let relaunch_script = write_script_file(
                                "linux-relaunch-client",
                                ".sh",
                                linux_relaunch_script(),
                            )?;
                            let relaunch_program =
                                relaunch_script.to_string_lossy().to_string();
                            spawn_detached_command(
                                relaunch_program.as_str(),
                                &[
                                    std::process::id().to_string(),
                                    release_path.to_string_lossy().to_string(),
                                ],
                            )?;
                            let state = self.mutate_state(app, |session, _| {
                                session.public_state.stage = "installing".to_string();
                                session.public_state.status_message =
                                    "AppImage 更新已切换完成，客户端即将自动重启。".to_string();
                                session.public_state.last_error.clear();
                            })?;
                            backend::window_close_panel_keep_core(app.clone())?;
                            Ok(state)
                        }
                        _ => {
                            let error =
                                "当前 Linux 运行来源暂不支持自动安装，请使用 .deb 或 AppImage。".to_string();
                            let _ = self.mutate_state(app, |session, _| {
                                session.public_state.stage = "error".to_string();
                                session.public_state.status_message = error.clone();
                                session.public_state.last_error = error.clone();
                            })?;
                            Err(error)
                        }
                    }
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let error = "当前宿主无法执行 Linux 更新流程。".to_string();
                    let _ = self.mutate_state(app, |session, _| {
                        session.public_state.stage = "error".to_string();
                        session.public_state.status_message = error.clone();
                        session.public_state.last_error = error.clone();
                    })?;
                    Err(error)
                }
            }
            _ => {
                let error = "当前平台更新功能未完成。".to_string();
                let _ = self.mutate_state(app, |session, _| {
                    session.public_state.stage = "unsupported".to_string();
                    session.public_state.status_message = error.clone();
                    session.public_state.last_error.clear();
                })?;
                Ok(self.snapshot(app))
            }
        };

        match install_result {
            Ok(state) => Ok(state),
            Err(error) => {
                let _ = self.mutate_state(app, |session, _| {
                    session.public_state.stage = "error".to_string();
                    session.public_state.status_message = error.clone();
                    session.public_state.last_error = error.clone();
                })?;
                Err(error)
            }
        }
    }

    fn cancel_impl(&self, app: &AppHandle) -> Result<AppUpdateState, String> {
        let state = self.snapshot(app);
        if state.stage != "downloading" {
            return Ok(state);
        }
        self.cancel_requested.store(true, AtomicOrdering::SeqCst);
        self.mutate_state(app, |session, _| {
            session.public_state.stage = "downloading".to_string();
            session.public_state.status_message = "正在取消更新下载。".to_string();
            session.public_state.last_error.clear();
        })
    }
}

#[cfg(target_os = "windows")]
fn windows_update_script() -> &'static str {
    r#"
param(
  [Parameter(Mandatory = $true)]
  [string]$PlanPath
)

$ErrorActionPreference = 'Stop'

function Show-UpdateFailure([string]$Message) {
  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue | Out-Null
    [System.Windows.MessageBox]::Show($Message, 'Wateray 更新失败') | Out-Null
  } catch {
  }
}

try {
  $plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
  $waitPid = [int]$plan.currentPid
  $installDir = [string]$plan.installDir
  $zipPath = [string]$plan.zipPath
  $stagingDir = [string]$plan.stagingDir
  $backupDir = [string]$plan.backupDir
  $tmpInstallDir = [string]$plan.tmpInstallDir
  $frontendExeName = [string]$plan.frontendExeName

  for ($i = 0; $i -lt 600; $i++) {
    if (-not (Get-Process -Id $waitPid -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $waitPid -ErrorAction SilentlyContinue) {
    throw '等待旧版本退出超时。'
  }

  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmpInstallDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $stagingDir -Force

  $entries = @(Get-ChildItem -LiteralPath $stagingDir)
  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
    $sourceDir = $entries[0].FullName
  } else {
    $sourceDir = $stagingDir
  }

  Move-Item -LiteralPath $sourceDir -Destination $tmpInstallDir -Force
  if (Test-Path -LiteralPath $installDir) {
    Move-Item -LiteralPath $installDir -Destination $backupDir -Force
  }
  Move-Item -LiteralPath $tmpInstallDir -Destination $installDir -Force

  $exePath = Join-Path $installDir $frontendExeName
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "更新后的客户端入口不存在：$exePath"
  }

  Start-Process -FilePath $exePath -WorkingDirectory $installDir | Out-Null
  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PlanPath -Force -ErrorAction SilentlyContinue
} catch {
  try {
    if ((Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $installDir)) {
      Move-Item -LiteralPath $backupDir -Destination $installDir -Force
    }
  } catch {
  }
  Show-UpdateFailure("Wateray 更新失败：$($_.Exception.Message)")
  exit 1
}
"#
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn windows_update_script() -> &'static str {
    ""
}

#[cfg(target_os = "linux")]
fn linux_deb_installer_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root." >&2
  exit 1
fi

deb_path="${1:-}"
if [ -z "$deb_path" ] || [ ! -f "$deb_path" ]; then
  echo "Invalid deb package path: $deb_path" >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  if env DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb_path"; then
    exit 0
  fi
fi

if ! command -v dpkg >/dev/null 2>&1; then
  echo "Missing dpkg command." >&2
  exit 1
fi

if dpkg -i "$deb_path"; then
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then
  env DEBIAN_FRONTEND=noninteractive apt-get -f install -y
  exit $?
fi

exit 1
"#
}

#[cfg(not(target_os = "linux"))]
fn linux_deb_installer_script() -> &'static str {
    ""
}

#[cfg(target_os = "linux")]
fn linux_relaunch_script() -> &'static str {
    r#"#!/usr/bin/env sh
set -eu

wait_pid="${1:-}"
launch_path="${2:-}"

if [ -z "$wait_pid" ] || [ -z "$launch_path" ]; then
  exit 1
fi

while kill -0 "$wait_pid" 2>/dev/null; do
  sleep 0.2
done

launch_dir="$(dirname "$launch_path")"
cd "$launch_dir"
nohup "$launch_path" >/dev/null 2>&1 &
"#
}

#[cfg(not(target_os = "linux"))]
fn linux_relaunch_script() -> &'static str {
    ""
}

#[tauri::command]
pub fn app_update_get_state(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateState, String> {
    Ok(manager.snapshot(&app))
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateState, String> {
    manager.check_impl(&app).await
}

#[tauri::command]
pub async fn app_update_start_download(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateState, String> {
    manager.download_impl(&app).await
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateState, String> {
    manager.install_impl(&app).await
}

#[tauri::command]
pub fn app_update_cancel(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateState, String> {
    manager.cancel_impl(&app)
}

#[cfg(test)]
mod tests {
    use super::{
        compare_semver_versions, parse_semver_triplet, select_release_asset, ReleaseAsset,
        ReleaseMetadata, UpdateRuntimeContext,
    };
    use std::cmp::Ordering;
    use std::path::PathBuf;

    #[test]
    fn parse_semver_triplet_accepts_three_numbers() {
        assert_eq!(parse_semver_triplet("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver_triplet(" 10.20.30 "), Some((10, 20, 30)));
    }

    #[test]
    fn parse_semver_triplet_rejects_invalid_values() {
        assert_eq!(parse_semver_triplet("1.2"), None);
        assert_eq!(parse_semver_triplet("1.2.3.4"), None);
        assert_eq!(parse_semver_triplet("1.a.3"), None);
    }

    #[test]
    fn compare_semver_versions_prefers_numeric_order() {
        assert_eq!(compare_semver_versions("1.2.10", "1.2.2"), Ordering::Greater);
        assert_eq!(compare_semver_versions("1.2.2", "1.2.10"), Ordering::Less);
        assert_eq!(compare_semver_versions("1.2.2", "1.2.2"), Ordering::Equal);
    }

    #[test]
    fn select_release_asset_matches_platform_and_install_kind() {
        let metadata = ReleaseMetadata {
            version: "1.2.3".to_string(),
            release_tag: "v1.2.3".to_string(),
            release_name: "Wateray v1.2.3".to_string(),
            release_page_url: "https://example.invalid".to_string(),
            generated_at: String::new(),
            notes_file: String::new(),
            assets: vec![
                ReleaseAsset {
                    name: "Wateray-windows-v1.2.3.zip".to_string(),
                    label: "Windows".to_string(),
                    platform: "windows".to_string(),
                    kind: "portable-zip".to_string(),
                    size_bytes: 1,
                    sha256: "abc".to_string(),
                    download_url: "https://example.invalid/windows.zip".to_string(),
                },
                ReleaseAsset {
                    name: "wateray_1.2.3_amd64.deb".to_string(),
                    label: "Linux deb".to_string(),
                    platform: "linux".to_string(),
                    kind: "deb".to_string(),
                    size_bytes: 2,
                    sha256: "def".to_string(),
                    download_url: "https://example.invalid/linux.deb".to_string(),
                },
            ],
        };
        let windows_context = UpdateRuntimeContext {
            current_version: "1.2.2".to_string(),
            current_platform: "windows".to_string(),
            install_kind: "portable-zip".to_string(),
            supported: true,
            unsupported_reason: String::new(),
            install_dir: PathBuf::from("C:/Wateray"),
        };
        let linux_context = UpdateRuntimeContext {
            current_version: "1.2.2".to_string(),
            current_platform: "linux".to_string(),
            install_kind: "deb".to_string(),
            supported: true,
            unsupported_reason: String::new(),
            install_dir: PathBuf::from("/opt/wateray"),
        };

        assert_eq!(
            select_release_asset(&metadata, &windows_context)
                .expect("windows asset")
                .name,
            "Wateray-windows-v1.2.3.zip"
        );
        assert_eq!(
            select_release_asset(&metadata, &linux_context)
                .expect("linux asset")
                .name,
            "wateray_1.2.3_amd64.deb"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_linux_install_kind_matches_expected_layouts() {
        let (deb_kind, deb_supported, _) =
            super::detect_linux_install_kind(&PathBuf::from("/opt/wateray"));
        let (appimage_kind, appimage_supported, _) = super::detect_linux_install_kind(
            &PathBuf::from("/home/user/.local/share/wateray/appimage/current"),
        );
        let (other_kind, other_supported, _) =
            super::detect_linux_install_kind(&PathBuf::from("/tmp/wateray"));

        assert_eq!(deb_kind, "deb");
        assert!(deb_supported);
        assert_eq!(appimage_kind, "appimage");
        assert!(appimage_supported);
        assert_eq!(other_kind, "unknown");
        assert!(!other_supported);
    }
}
