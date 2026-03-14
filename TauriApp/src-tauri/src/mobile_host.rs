use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
use serde::{de::DeserializeOwned, Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Manager as _,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.wateray.desktop.mobilehost";

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
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MobileHostPlugin")?;
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
        run_mobile_host_command(&app, "getStatus", serde_json::json!({}))
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
        run_mobile_host_command(&app, "prepare", serde_json::json!({}))
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
        run_mobile_host_command(&app, "checkConfig", args)
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
        run_mobile_host_command(&app, "start", args)
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
        run_mobile_host_command(&app, "stop", serde_json::json!({}))
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
        run_mobile_host_command(&app, "probe", args)
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
        run_mobile_host_command(&app, "dnsHealth", args)
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("移动端代理宿主仅在 Android 平台可用".to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R>::new("mobile-host")
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
