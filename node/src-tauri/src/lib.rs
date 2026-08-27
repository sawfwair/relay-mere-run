mod agent;
mod asr_stream;
mod config;
mod deviceauth;
mod graph;
mod graph_custody;
mod hardware;
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linux_startup;
mod mererun;
mod model_plan;
mod native_video;
mod plugins;
mod process_activity;
mod protocol;
mod runtime_binary;
mod work_gate;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
use tokio::sync::watch;

use agent::NodeConfig;

const DEFAULT_RELAY_URL: &str = "wss://relay.mere.run/agent";

#[derive(Debug, serde::Deserialize)]
struct FleetSnapshot {
    activity: Vec<FleetActivity>,
}

#[derive(Debug, serde::Deserialize)]
struct FleetActivity {
    id: String,
    kind: String,
    status: String,
    model: Option<String>,
    label: String,
    created_at: String,
    completed_at: Option<String>,
    error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeActivityItem {
    id: String,
    title: String,
    subtitle: String,
    status: String,
    model: Option<String>,
    error: Option<String>,
    updated_at: i64,
}

fn relay_http_url(relay_url: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(relay_url).map_err(|error| error.to_string())?;
    match url.scheme() {
        "wss" => url
            .set_scheme("https")
            .map_err(|_| "Relay URL scheme could not be converted to HTTPS".to_string())?,
        "ws" => url
            .set_scheme("http")
            .map_err(|_| "Relay URL scheme could not be converted to HTTP".to_string())?,
        "https" | "http" => {}
        _ => return Err("Relay URL must use ws, wss, http, or https".to_string()),
    }
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn activity_epoch_seconds(activity: &FleetActivity) -> i64 {
    activity
        .completed_at
        .as_deref()
        .or(Some(activity.created_at.as_str()))
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp())
        .unwrap_or_default()
}

async fn relay_request<R: Runtime>(
    app: &AppHandle<R>,
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::Response, String> {
    let token = deviceauth::load_fresh(&token_path(app)?)
        .await
        .map_err(|error| user_auth_error(&error.to_string()))?;
    let preferences = config::load_preferences(app);
    let url = relay_http_url(&preferences.relay_url, path)?;
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?
        .request(method, url)
        .bearer_auth(token.access_token)
        .send()
        .await
        .map_err(|error| error.to_string())
}

/// Tracks the running agent task and its stop signal.
#[derive(Default)]
struct NodeState {
    stop_tx: Mutex<Option<watch::Sender<bool>>>,
    running: Mutex<bool>,
}

/// Where the brokered token is persisted (per-OS app config dir).
fn token_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("auth.json"))
}

fn user_auth_error(message: &str) -> String {
    message
        .strip_prefix("auth_required:")
        .or_else(|| message.strip_prefix("auth_refresh_failed:"))
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .unwrap_or(message)
        .to_string()
}

/// Stable unique id for this node install, persisted alongside the token. Unique
/// per install so two nodes never share a relay identity — connections that share
/// a device_id replace each other on the relay, causing an endless reconnect war.
/// Falls back to a hostname label if the config dir is unavailable.
fn load_or_create_device_id<R: Runtime>(app: &AppHandle<R>) -> String {
    let host = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".into());
    let Ok(dir) = app.path().app_config_dir() else {
        return format!("node-{host}");
    };
    let path = dir.join("device-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!("node-{host}-{nanos:x}");
    std::fs::create_dir_all(&dir).ok();
    std::fs::write(&path, &id).ok();
    id
}

// --- auth (mere.world device-authorization grant) --------------------------

#[derive(serde::Serialize)]
struct AuthStatus {
    signed_in: bool,
}

#[tauri::command]
fn auth_status(app: AppHandle) -> AuthStatus {
    let signed_in = token_path(&app)
        .ok()
        .map(|path| {
            let Some(tokens) = deviceauth::load(&path) else {
                return false;
            };
            if deviceauth::requires_sign_in(&tokens) {
                deviceauth::clear(&path);
                return false;
            }
            true
        })
        .unwrap_or(false);
    AuthStatus { signed_in }
}

/// Begin the device grant; returns the user code + verification link to show.
#[tauri::command]
async fn device_auth_start() -> Result<deviceauth::DeviceAuthStart, String> {
    deviceauth::start().await.map_err(|e| e.to_string())
}

/// Block until the operator approves the code (or it fails/expires), then save
/// the brokered token. The frontend awaits this after showing the user code.
#[tauri::command]
async fn device_auth_poll(
    app: AppHandle,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<(), String> {
    let tokens = deviceauth::poll(&device_code, interval, expires_in)
        .await
        .map_err(|e| e.to_string())?;
    let path = token_path(&app)?;
    deviceauth::save(&path, &tokens).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn sign_out(
    app: AppHandle,
    state: State<'_, NodeState>,
    work_gate: State<'_, work_gate::DeviceWorkGate>,
) -> Result<(), String> {
    force_stop_node(app.clone(), state, work_gate).await?;
    let path = token_path(&app)?;
    deviceauth::clear(&path);
    config::remove_legacy_direct_executor_state(&app)?;
    Ok(())
}

// --- node lifecycle --------------------------------------------------------

#[tauri::command]
async fn start_node(
    app: AppHandle,
    device_name: String,
    models: Vec<String>,
    relay_url: Option<String>,
) -> Result<(), String> {
    // Identity comes from the brokered token, never a pasted credential.
    let path = token_path(&app)?;
    deviceauth::load_fresh(&path)
        .await
        .map_err(|e| user_auth_error(&e.to_string()))?;

    let state = app.state::<NodeState>();
    {
        let running = state.running.lock().unwrap();
        if *running {
            return Err("node already running".into());
        }
    }

    let mut preferences = config::load_preferences(&app);
    preferences.device_name = device_name.clone();
    preferences.models = models.clone();
    preferences.relay_url = relay_url
        .clone()
        .unwrap_or_else(|| DEFAULT_RELAY_URL.to_string());
    config::save_preferences(&app, preferences.clone())?;
    let config = NodeConfig {
        relay_url: preferences.relay_url,
        auth_path: path,
        device_name,
        device_id: load_or_create_device_id(&app),
        models,
    };

    let (tx, rx) = watch::channel(false);
    *state.stop_tx.lock().unwrap() = Some(tx);
    *state.running.lock().unwrap() = true;

    let app_for_task = app.clone();
    let work_gate = app.state::<work_gate::DeviceWorkGate>().inner().clone();
    work_gate.resume();
    tauri::async_runtime::spawn(async move {
        agent::run_agent(app_for_task.clone(), config, work_gate, rx).await;
        if let Some(st) = app_for_task.try_state::<NodeState>() {
            *st.running.lock().unwrap() = false;
        }
        let _ = app_for_task.emit(
            "node:status",
            serde_json::json!({ "connected": false, "running": false, "message": "stopped" }),
        );
    });

    Ok(())
}

#[tauri::command]
async fn stop_node(
    app: AppHandle,
    state: State<'_, NodeState>,
    work_gate: State<'_, work_gate::DeviceWorkGate>,
) -> Result<(), String> {
    work_gate.begin_drain();
    let _ = app.emit(
        "node:control-status",
        serde_json::json!({
            "running": true,
            "phase": "draining",
            "message": "Stopping after current work",
            "accepting": false
        }),
    );
    let barrier = work_gate
        .acquire("node-control", "stop-after-current")
        .await;
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    drop(barrier);
    Ok(())
}

async fn force_stop_node(
    app: AppHandle,
    state: State<'_, NodeState>,
    work_gate: State<'_, work_gate::DeviceWorkGate>,
) -> Result<(), String> {
    work_gate.begin_drain();
    let _ = app.emit(
        "node:control-status",
        serde_json::json!({
            "running": true,
            "phase": "draining",
            "message": "Canceling active work and signing out",
            "accepting": false
        }),
    );
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    let barrier = work_gate.acquire("node-control", "force-stop").await;
    drop(barrier);
    Ok(())
}

#[tauri::command]
fn drain_node(app: AppHandle, work_gate: State<'_, work_gate::DeviceWorkGate>) {
    work_gate.begin_drain();
    let _ = app.emit(
        "node:control-status",
        serde_json::json!({
            "running": true,
            "phase": "draining",
            "message": "Finishing active work; no new jobs will be claimed",
            "accepting": false
        }),
    );
}

#[tauri::command]
fn resume_node(app: AppHandle, work_gate: State<'_, work_gate::DeviceWorkGate>) {
    work_gate.resume();
    let _ = app.emit(
        "node:control-status",
        serde_json::json!({
            "running": true,
            "phase": "idle",
            "message": "Waiting for work",
            "accepting": true
        }),
    );
}

#[tauri::command]
fn node_running(state: State<'_, NodeState>) -> bool {
    *state.running.lock().unwrap()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDiscovery {
    installed_models: Vec<String>,
    capability_models: Vec<String>,
}

#[tauri::command]
async fn discover_models() -> Result<ModelDiscovery, String> {
    Ok(ModelDiscovery {
        installed_models: mererun::installed_models().await,
        capability_models: mererun::list_models().await,
    })
}

#[tauri::command]
async fn inspect_runtime_binaries(
    refresh: Option<bool>,
) -> runtime_binary::RuntimeBinaryResolution {
    runtime_binary::resolution(refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn list_relay_activity(app: AppHandle) -> Result<Vec<NodeActivityItem>, String> {
    let response = relay_request(&app, reqwest::Method::GET, "/api/fleet").await?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Relay activity request failed ({status})"));
    }
    let snapshot = response
        .json::<FleetSnapshot>()
        .await
        .map_err(|error| format!("Relay activity response was invalid: {error}"))?;
    Ok(snapshot
        .activity
        .into_iter()
        .map(|activity| {
            let updated_at = activity_epoch_seconds(&activity);
            NodeActivityItem {
                id: format!("relay:{}", activity.id),
                title: activity.label,
                subtitle: activity.kind,
                status: activity.status,
                model: activity.model,
                error: activity.error,
                updated_at,
            }
        })
        .collect())
}

#[tauri::command]
async fn list_capability_packs() -> Vec<plugins::CapabilityPack> {
    plugins::capability_packs().await
}

#[tauri::command]
async fn install_capability_pack(
    app: AppHandle,
    pack_id: String,
) -> Result<Vec<plugins::CapabilityPack>, String> {
    plugins::install_capability_pack(&pack_id)
        .await
        .map_err(|error| error.to_string())?;

    let device_id = load_or_create_device_id(&app);
    let refresh_path = format!("/api/fleet/nodes/{device_id}/refresh");
    let response = relay_request(&app, reqwest::Method::POST, &refresh_path).await?;
    if !response.status().is_success() && response.status() != reqwest::StatusCode::CONFLICT {
        return Err(format!(
            "Capability installed, but Relay inventory refresh failed ({})",
            response.status()
        ));
    }
    Ok(plugins::capability_packs().await)
}

#[tauri::command]
fn load_node_config(app: AppHandle) -> config::NodePreferences {
    config::load_preferences(&app)
}

#[tauri::command]
fn save_node_config(
    app: AppHandle,
    config: config::NodePreferences,
) -> Result<config::NodePreferences, String> {
    let saved = config::save_preferences(&app, config)?;
    Ok(saved)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_startup::prepare();

    tauri::Builder::default()
        // Single-instance must be registered first. A second launch focuses the
        // existing window instead of starting a duplicate node — two node
        // processes would share a device_id and war over the relay connection.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(NodeState::default())
        .manage(work_gate::DeviceWorkGate::default())
        .setup(|app| {
            if let Err(error) = config::remove_legacy_direct_executor_state(app.handle()) {
                let _ = app.emit(
                    "node:log",
                    serde_json::json!({
                        "level": "warning",
                        "message": format!("legacy executor cleanup failed: {error}")
                    }),
                );
            }
            let background = std::env::args().any(|argument| argument == "--background");
            if background {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            let preferences = config::load_preferences(app.handle());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = start_node(
                    app_handle.clone(),
                    if preferences.device_name.is_empty() {
                        "mere.run node".to_string()
                    } else {
                        preferences.device_name
                    },
                    preferences.models,
                    Some(preferences.relay_url),
                )
                .await;
                if let Err(error) = result {
                    let _ = app_handle.emit(
                        "node:log",
                        serde_json::json!({ "level": "error", "message": error }),
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            device_auth_start,
            device_auth_poll,
            sign_out,
            start_node,
            stop_node,
            drain_node,
            resume_node,
            node_running,
            discover_models,
            inspect_runtime_binaries,
            list_relay_activity,
            list_capability_packs,
            install_capability_pack,
            load_node_config,
            save_node_config
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let running = window
                    .app_handle()
                    .state::<NodeState>()
                    .running
                    .lock()
                    .map(|running| *running)
                    .unwrap_or(false);
                if running {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_websocket_url_maps_to_same_https_origin() {
        let url = relay_http_url("wss://relay.mere.run/agent", "/api/fleet").expect("relay URL");
        assert_eq!(url.as_str(), "https://relay.mere.run/api/fleet");
    }

    #[test]
    fn relay_url_rejects_non_network_schemes() {
        let error =
            relay_http_url("file:///tmp/relay", "/api/fleet").expect_err("unsupported scheme");
        assert!(error.contains("ws, wss, http, or https"));
    }

    #[test]
    fn persisted_activity_prefers_terminal_timestamp() {
        let activity = FleetActivity {
            id: "tool-1".to_string(),
            kind: "tool".to_string(),
            status: "complete".to_string(),
            model: None,
            label: "mere-animatic-tools delivery-prep".to_string(),
            created_at: "2026-07-20T20:00:00Z".to_string(),
            completed_at: Some("2026-07-20T20:05:00Z".to_string()),
            error: None,
        };

        assert_eq!(activity_epoch_seconds(&activity), 1_784_577_900);
    }
}
