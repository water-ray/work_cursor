use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    AppHandle,
    Runtime,
};

use crate::platform_contracts;

mod rule_sets;

#[cfg(target_os = "android")]
use serde::{de::DeserializeOwned, Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::{
    plugin::{PluginApi, PluginHandle},
    Manager as _,
};

#[cfg(target_os = "android")]
struct MobileHostAndroidHandle<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostCheckConfigArgs {
    config_json: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostStartArgs {
    config_json: String,
    profile_name: Option<String>,
    mode: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileProbeConfigArgs {
    node_id: String,
    config_json: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostProbeArgs {
    configs: Vec<MobileProbeConfigArgs>,
    probe_types: Option<Vec<String>>,
    latency_url: Option<String>,
    real_connect_url: Option<String>,
    timeout_ms: Option<i32>,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostProbeStartArgs {
    group_id: Option<String>,
    configs: Vec<MobileProbeConfigArgs>,
    probe_types: Option<Vec<String>>,
    latency_url: Option<String>,
    real_connect_url: Option<String>,
    timeout_ms: Option<i32>,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostProbeCancelArgs {
    task_id: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostSelectorSelectionArgs {
    selector_tag: String,
    outbound_tag: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostSwitchSelectorsArgs {
    selections: Vec<MobileHostSelectorSelectionArgs>,
    close_connections: Option<bool>,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileHostDnsHealthArgs {
    r#type: String,
    address: String,
    port: Option<i32>,
    domain: String,
    timeout_ms: Option<i32>,
}

#[cfg(target_os = "android")]
fn init_mobile_plugin<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> tauri::Result<()> {
    let handle = api.register_android_plugin(
        platform_contracts::MOBILE_HOST_ANDROID_PLUGIN_IDENTIFIER,
        platform_contracts::MOBILE_HOST_ANDROID_PLUGIN_CLASS,
    )?;
    app.manage(MobileHostAndroidHandle(handle));
    Ok(())
}

#[cfg(target_os = "android")]
fn mobile_host_handle<R: Runtime>(app: &AppHandle<R>) -> Result<PluginHandle<R>, String> {
    app.try_state::<MobileHostAndroidHandle<R>>()
        .map(|state| state.inner().0.clone())
        .ok_or_else(|| "移动端代理宿主尚未注册".to_string())
}

#[cfg(target_os = "android")]
fn run_mobile_host_command<R: Runtime, T, P>(
    app: &AppHandle<R>,
    command: &str,
    payload: P,
) -> Result<T, String>
where
    T: DeserializeOwned,
    P: Serialize,
{
    mobile_host_handle(app)?
        .run_mobile_plugin(command, payload)
        .map_err(|error| error.to_string())
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_get_status<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_GET_STATUS_PLUGIN_COMMAND,
            serde_json::json!({}),
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_prepare<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_PREPARE_PLUGIN_COMMAND,
            serde_json::json!({}),
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_check_config<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostCheckConfigArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_CHECK_CONFIG_PLUGIN_COMMAND,
            args,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_start<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostStartArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(&app, platform_contracts::MOBILE_HOST_START_PLUGIN_COMMAND, args)
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_stop<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_STOP_PLUGIN_COMMAND,
            serde_json::json!({}),
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_probe<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostProbeArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(&app, platform_contracts::MOBILE_HOST_PROBE_PLUGIN_COMMAND, args)
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_probe_start<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostProbeStartArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_PROBE_START_PLUGIN_COMMAND,
            args,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_probe_cancel<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostProbeCancelArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_PROBE_CANCEL_PLUGIN_COMMAND,
            args,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_get_task_queue<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_GET_TASK_QUEUE_PLUGIN_COMMAND,
            serde_json::json!({}),
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_switch_selectors<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostSwitchSelectorsArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_SWITCH_SELECTORS_PLUGIN_COMMAND,
            args,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
#[tauri::command]
pub fn mobile_host_dns_health<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let args: MobileHostDnsHealthArgs =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        run_mobile_host_command(
            &app,
            platform_contracts::MOBILE_HOST_DNS_HEALTH_PLUGIN_COMMAND,
            args,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

#[tauri::command]
pub fn mobile_host_rulesets_status<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    rule_sets::query_status(&app, payload)
}

#[tauri::command]
pub async fn mobile_host_rulesets_update<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    rule_sets::update_rule_sets(&app, payload).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R>::new(platform_contracts::MOBILE_HOST_PLUGIN_NAME)
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                init_mobile_plugin(app, api)?;
            }

            #[cfg(not(target_os = "android"))]
            let _ = (app, api);

            Ok(())
        })
        .build()
}
