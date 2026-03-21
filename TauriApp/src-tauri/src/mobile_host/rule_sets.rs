use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager as _, Runtime};
use tauri_plugin_http::reqwest;

const GEOIP_RULE_SET_URL_TEMPLATE: &str =
    "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-%s.srs";
const GEOSITE_RULE_SET_URL_TEMPLATE: &str =
    "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-%s.srs";
const RULE_SET_MAX_SIZE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleSetStatusRequest {
    geoip: Option<Vec<String>>,
    geosite: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleSetUpdateRequest {
    geoip: Option<Vec<String>>,
    geosite: Option<Vec<String>>,
    download_mode: Option<String>,
    proxy_url: Option<String>,
    proxy_via_tun: Option<bool>,
}

#[derive(Debug, Clone)]
struct BuiltInRuleSetTarget {
    tag: String,
    kind: String,
    value: String,
    url: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRuleSetStatusItem {
    kind: String,
    value: String,
    tag: String,
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRuleSetStatusResponse {
    statuses: Vec<MobileRuleSetStatusItem>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRuleSetUpdateSummary {
    requested: usize,
    success: usize,
    failed: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    updated_tags: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    failed_items: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRuleSetUpdateResponse {
    statuses: Vec<MobileRuleSetStatusItem>,
    summary: MobileRuleSetUpdateSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleSetDownloadMode {
    Auto,
    Direct,
    Proxy,
}

fn normalize_geo_rule_set_value(raw_value: &str) -> String {
    let value = raw_value.trim().to_lowercase();
    if value.is_empty() {
        return String::new();
    }
    let normalized = value
        .chars()
        .map(|char| {
            if char.is_ascii_lowercase()
                || char.is_ascii_digit()
                || matches!(char, '-' | '_' | '.' | '!' | '@')
            {
                char
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .replace('_', "-");
    normalized
}

fn normalize_download_mode(raw_mode: Option<&str>) -> RuleSetDownloadMode {
    match raw_mode
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "direct" => RuleSetDownloadMode::Direct,
        "proxy" => RuleSetDownloadMode::Proxy,
        _ => RuleSetDownloadMode::Auto,
    }
}

fn resolve_rule_set_storage_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("rule-set"))
        .map_err(|error| format!("解析移动端规则集目录失败: {error}"))
}

fn resolve_rule_set_local_path<R: Runtime>(
    app: &AppHandle<R>,
    kind: &str,
    value: &str,
) -> Result<PathBuf, String> {
    let file_name = format!("{kind}-{value}.srs");
    Ok(resolve_rule_set_storage_dir(app)?.join(file_name))
}

fn resolve_bundled_rule_set_path<R: Runtime>(
    app: &AppHandle<R>,
    kind: &str,
    value: &str,
) -> Option<PathBuf> {
    let file_name = format!("{kind}-{value}.srs");
    let relative_candidates = [
        format!("default-config/rule-set/{file_name}"),
        format!("_up_/default-config/rule-set/{file_name}"),
    ];
    for relative in &relative_candidates {
        if let Ok(path) = app.path().resolve(relative, BaseDirectory::Resource) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for relative in &relative_candidates {
            let path = resource_dir.join(relative);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn ensure_bundled_rule_set_ready<R: Runtime>(
    app: &AppHandle<R>,
    target: &BuiltInRuleSetTarget,
) -> Result<(), String> {
    if target.path.is_file() {
        return Ok(());
    }
    let Some(source_path) = resolve_bundled_rule_set_path(app, &target.kind, &target.value) else {
        return Ok(());
    };
    if let Some(parent) = target.path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建移动端规则集目录失败: {error}"))?;
    }
    fs::copy(&source_path, &target.path).map_err(|error| format!("复制内置规则集失败: {error}"))?;
    Ok(())
}

fn resolve_rule_set_updated_at_ms(path: &Path) -> Option<i64> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(elapsed.as_millis() as i64)
}

fn build_status_item<R: Runtime>(
    app: &AppHandle<R>,
    target: &BuiltInRuleSetTarget,
) -> MobileRuleSetStatusItem {
    let _ = ensure_bundled_rule_set_ready(app, target);
    let exists = target.path.is_file();
    MobileRuleSetStatusItem {
        kind: target.kind.clone(),
        value: target.value.clone(),
        tag: target.tag.clone(),
        exists,
        updated_at_ms: if exists {
            resolve_rule_set_updated_at_ms(&target.path)
        } else {
            None
        },
        local_path: if exists {
            Some(target.path.to_string_lossy().to_string())
        } else {
            None
        },
    }
}

fn build_status_items<R: Runtime>(
    app: &AppHandle<R>,
    targets: &[BuiltInRuleSetTarget],
) -> Vec<MobileRuleSetStatusItem> {
    targets
        .iter()
        .map(|target| build_status_item(app, target))
        .collect()
}

fn collect_rule_set_targets<R: Runtime>(
    app: &AppHandle<R>,
    geoip_values: &[String],
    geosite_values: &[String],
) -> Result<Vec<BuiltInRuleSetTarget>, String> {
    let mut targets_by_tag = BTreeMap::<String, BuiltInRuleSetTarget>::new();
    let mut append_target = |kind: &str, raw_value: &str| -> Result<(), String> {
        let value = normalize_geo_rule_set_value(raw_value);
        if value.is_empty() || (kind == "geoip" && value == "private") {
            return Ok(());
        }
        let tag = format!("wateray-{kind}-{value}");
        if targets_by_tag.contains_key(&tag) {
            return Ok(());
        }
        let url = match kind {
            "geoip" => GEOIP_RULE_SET_URL_TEMPLATE.replace("%s", &value),
            "geosite" => GEOSITE_RULE_SET_URL_TEMPLATE.replace("%s", &value),
            _ => return Ok(()),
        };
        let path = resolve_rule_set_local_path(app, kind, &value)?;
        targets_by_tag.insert(
            tag.clone(),
            BuiltInRuleSetTarget {
                tag,
                kind: kind.to_string(),
                value,
                url,
                path,
            },
        );
        Ok(())
    };

    for value in geoip_values {
        append_target("geoip", value)?;
    }
    for value in geosite_values {
        append_target("geosite", value)?;
    }

    Ok(targets_by_tag.into_values().collect())
}

async fn download_rule_set_file(
    url: &str,
    target_path: &Path,
    proxy_url: Option<&str>,
) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("rule-set url is empty".to_string());
    }
    let mut client_builder = reqwest::Client::builder().timeout(Duration::from_secs(45));
    if let Some(proxy) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        let parsed_proxy = reqwest::Proxy::all(proxy)
            .map_err(|error| format!("invalid proxy url {proxy:?}: {error}"))?;
        client_builder = client_builder.proxy(parsed_proxy);
    }
    let client = client_builder
        .build()
        .map_err(|error| format!("create http client failed: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("status={status} body={}", body.trim()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("read response failed: {error}"))?;
    if bytes.is_empty() {
        return Err("downloaded file is empty".to_string());
    }
    if bytes.len() > RULE_SET_MAX_SIZE_BYTES {
        return Err("downloaded file is too large".to_string());
    }
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create rule-set dir failed: {error}"))?;
    }
    let tmp_path = PathBuf::from(format!("{}.tmp", target_path.to_string_lossy()));
    if let Err(error) = fs::write(&tmp_path, bytes.as_ref()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("write file failed: {error}"));
    }
    if let Err(error) = fs::rename(&tmp_path, target_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("save file failed: {error}"));
    }
    Ok(())
}

async fn download_target_by_mode(
    target: &BuiltInRuleSetTarget,
    mode: RuleSetDownloadMode,
    proxy_url: Option<&str>,
    proxy_via_tun: bool,
) -> Result<(), String> {
    let non_empty_proxy_url = proxy_url.map(str::trim).filter(|value| !value.is_empty());
    match mode {
        RuleSetDownloadMode::Direct => download_rule_set_file(&target.url, &target.path, None)
            .await
            .map_err(|error| format!("{} 更新失败（直连: {error}）", target.tag)),
        RuleSetDownloadMode::Proxy => {
            if let Some(proxy) = non_empty_proxy_url {
                let proxy_result =
                    download_rule_set_file(&target.url, &target.path, Some(proxy)).await;
                if proxy_result.is_ok() {
                    return Ok(());
                }
                if proxy_via_tun {
                    let tun_result = download_rule_set_file(&target.url, &target.path, None).await;
                    if tun_result.is_ok() {
                        return Ok(());
                    }
                    return Err(format!(
                        "{} 更新失败（代理: {}；代理[TUN]: {}）",
                        target.tag,
                        proxy_result.err().unwrap_or_else(|| "unknown".to_string()),
                        tun_result.err().unwrap_or_else(|| "unknown".to_string()),
                    ));
                }
                return Err(format!(
                    "{} 更新失败（代理: {}）",
                    target.tag,
                    proxy_result.err().unwrap_or_else(|| "unknown".to_string()),
                ));
            }
            if proxy_via_tun {
                return download_rule_set_file(&target.url, &target.path, None)
                    .await
                    .map_err(|error| format!("{} 更新失败（代理[TUN]: {error}）", target.tag));
            }
            Err(format!("{} 更新失败（代理不可用：当前未连接）", target.tag))
        }
        RuleSetDownloadMode::Auto => {
            if let Some(proxy) = non_empty_proxy_url {
                let proxy_error =
                    download_rule_set_file(&target.url, &target.path, Some(proxy)).await;
                if proxy_error.is_ok() {
                    return Ok(());
                }
                let direct_error = download_rule_set_file(&target.url, &target.path, None).await;
                if direct_error.is_ok() {
                    return Ok(());
                }
                return Err(format!(
                    "{} 更新失败（代理: {}；直连: {}）",
                    target.tag,
                    proxy_error.err().unwrap_or_else(|| "unknown".to_string()),
                    direct_error.err().unwrap_or_else(|| "unknown".to_string()),
                ));
            }
            download_rule_set_file(&target.url, &target.path, None)
                .await
                .map_err(|error| format!("{} 更新失败（直连: {error}）", target.tag))
        }
    }
}

pub fn query_status<R: Runtime>(
    app: &AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request: RuleSetStatusRequest =
        serde_json::from_value(payload).map_err(|error| error.to_string())?;
    let geoip = request.geoip.unwrap_or_default();
    let geosite = request.geosite.unwrap_or_default();
    let targets = collect_rule_set_targets(app, &geoip, &geosite)?;
    serde_json::to_value(MobileRuleSetStatusResponse {
        statuses: build_status_items(app, &targets),
    })
    .map_err(|error| error.to_string())
}

pub async fn update_rule_sets<R: Runtime>(
    app: &AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request: RuleSetUpdateRequest =
        serde_json::from_value(payload).map_err(|error| error.to_string())?;
    let geoip = request.geoip.unwrap_or_default();
    let geosite = request.geosite.unwrap_or_default();
    let targets = collect_rule_set_targets(app, &geoip, &geosite)?;
    let mode = normalize_download_mode(request.download_mode.as_deref());
    let proxy_url = request.proxy_url.as_deref();
    let proxy_via_tun = request.proxy_via_tun == Some(true);
    let mut summary = MobileRuleSetUpdateSummary {
        requested: targets.len(),
        ..MobileRuleSetUpdateSummary::default()
    };

    if targets.is_empty() {
        let response = MobileRuleSetUpdateResponse {
            statuses: Vec::new(),
            summary,
            error: Some("所选规则集中无可更新的 GeoIP/GeoSite 条目".to_string()),
        };
        return serde_json::to_value(response).map_err(|error| error.to_string());
    }

    for target in &targets {
        match download_target_by_mode(target, mode, proxy_url, proxy_via_tun).await {
            Ok(()) => {
                summary.success += 1;
                summary.updated_tags.push(target.tag.clone());
            }
            Err(error) => {
                summary.failed += 1;
                summary.failed_items.push(error);
            }
        }
    }

    let statuses = build_status_items(app, &targets);
    let response = MobileRuleSetUpdateResponse {
        statuses,
        summary: summary.clone(),
        error: if summary.failed_items.is_empty() {
            None
        } else {
            Some(summary.failed_items.join("; "))
        },
    };
    serde_json::to_value(response).map_err(|error| error.to_string())
}
