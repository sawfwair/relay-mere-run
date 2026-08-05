//! The relay device agent: connects to `wss://relay.mere.run/agent`, authenticates
//! with a Bearer token, advertises capabilities, and services image jobs by
//! driving local `mere.run`.

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::Message;

use crate::asr_stream::LiveAsrSessions;
use crate::deviceauth;
use crate::graph;
use crate::hardware;
use crate::mererun;
use crate::model_plan;
use crate::plugins;
use crate::protocol::{
    AgentAvailability, AgentCapabilities, AgentCapacity, AgentMessage, AgentRuntimeInfo,
    AgentSystemInfo, AsrRequest, AsrStreamingCapabilities, ChatRequest, GraphWorkerCapabilities,
    JobKind, JobRequest, ModelInventoryStatus, OcrRequest, OcrServerMessage, PluginCapability,
    RuntimeDiagnostic, ServerMessage, TalkRequest, TalkServerMessage, ToolRequest,
};
use crate::work_gate::DeviceWorkGate;

type ActiveGraphJobs = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;
type ActiveModelPlans = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;
type ActiveTalkJobs = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;
type ActiveAsrJobs = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;
type ActiveOcrJobs = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;
type ActiveToolJobs = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;

const GRAPH_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

async fn send_graph_completion(
    active: &ActiveGraphJobs,
    out: &mpsc::UnboundedSender<Message>,
    job_id: &str,
    message: AgentMessage,
) {
    // The relay may reassign a cancelled job as soon as it receives graph_error.
    // Release the local slot before making that reassignment possible.
    active.lock().await.remove(job_id);
    if let Ok(text) = serde_json::to_string(&message) {
        let _ = out.send(Message::Text(text.into()));
    }
}

struct NodeInventory {
    capabilities: AgentCapabilities,
    system: AgentSystemInfo,
    runtime: AgentRuntimeInfo,
    capacity: AgentCapacity,
}

async fn collect_inventory(configured_models: &[String]) -> NodeInventory {
    let fallback = fallback_inventory(configured_models);
    // Resolve automatic runtime selection before starting any capability
    // deadline. With an explicit MERERUN_BIN pin this is immediate; without a
    // pin it performs the bounded compatibility scan once and caches the result.
    let _ = mererun::resolve_mere_run_binary().await;
    // The graph probe runs both `graph worker probe` and `graph catalog`. Running
    // it beside the status/model probes below makes several mere.run processes
    // contend for the same model inventory and can push the graph probe over its
    // deadline. Probe the scheduling contract first so a slow inventory refresh
    // cannot silently erase an otherwise healthy node's graph eligibility.
    let graph_worker = tokio::time::timeout(GRAPH_PROBE_TIMEOUT, graph::probe())
        .await
        .ok()
        .flatten();
    let (capability_models, plugin_capabilities, runtime_inventory, system, asr_streaming) = tokio::join!(
        tokio::time::timeout(
            Duration::from_secs(12),
            mererun::capability_models(configured_models)
        ),
        tokio::time::timeout(Duration::from_secs(8), plugins::discover_plugins()),
        tokio::time::timeout(Duration::from_secs(20), mererun::runtime_inventory()),
        tokio::time::timeout(Duration::from_secs(10), hardware::collect_system_info()),
        tokio::time::timeout(
            Duration::from_secs(20),
            mererun::asr_streaming_capabilities()
        ),
    );

    assemble_inventory(
        fallback,
        capability_models.ok(),
        plugin_capabilities.ok(),
        runtime_inventory.ok().map(|inventory| AgentRuntimeInfo {
            mere_run_version: inventory.mere_run_version,
            installed_models: inventory.installed_models,
            inventory_status: Some(inventory.inventory_status),
            diagnostic: inventory.diagnostic,
        }),
        system.ok(),
        graph_worker,
        asr_streaming.ok().flatten(),
    )
}

#[allow(clippy::too_many_arguments)]
fn assemble_inventory(
    fallback: NodeInventory,
    capability_models: Option<Vec<String>>,
    plugin_capabilities: Option<Vec<PluginCapability>>,
    runtime: Option<AgentRuntimeInfo>,
    system: Option<AgentSystemInfo>,
    graph_worker: Option<GraphWorkerCapabilities>,
    asr_streaming: Option<AsrStreamingCapabilities>,
) -> NodeInventory {
    let capabilities = AgentCapabilities {
        models: capability_models.unwrap_or(fallback.capabilities.models),
        max_resolution: fallback.capabilities.max_resolution,
        controlnet: fallback.capabilities.controlnet,
        lora: fallback.capabilities.lora,
        img2img: fallback.capabilities.img2img,
        plugins: plugin_capabilities.unwrap_or(fallback.capabilities.plugins),
        graph_worker,
        asr_streaming,
    };
    NodeInventory {
        capabilities,
        system: system.unwrap_or(fallback.system),
        runtime: runtime.unwrap_or(fallback.runtime),
        capacity: fallback.capacity,
    }
}

fn fallback_inventory(configured_models: &[String]) -> NodeInventory {
    let mut models = configured_models
        .iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    NodeInventory {
        capabilities: AgentCapabilities {
            models,
            max_resolution: 2048,
            controlnet: false,
            lora: false,
            img2img: true,
            plugins: vec![crate::native_video::capability()],
            graph_worker: None,
            asr_streaming: None,
        },
        system: AgentSystemInfo {
            platform: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            os_version: None,
            hostname: hostname::get()
                .ok()
                .and_then(|value| value.into_string().ok()),
            cpu_model: None,
            logical_cores: std::thread::available_parallelism()
                .ok()
                .map(|count| count.get() as u32),
            memory_total_bytes: None,
            accelerators: Vec::new(),
        },
        runtime: AgentRuntimeInfo {
            mere_run_version: None,
            installed_models: Vec::new(),
            inventory_status: Some(ModelInventoryStatus::Failed),
            diagnostic: Some(RuntimeDiagnostic::InventoryCommandsFailed),
        },
        capacity: AgentCapacity {
            max_concurrent_jobs: 1,
            lease_protocol: true,
        },
    }
}

/// Configuration supplied by the console UI when starting the node.
#[derive(Debug, Clone, Deserialize)]
pub struct NodeConfig {
    /// e.g. `wss://relay.mere.run/agent`
    pub relay_url: String,
    /// Path to the persisted mere.world device token set.
    pub auth_path: PathBuf,
    pub device_name: String,
    /// Stable unique id for THIS node install (persisted in the config dir). Two
    /// connections sharing a device_id replace each other on the relay, so this
    /// must be unique per running node — not just per hostname.
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub models: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: &str, payload: serde_json::Value) {
    let _ = app.emit(event, payload);
}

fn job_kind_label(kind: &JobKind) -> &'static str {
    match kind {
        JobKind::Image => "image",
        JobKind::Music => "music",
        JobKind::Video => "video",
    }
}

fn auth_required_message(message: &str) -> Option<String> {
    message
        .strip_prefix("auth_required:")
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(ToString::to_string)
}

#[derive(Debug, PartialEq, Eq)]
enum ConnectedAuthEvent {
    Refreshed,
    Retry(String),
    SignInRequired(String),
}

fn classify_connected_auth_error(message: String) -> ConnectedAuthEvent {
    if auth_required_message(&message).is_some() {
        ConnectedAuthEvent::SignInRequired(message)
    } else {
        ConnectedAuthEvent::Retry(message)
    }
}

fn spawn_connected_auth_maintenance(
    auth_path: PathBuf,
    initial_access_token: String,
) -> (
    mpsc::UnboundedReceiver<ConnectedAuthEvent>,
    tokio::task::JoinHandle<()>,
) {
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let mut current_access_token = initial_access_token;
        let mut interval = tokio::time::interval(deviceauth::CONNECTED_REFRESH_CHECK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // `interval` ticks immediately once. The connection already loaded a
        // fresh token, so consume that tick and begin periodic maintenance.
        interval.tick().await;

        loop {
            interval.tick().await;
            match deviceauth::load_fresh(&auth_path).await {
                Ok(fresh) => {
                    if fresh.access_token != current_access_token {
                        current_access_token = fresh.access_token;
                        if event_tx.send(ConnectedAuthEvent::Refreshed).is_err() {
                            break;
                        }
                    }
                }
                Err(error) => {
                    let event = classify_connected_auth_error(error.to_string());
                    let terminal = matches!(event, ConnectedAuthEvent::SignInRequired(_));
                    if event_tx.send(event).is_err() || terminal {
                        break;
                    }
                }
            }
        }
    });
    (event_rx, task)
}

fn is_unauthorized_ws_error(error: &WebSocketError) -> bool {
    matches!(error, WebSocketError::Http(response) if response.status() == StatusCode::UNAUTHORIZED)
}

/// Supervisor loop: connect, serve, and reconnect until stopped.
pub async fn run_agent<R: Runtime>(
    app: AppHandle<R>,
    config: NodeConfig,
    work_gate: DeviceWorkGate,
    mut stop: watch::Receiver<bool>,
) {
    // The node is an operator-started service, not incidental UI work. Hold a
    // native macOS activity for the whole supervisor lifetime so App Nap cannot
    // suspend Relay heartbeats while the window is hidden or the screen locks.
    let _runtime_activity = crate::process_activity::begin_node_runtime_activity();

    let device_id = if config.device_id.trim().is_empty() {
        format!(
            "node-{}",
            hostname::get()
                .ok()
                .and_then(|h| h.into_string().ok())
                .unwrap_or_else(|| "unknown".into())
        )
    } else {
        config.device_id.clone()
    };

    while !*stop.borrow() {
        emit(
            &app,
            "node:status",
            serde_json::json!({
                "connected": false, "running": true, "message": "connecting"
            }),
        );

        if let Err(e) = connect_and_serve(&app, &config, &device_id, &work_gate, &mut stop).await {
            let error_message = e.to_string();
            if let Some(message) = auth_required_message(&error_message) {
                deviceauth::clear(&config.auth_path);
                emit(
                    &app,
                    "node:status",
                    serde_json::json!({
                        "connected": false,
                        "running": false,
                        "message": message,
                        "authRequired": true
                    }),
                );
                emit(
                    &app,
                    "node:log",
                    serde_json::json!({
                        "level": "error", "message": message
                    }),
                );
                break;
            }
            emit(
                &app,
                "node:log",
                serde_json::json!({
                    "level": "error", "message": format!("connection ended: {error_message}")
                }),
            );
        }

        if *stop.borrow() {
            break;
        }
        emit(
            &app,
            "node:status",
            serde_json::json!({
                "connected": false, "running": true, "message": "reconnecting in 3s"
            }),
        );
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            _ = stop.changed() => {}
        }
    }

    emit(
        &app,
        "node:status",
        serde_json::json!({
            "connected": false, "running": false, "message": "stopped"
        }),
    );
}

async fn connect_and_serve<R: Runtime>(
    app: &AppHandle<R>,
    config: &NodeConfig,
    device_id: &str,
    work_gate: &DeviceWorkGate,
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    let token = deviceauth::load_fresh(&config.auth_path).await?;
    let mut request = config.relay_url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", token.access_token))?,
    );

    let (ws_stream, _resp) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(error) if is_unauthorized_ws_error(&error) => {
            return Err(anyhow!(
                "auth_required: saved session was rejected; sign in with mere.world again"
            ));
        }
        Err(error) => return Err(anyhow!(error)),
    };
    let (mut write, mut read) = ws_stream.split();

    // A relay WebSocket can remain authenticated longer than the broker access
    // token. Keep the node-owned token file fresh while that connection stays
    // open so local clients can exchange only the short-lived access token.
    // The rotating refresh token never leaves this process or auth file.
    let (mut auth_events, auth_maintenance) =
        spawn_connected_auth_maintenance(config.auth_path.clone(), token.access_token);

    // All outbound frames funnel through this channel so the read loop, the ping
    // ticker, and job handlers can write concurrently.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    // Announce ourselves.
    emit(
        app,
        "node:status",
        serde_json::json!({
            "connected": false, "running": true, "message": "authenticating with Relay"
        }),
    );
    // Authenticate immediately with the built-in contract. Slow model, hardware,
    // and companion-plugin probes follow as an inventory update on the same
    // connection instead of holding the WebSocket in a misleading connecting
    // state.
    let inventory = fallback_inventory(&config.models);
    let auth_gate_state = work_gate.current();
    let auth_current_job_id = if auth_gate_state.busy {
        Some(if auth_gate_state.source == "relay" {
            auth_gate_state.work_id.clone()
        } else {
            format!(
                "local:{}:{}",
                auth_gate_state.source, auth_gate_state.work_id
            )
        })
    } else {
        None
    };
    let auth = AgentMessage::Auth {
        device_id: device_id.to_string(),
        device_name: config.device_name.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities: inventory.capabilities,
        system: inventory.system,
        runtime: inventory.runtime,
        capacity: inventory.capacity,
        availability: Some(AgentAvailability {
            status: if auth_gate_state.busy {
                "busy"
            } else {
                "online"
            }
            .to_string(),
            current_job_id: auth_current_job_id,
            source: if auth_gate_state.busy {
                auth_gate_state.source
            } else {
                "node".to_string()
            },
        }),
    };
    out_tx.send(Message::Text(serde_json::to_string(&auth)?.into()))?;

    // Authentication is ordered before this frame on the same writer. If
    // Animatic already owns the device gate when Relay reconnects, the node is
    // therefore removed from placement immediately after it comes online.
    let initial_gate_state = work_gate.current();
    if initial_gate_state.busy {
        let current_job_id = if initial_gate_state.source == "relay" {
            initial_gate_state.work_id
        } else {
            format!(
                "local:{}:{}",
                initial_gate_state.source, initial_gate_state.work_id
            )
        };
        out_tx.send(Message::Text(
            serde_json::to_string(&AgentMessage::AvailabilityUpdate {
                status: "busy".to_string(),
                current_job_id: Some(current_job_id),
                source: initial_gate_state.source,
            })?
            .into(),
        ))?;
    }

    let mut writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            write
                .send(msg)
                .await
                .map_err(|error| anyhow!("relay writer failed: {error}"))?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let inventory_tx = out_tx.clone();
    let configured_models = config.models.clone();
    let inventory_probe = tokio::spawn(async move {
        let inventory = collect_inventory(&configured_models).await;
        let message = AgentMessage::InventoryUpdate {
            capabilities: inventory.capabilities,
            system: inventory.system,
            runtime: inventory.runtime,
            capacity: inventory.capacity,
        };
        if let Ok(text) = serde_json::to_string(&message) {
            let _ = inventory_tx.send(Message::Text(text.into()));
        }
    });

    let ping_tx = out_tx.clone();
    let pinger = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(20));
        loop {
            interval.tick().await;
            let ping = AgentMessage::Ping {
                timestamp_ms: now_ms(),
                telemetry: Some(hardware::collect_telemetry().await),
            };
            let Ok(txt) = serde_json::to_string(&ping) else {
                break;
            };
            if ping_tx.send(Message::Text(txt.into())).is_err() {
                break;
            }
        }
    });

    let mut gate_state_rx = work_gate.subscribe();
    let availability_tx = out_tx.clone();
    let availability = tokio::spawn(async move {
        let mut last_source = String::new();
        let mut last_current_job_id = String::new();
        loop {
            if gate_state_rx.changed().await.is_err() {
                break;
            }
            let state = gate_state_rx.borrow().clone();
            if state.busy {
                last_source.clone_from(&state.source);
                last_current_job_id = if state.source == "relay" {
                    state.work_id.clone()
                } else {
                    format!("local:{}:{}", state.source, state.work_id)
                };
            }
            let message = AgentMessage::AvailabilityUpdate {
                status: if state.busy { "busy" } else { "online" }.to_string(),
                current_job_id: (!last_current_job_id.is_empty())
                    .then(|| last_current_job_id.clone()),
                source: if state.busy {
                    state.source
                } else {
                    last_source.clone()
                },
            };
            let Ok(text) = serde_json::to_string(&message) else {
                break;
            };
            if availability_tx.send(Message::Text(text.into())).is_err() {
                break;
            }
        }
    });

    let active_graphs = ActiveGraphJobs::default();
    let active_model_plans = ActiveModelPlans::default();
    let active_talks = ActiveTalkJobs::default();
    let active_asrs = ActiveAsrJobs::default();
    let active_ocrs = ActiveOcrJobs::default();
    let active_tools = ActiveToolJobs::default();
    let live_asr = LiveAsrSessions::new(work_gate.clone(), out_tx.clone());
    let mut request_tasks = JoinSet::new();

    let mut writer_joined = false;
    let result: Result<()> = loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { break Ok(()); }
            }
            writer_result = &mut writer => {
                writer_joined = true;
                break match writer_result {
                    Ok(Ok(())) => Err(anyhow!("relay writer stopped unexpectedly")),
                    Ok(Err(error)) => Err(error),
                    Err(error) => Err(anyhow!("relay writer task failed: {error}")),
                };
            }
            completed = request_tasks.join_next(), if !request_tasks.is_empty() => {
                if let Some(Err(error)) = completed {
                    emit(app, "node:log", serde_json::json!({
                        "level": "error", "message": format!("relay request task failed: {error}")
                    }));
                }
            }
            Some(auth_event) = auth_events.recv() => {
                match auth_event {
                    ConnectedAuthEvent::Refreshed => {
                        emit(app, "node:log", serde_json::json!({
                            "level": "info",
                            "message": "mere.world access refreshed"
                        }));
                    }
                    ConnectedAuthEvent::Retry(message) => {
                        emit(app, "node:log", serde_json::json!({
                            "level": "warning",
                            "message": format!("auth refresh will retry: {message}")
                        }));
                    }
                    ConnectedAuthEvent::SignInRequired(message) => {
                        break Err(anyhow!(message));
                    }
                }
            }
            maybe = read.next() => {
                match maybe {
                    None => break Ok(()),
                    Some(Err(e)) => break Err(anyhow!(e)),
                    Some(Ok(Message::Text(txt))) => {
                        if is_live_asr_control(&txt) {
                            if let Err(e) = handle_server_message(
                                ServerMessageContext {
                                    app,
                                    out_tx: &out_tx,
                                    active_graphs: &active_graphs,
                                    active_model_plans: &active_model_plans,
                                    active_asrs: &active_asrs,
                                    active_tools: &active_tools,
                                    configured_models: &config.models,
                                    work_gate,
                                    live_asr: &live_asr,
                                },
                                &txt,
                            ).await {
                                emit(app, "node:log", serde_json::json!({
                                    "level": "error", "message": format!("{e}")
                                }));
                            }
                            continue;
                        }
                        if spawn_special_media_message(
                            &mut request_tasks,
                            app,
                            &out_tx,
                            &active_talks,
                            &active_ocrs,
                            work_gate,
                            txt.to_string(),
                        ) {
                            continue;
                        }
                        let task_app = app.clone();
                        let task_out = out_tx.clone();
                        let task_graphs = active_graphs.clone();
                        let task_plans = active_model_plans.clone();
                        let task_asrs = active_asrs.clone();
                        let task_tools = active_tools.clone();
                        let task_models = config.models.clone();
                        let task_work_gate = work_gate.clone();
                        let task_live_asr = live_asr.clone();
                        request_tasks.spawn(async move {
                            if let Err(e) = handle_server_message(
                                ServerMessageContext {
                                    app: &task_app,
                                    out_tx: &task_out,
                                    active_graphs: &task_graphs,
                                    active_model_plans: &task_plans,
                                    active_asrs: &task_asrs,
                                    active_tools: &task_tools,
                                    configured_models: &task_models,
                                    work_gate: &task_work_gate,
                                    live_asr: &task_live_asr,
                                },
                                &txt,
                            ).await {
                                emit(&task_app, "node:log", serde_json::json!({
                                    "level": "error", "message": format!("{e}")
                                }));
                            }
                        });
                    }
                    Some(Ok(Message::Binary(frame))) => live_asr.feed_binary(&frame).await,
                    Some(Ok(Message::Close(_))) => break Ok(()),
                    Some(Ok(_)) => {}
                }
            }
        }
    };

    for cancel in active_graphs.lock().await.values() {
        let _ = cancel.send(true);
    }
    for cancel in active_model_plans.lock().await.values() {
        let _ = cancel.send(true);
    }
    for cancel in active_talks.lock().await.values() {
        let _ = cancel.send(true);
    }
    for cancel in active_asrs.lock().await.values() {
        let _ = cancel.send(true);
    }
    for cancel in active_ocrs.lock().await.values() {
        let _ = cancel.send(true);
    }
    for cancel in active_tools.lock().await.values() {
        let _ = cancel.send(true);
    }
    live_asr.cancel_all().await;
    let stopped_gracefully = tokio::time::timeout(Duration::from_secs(2), async {
        while request_tasks.join_next().await.is_some() {}
    })
    .await
    .is_ok();
    if !stopped_gracefully {
        request_tasks.abort_all();
        while request_tasks.join_next().await.is_some() {}
    }
    pinger.abort();
    availability.abort();
    inventory_probe.abort();
    auth_maintenance.abort();
    drop(live_asr);
    drop(out_tx);
    if !writer_joined {
        let _ = writer.await;
    }
    result
}

fn is_live_asr_control(text: &str) -> bool {
    message_type(text).is_some_and(|message_type| {
        matches!(
            message_type.as_str(),
            "asr_stream_start" | "asr_stream_stop" | "asr_stream_cancel"
        )
    })
}

fn is_talk_message(text: &str) -> bool {
    message_type(text)
        .is_some_and(|message_type| matches!(message_type.as_str(), "talk_request" | "talk_cancel"))
}

fn is_ocr_message(text: &str) -> bool {
    message_type(text)
        .is_some_and(|message_type| matches!(message_type.as_str(), "ocr_request" | "ocr_cancel"))
}

fn spawn_special_media_message<R: Runtime>(
    request_tasks: &mut JoinSet<()>,
    app: &AppHandle<R>,
    out_tx: &mpsc::UnboundedSender<Message>,
    active_talks: &ActiveTalkJobs,
    active_ocrs: &ActiveOcrJobs,
    work_gate: &DeviceWorkGate,
    text: String,
) -> bool {
    if is_talk_message(&text) {
        let task_app = app.clone();
        let task_out = out_tx.clone();
        let task_talks = active_talks.clone();
        let task_work_gate = work_gate.clone();
        request_tasks.spawn(async move {
            if let Err(error) = handle_talk_server_message(
                TalkExecutionContext {
                    app: &task_app,
                    out_tx: &task_out,
                    active_talks: &task_talks,
                    work_gate: &task_work_gate,
                },
                &text,
            )
            .await
            {
                emit_request_error(&task_app, error);
            }
        });
        return true;
    }
    if is_ocr_message(&text) {
        let task_app = app.clone();
        let task_out = out_tx.clone();
        let task_ocrs = active_ocrs.clone();
        let task_work_gate = work_gate.clone();
        request_tasks.spawn(async move {
            if let Err(error) = handle_ocr_server_message(
                OcrExecutionContext {
                    app: &task_app,
                    out_tx: &task_out,
                    active_ocrs: &task_ocrs,
                    work_gate: &task_work_gate,
                },
                &text,
            )
            .await
            {
                emit_request_error(&task_app, error);
            }
        });
        return true;
    }
    false
}

fn emit_request_error<R: Runtime>(app: &AppHandle<R>, error: anyhow::Error) {
    emit(
        app,
        "node:log",
        serde_json::json!({
            "level": "error", "message": format!("{error}")
        }),
    );
}

fn message_type(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
}

struct ServerMessageContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    out_tx: &'a mpsc::UnboundedSender<Message>,
    active_graphs: &'a ActiveGraphJobs,
    active_model_plans: &'a ActiveModelPlans,
    active_asrs: &'a ActiveAsrJobs,
    active_tools: &'a ActiveToolJobs,
    configured_models: &'a [String],
    work_gate: &'a DeviceWorkGate,
    live_asr: &'a LiveAsrSessions,
}

async fn handle_server_message<R: Runtime>(
    context: ServerMessageContext<'_, R>,
    txt: &str,
) -> Result<()> {
    let ServerMessageContext {
        app,
        out_tx,
        active_graphs,
        active_model_plans,
        active_asrs,
        active_tools,
        configured_models,
        work_gate,
        live_asr,
    } = context;
    let msg: ServerMessage = serde_json::from_str(txt)?;
    match msg {
        ServerMessage::AuthResult {
            success,
            agent_id,
            user_id,
            error,
        } => {
            let status_message = if success {
                "online".to_string()
            } else {
                error.unwrap_or_else(|| "auth failed".to_string())
            };
            emit(
                app,
                "node:status",
                serde_json::json!({
                    "connected": success,
                    "running": true,
                    "agent_id": agent_id,
                    "user_id": user_id,
                    "message": status_message,
                }),
            );
            if !success {
                return Err(anyhow!(
                    "auth_required: relay rejected this node; check its fleet access in relay.mere.run"
                ));
            }
        }
        ServerMessage::Job {
            job_id,
            lease_id,
            client_id,
            owner_user_id,
            upload_url,
            direct_image,
            request,
        } => {
            let _work_permit = work_gate.acquire("relay", &job_id).await;
            let kind = job_kind_label(&request.kind);
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": job_id, "kind": kind, "state": "started",
                    "client_id": client_id, "prompt": request.prompt, "model": request.model,
                }),
            );

            // Signal in-progress immediately; per-step updates follow while
            // the model loads and denoises.
            let _ = out_tx.send(Message::Text(
                serde_json::to_string(&AgentMessage::Progress {
                    job_id: job_id.clone(),
                    lease_id: lease_id.clone(),
                    step: 0,
                    total_steps: request.steps.max(1),
                    preview_base64: None,
                })?
                .into(),
            ));

            // Forward per-step progress from the generation process to the
            // relay as it happens.
            let (progress_tx, mut progress_rx) =
                mpsc::unbounded_channel::<mererun::JobProgressUpdate>();
            let forward_out = out_tx.clone();
            let forward_job_id = job_id.clone();
            let forward_lease_id = lease_id.clone();
            let progress_forwarder = tokio::spawn(async move {
                while let Some(update) = progress_rx.recv().await {
                    let message = AgentMessage::Progress {
                        job_id: forward_job_id.clone(),
                        lease_id: forward_lease_id.clone(),
                        step: update.step,
                        total_steps: update.total_steps,
                        preview_base64: None,
                    };
                    let Ok(txt) = serde_json::to_string(&message) else {
                        break;
                    };
                    if forward_out.send(Message::Text(txt.into())).is_err() {
                        break;
                    }
                }
            });

            let started = Instant::now();
            let job_outcome = run_job(&request, &job_id, progress_tx).await;
            // run_job dropped its sender; wait for queued progress to flush so
            // the relay never sees progress after the result.
            let _ = progress_forwarder.await;
            let result_msg = match job_outcome {
                Ok(output) => {
                    build_success(
                        JobResultContext {
                            job_id: &job_id,
                            lease_id: lease_id.as_deref(),
                            owner_user_id: &owner_user_id,
                            upload_url: &upload_url,
                            direct_image,
                            seed: request.seed,
                            started,
                        },
                        output,
                    )
                    .await
                }
                Err(e) => AgentMessage::Result {
                    job_id: job_id.clone(),
                    lease_id: lease_id.clone(),
                    owner_user_id: Some(owner_user_id.clone()),
                    success: false,
                    image_url: None,
                    image_data: None,
                    media_url: None,
                    media_data: None,
                    content_type: None,
                    output_kind: Some(kind.to_string()),
                    seed: None,
                    generation_time_ms: None,
                    error: Some(e.to_string()),
                },
            };

            let ok = matches!(&result_msg, AgentMessage::Result { success, .. } if *success);
            out_tx.send(Message::Text(serde_json::to_string(&result_msg)?.into()))?;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": job_id, "kind": kind, "state": if ok { "done" } else { "failed" },
                }),
            );
        }
        ServerMessage::ChatRequest {
            chat_id,
            client_id,
            request,
        } => {
            let _work_permit = work_gate.acquire("relay", &chat_id).await;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": chat_id, "kind": "text", "state": "started",
                    "client_id": client_id,
                    "prompt": request.messages.last().map(|message| message.content.clone()).unwrap_or_default(),
                    "model": request.model,
                }),
            );

            let result_msg = match run_chat(&request).await {
                Ok(response) => AgentMessage::ChatResponse {
                    chat_id: chat_id.clone(),
                    response,
                    tokens_generated: None,
                },
                Err(e) => AgentMessage::ChatError {
                    chat_id: chat_id.clone(),
                    error: e.to_string(),
                },
            };

            let ok = matches!(&result_msg, AgentMessage::ChatResponse { .. });
            out_tx.send(Message::Text(serde_json::to_string(&result_msg)?.into()))?;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": chat_id, "kind": "text", "state": if ok { "done" } else { "failed" },
                }),
            );
        }
        ServerMessage::AsrRequest {
            asr_id,
            client_id,
            owner_user_id,
            request,
        } => {
            execute_asr_request(
                AsrExecutionContext {
                    app,
                    out_tx,
                    active_asrs,
                    work_gate,
                },
                asr_id,
                client_id,
                owner_user_id,
                request,
            )
            .await?;
        }
        ServerMessage::EmbedRequest {
            embed_id,
            client_id,
            owner_user_id,
            request,
        } => {
            let _work_permit = work_gate.acquire("relay", &embed_id).await;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": embed_id, "kind": "embed", "state": "started",
                    "client_id": client_id, "prompt": format!("{} text chunk(s)", request.texts.len()),
                    "model": request.model,
                }),
            );

            let result_msg = match mererun::embed_texts(&request).await {
                Ok(output) => AgentMessage::EmbedResponse {
                    embed_id: embed_id.clone(),
                    owner_user_id: Some(owner_user_id.clone()),
                    model: output.model,
                    dimensions: output.dimensions,
                    data: output.data,
                },
                Err(e) => AgentMessage::EmbedError {
                    embed_id: embed_id.clone(),
                    owner_user_id: Some(owner_user_id.clone()),
                    error: e.to_string(),
                },
            };

            let ok = matches!(&result_msg, AgentMessage::EmbedResponse { .. });
            out_tx.send(Message::Text(serde_json::to_string(&result_msg)?.into()))?;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": embed_id, "kind": "embed", "state": if ok { "done" } else { "failed" },
                }),
            );
        }
        ServerMessage::ToolRequest {
            tool_id,
            client_id,
            owner_user_id,
            upload_url_base,
            request,
        } => {
            let _work_permit = work_gate.acquire("relay", &tool_id).await;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": tool_id, "kind": "tool", "state": "started",
                    "client_id": client_id,
                    "prompt": format!("{} {}", request.plugin, request.command),
                    "model": request.plugin,
                }),
            );

            let _ = out_tx.send(Message::Text(
                serde_json::to_string(&AgentMessage::ToolProgress {
                    tool_id: tool_id.clone(),
                    step: 0,
                    total_steps: 1,
                    message: Some("running plugin".to_string()),
                })?
                .into(),
            ));

            let (cancel_tx, cancel_rx) = watch::channel(false);
            active_tools.lock().await.insert(tool_id.clone(), cancel_tx);
            let outcome = run_tool(&request, &tool_id, &upload_url_base, cancel_rx).await;
            active_tools.lock().await.remove(&tool_id);
            let outcome = match outcome {
                Ok(plugins::ToolRunOutcome::Completed(output)) => Ok(output),
                Ok(plugins::ToolRunOutcome::Canceled) => {
                    emit(
                        app,
                        "node:job",
                        serde_json::json!({
                            "job_id": tool_id, "kind": "tool", "state": "canceled",
                            "prompt": format!("{} {}", request.plugin, request.command),
                            "model": request.plugin,
                        }),
                    );
                    return Ok(());
                }
                Err(error) => Err(error),
            };
            let result_msg = match outcome {
                Ok(output) => AgentMessage::ToolResult {
                    tool_id: tool_id.clone(),
                    owner_user_id: Some(owner_user_id.clone()),
                    artifacts: output.artifacts,
                    run_manifest: Some(output.run_manifest),
                    summary: output.summary,
                },
                Err(e) => AgentMessage::ToolError {
                    tool_id: tool_id.clone(),
                    owner_user_id: Some(owner_user_id.clone()),
                    error: e.to_string(),
                },
            };

            let ok = matches!(&result_msg, AgentMessage::ToolResult { .. });
            out_tx.send(Message::Text(serde_json::to_string(&result_msg)?.into()))?;
            emit(
                app,
                "node:job",
                serde_json::json!({
                    "job_id": tool_id, "kind": "tool", "state": if ok { "done" } else { "failed" },
                }),
            );
        }
        ServerMessage::GraphRequest {
            job_id,
            client_id,
            owner_user_id,
            bundle_files,
            upload_url_base,
        } => {
            let (cancel_tx, cancel_rx) = watch::channel(false);
            {
                let mut active = active_graphs.lock().await;
                if active.contains_key(&job_id) {
                    return Err(anyhow!("graph job {job_id} is already running"));
                }
                active.insert(job_id.clone(), cancel_tx);
            }
            let forward_out = out_tx.clone();
            let forward_job_id = job_id.clone();
            let forward_owner_id = owner_user_id.clone();
            let active = active_graphs.clone();
            let gate = work_gate.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let _work_permit = gate.acquire("relay", &forward_job_id).await;
                emit(
                    &app,
                    "node:job",
                    serde_json::json!({
                        "job_id": forward_job_id.clone(), "kind": "graph", "state": "started",
                        "client_id": client_id,
                    }),
                );
                let (event_tx, mut event_rx) = mpsc::unbounded_channel::<serde_json::Value>();
                let event_out = forward_out.clone();
                let event_job_id = forward_job_id.clone();
                let event_owner_id = forward_owner_id.clone();
                let event_forwarder = tokio::spawn(async move {
                    while let Some(event) = event_rx.recv().await {
                        let message = AgentMessage::GraphEvent {
                            job_id: event_job_id.clone(),
                            owner_user_id: Some(event_owner_id.clone()),
                            event,
                        };
                        let Ok(text) = serde_json::to_string(&message) else {
                            break;
                        };
                        if event_out.send(Message::Text(text.into())).is_err() {
                            break;
                        }
                    }
                });

                let outcome = graph::execute(
                    &forward_job_id,
                    &bundle_files,
                    &upload_url_base,
                    event_tx,
                    cancel_rx,
                )
                .await;
                let _ = event_forwarder.await;
                let message = match outcome {
                    Ok(output) => AgentMessage::GraphResult {
                        job_id: forward_job_id.clone(),
                        owner_user_id: Some(forward_owner_id),
                        run_manifest: output.run_manifest,
                        artifacts: output.artifacts,
                        metrics: output.metrics,
                    },
                    Err(error) => AgentMessage::GraphError {
                        job_id: forward_job_id.clone(),
                        owner_user_id: Some(forward_owner_id),
                        error: error.to_string(),
                    },
                };
                send_graph_completion(&active, &forward_out, &forward_job_id, message).await;
            });
        }
        ServerMessage::Cancel { job_id } => {
            // TODO: cooperative cancellation of an in-flight mere.run process.
            emit(
                app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("cancel requested for {job_id}")
                }),
            );
        }
        ServerMessage::AsrCancel { asr_id } => {
            cancel_asr_request(app, active_asrs, &asr_id).await;
        }
        ServerMessage::AsrStreamStart {
            session_id,
            protocol,
            sample_rate,
            input_format,
            backend,
            language,
        } => {
            live_asr
                .start(
                    session_id,
                    protocol,
                    sample_rate,
                    input_format,
                    backend,
                    language,
                )
                .await;
        }
        ServerMessage::AsrStreamStop { session_id } => {
            live_asr.stop(&session_id).await;
        }
        ServerMessage::AsrStreamCancel { session_id } => {
            live_asr.cancel(&session_id).await;
        }
        ServerMessage::EmbedCancel { embed_id } => {
            emit(
                app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("embed cancel requested for {embed_id}")
                }),
            );
        }
        ServerMessage::ToolCancel { tool_id } => {
            if let Some(cancel) = active_tools.lock().await.get(&tool_id) {
                let _ = cancel.send(true);
            }
            emit(
                app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("tool cancel requested for {tool_id}")
                }),
            );
        }
        ServerMessage::GraphCancel { job_id } => {
            if let Some(cancel) = active_graphs.lock().await.get(&job_id) {
                let _ = cancel.send(true);
            }
            emit(
                app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("graph cancel requested for {job_id}")
                }),
            );
        }
        ServerMessage::ModelPlanRequest {
            plan_id,
            attempt,
            model_ids,
            accept_model_licenses,
        } => {
            let (cancel_tx, cancel_rx) = watch::channel(false);
            {
                let mut active = active_model_plans.lock().await;
                if active.contains_key(&plan_id) {
                    return Err(anyhow!("model plan {plan_id} is already running"));
                }
                active.insert(plan_id.clone(), cancel_tx);
            }
            let forward_out = out_tx.clone();
            let forward_plan_id = plan_id.clone();
            let active = active_model_plans.clone();
            let gate = work_gate.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let gate_work_id = format!("model-plan:{forward_plan_id}");
                let _work_permit = gate.acquire("relay", &gate_work_id).await;
                emit(
                    &app,
                    "node:job",
                    serde_json::json!({
                        "job_id": forward_plan_id.clone(), "kind": "model-plan", "state": "started",
                        "model_count": model_ids.len(),
                    }),
                );
                let (event_tx, mut event_rx) =
                    mpsc::unbounded_channel::<model_plan::ModelPlanProgress>();
                let event_out = forward_out.clone();
                let event_plan_id = forward_plan_id.clone();
                let event_forwarder = tokio::spawn(async move {
                    while let Some(event) = event_rx.recv().await {
                        let message = AgentMessage::ModelPlanEvent {
                            plan_id: event_plan_id.clone(),
                            attempt,
                            model_id: event.model_id,
                            phase: event.phase,
                            message: event.message,
                        };
                        let Ok(text) = serde_json::to_string(&message) else {
                            break;
                        };
                        if event_out.send(Message::Text(text.into())).is_err() {
                            break;
                        }
                    }
                });
                let results =
                    model_plan::execute(&model_ids, accept_model_licenses, event_tx, cancel_rx)
                        .await;
                let _ = event_forwarder.await;
                let installed_model_ids = mererun::installed_models().await;
                active.lock().await.remove(&forward_plan_id);
                let message = AgentMessage::ModelPlanResult {
                    plan_id: forward_plan_id,
                    attempt,
                    results,
                    installed_model_ids,
                };
                if let Ok(text) = serde_json::to_string(&message) {
                    let _ = forward_out.send(Message::Text(text.into()));
                }
            });
        }
        ServerMessage::ModelPlanCancel { plan_id } => {
            if let Some(cancel) = active_model_plans.lock().await.get(&plan_id) {
                let _ = cancel.send(true);
            }
            emit(
                app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("model plan cancel requested for {plan_id}")
                }),
            );
        }
        ServerMessage::InventoryRequest => {
            let inventory = collect_inventory(configured_models).await;
            let message = AgentMessage::InventoryUpdate {
                capabilities: inventory.capabilities,
                system: inventory.system,
                runtime: inventory.runtime,
                capacity: inventory.capacity,
            };
            out_tx.send(Message::Text(serde_json::to_string(&message)?.into()))?;
        }
        ServerMessage::Other => {}
    }
    Ok(())
}

struct JobResultContext<'a> {
    job_id: &'a str,
    lease_id: Option<&'a str>,
    owner_user_id: &'a str,
    upload_url: &'a str,
    direct_image: bool,
    seed: Option<i64>,
    started: Instant,
}

async fn build_success(
    context: JobResultContext<'_>,
    output: mererun::GeneratedOutput,
) -> AgentMessage {
    let content_type = output.content_type.to_string();
    let output_kind = output.kind.to_string();
    let outcome: Result<(Option<String>, Option<String>)> = async {
        let bytes = tokio::fs::read(&output.path).await?;
        if context.direct_image && output.kind == "image" {
            Ok((
                None,
                Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            ))
        } else {
            let media_url = upload_output(context.upload_url, output.content_type, bytes).await?;
            Ok((Some(media_url), None))
        }
    }
    .await;

    match outcome {
        Ok((image_url, image_data)) => AgentMessage::Result {
            job_id: context.job_id.to_string(),
            lease_id: context.lease_id.map(str::to_string),
            owner_user_id: Some(context.owner_user_id.to_string()),
            success: true,
            media_url: image_url.clone(),
            media_data: image_data.clone(),
            image_url,
            image_data,
            content_type: Some(content_type),
            output_kind: Some(output_kind),
            seed: context.seed,
            generation_time_ms: Some(context.started.elapsed().as_millis() as u64),
            error: None,
        },
        Err(e) => AgentMessage::Result {
            job_id: context.job_id.to_string(),
            lease_id: context.lease_id.map(str::to_string),
            owner_user_id: Some(context.owner_user_id.to_string()),
            success: false,
            image_url: None,
            image_data: None,
            media_url: None,
            media_data: None,
            content_type: None,
            output_kind: Some(output_kind),
            seed: None,
            generation_time_ms: None,
            error: Some(format!("post-generation: {e}")),
        },
    }
}

async fn run_job(
    req: &JobRequest,
    job_id: &str,
    progress: mererun::ProgressSender,
) -> Result<mererun::GeneratedOutput> {
    let dir = std::env::temp_dir().join("mere-run-node");
    mererun::generate_job_output(req, &dir, job_id, Some(progress)).await
}

struct AsrExecutionContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    out_tx: &'a mpsc::UnboundedSender<Message>,
    active_asrs: &'a ActiveAsrJobs,
    work_gate: &'a DeviceWorkGate,
}

async fn execute_asr_request<R: Runtime>(
    context: AsrExecutionContext<'_, R>,
    asr_id: String,
    client_id: String,
    owner_user_id: String,
    request: AsrRequest,
) -> Result<()> {
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut active = context.active_asrs.lock().await;
        if active.contains_key(&asr_id) {
            return Err(anyhow!("ASR {asr_id} is already running"));
        }
        active.insert(asr_id.clone(), cancel_tx);
    }
    let _work_permit = context.work_gate.acquire("relay", &asr_id).await;
    emit(
        context.app,
        "node:job",
        serde_json::json!({
            "job_id": asr_id, "kind": "asr", "state": "started",
            "client_id": client_id, "prompt": "remote audio", "model": "mere.run speech transcribe",
        }),
    );

    let message = build_asr_result(&asr_id, &owner_user_id, &request, cancel_rx).await;
    context.active_asrs.lock().await.remove(&asr_id);
    let state = match &message {
        AgentMessage::AsrResponse { .. } => "done",
        AgentMessage::AsrError { error, .. } if error == "speech transcription cancelled" => {
            "cancelled"
        }
        _ => "failed",
    };
    context
        .out_tx
        .send(Message::Text(serde_json::to_string(&message)?.into()))?;
    emit(
        context.app,
        "node:job",
        serde_json::json!({
            "job_id": asr_id,
            "kind": "asr",
            "state": state,
        }),
    );
    Ok(())
}

async fn build_asr_result(
    asr_id: &str,
    owner_user_id: &str,
    request: &AsrRequest,
    cancel: watch::Receiver<bool>,
) -> AgentMessage {
    match run_asr(request, asr_id, cancel).await {
        Ok(output) => AgentMessage::AsrResponse {
            asr_id: asr_id.to_string(),
            owner_user_id: Some(owner_user_id.to_string()),
            text: output.text,
            language: output.language,
            duration_seconds: output.duration_seconds,
            token_alignments: output.token_alignments,
            sentence_alignments: output.sentence_alignments,
            speaker_segments: output.speaker_segments,
        },
        Err(error) => AgentMessage::AsrError {
            asr_id: asr_id.to_string(),
            owner_user_id: Some(owner_user_id.to_string()),
            error: error.to_string(),
        },
    }
}

async fn cancel_asr_request<R: Runtime>(
    app: &AppHandle<R>,
    active_asrs: &ActiveAsrJobs,
    asr_id: &str,
) {
    if let Some(cancel) = active_asrs.lock().await.get(asr_id) {
        let _ = cancel.send(true);
    }
    emit(
        app,
        "node:log",
        serde_json::json!({
            "level": "info", "message": format!("ASR cancel requested for {asr_id}")
        }),
    );
}

async fn run_asr(
    req: &AsrRequest,
    asr_id: &str,
    cancel: watch::Receiver<bool>,
) -> Result<crate::protocol::AsrOutput> {
    let dir = std::env::temp_dir().join("mere-run-node").join("asr");
    mererun::transcribe_speech(req, &dir, asr_id, cancel).await
}

async fn run_chat(req: &ChatRequest) -> Result<String> {
    mererun::chat_text(req).await
}

struct TalkExecutionContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    out_tx: &'a mpsc::UnboundedSender<Message>,
    active_talks: &'a ActiveTalkJobs,
    work_gate: &'a DeviceWorkGate,
}

async fn handle_talk_server_message<R: Runtime>(
    context: TalkExecutionContext<'_, R>,
    text: &str,
) -> Result<()> {
    match serde_json::from_str::<TalkServerMessage>(text)? {
        TalkServerMessage::TalkRequest {
            talk_id,
            client_id,
            owner_user_id,
            upload_url,
            direct_audio,
            request,
        } => {
            execute_talk_request(
                context,
                talk_id,
                client_id,
                owner_user_id,
                upload_url,
                direct_audio,
                request,
            )
            .await
        }
        TalkServerMessage::TalkCancel { talk_id } => {
            if let Some(cancel) = context.active_talks.lock().await.get(&talk_id) {
                let _ = cancel.send(true);
            }
            emit(
                context.app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("talk cancel requested for {talk_id}")
                }),
            );
            Ok(())
        }
        TalkServerMessage::Other => Ok(()),
    }
}

async fn execute_talk_request<R: Runtime>(
    context: TalkExecutionContext<'_, R>,
    talk_id: String,
    client_id: String,
    owner_user_id: String,
    upload_url: String,
    direct_audio: bool,
    request: TalkRequest,
) -> Result<()> {
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut active = context.active_talks.lock().await;
        if active.contains_key(&talk_id) {
            return Err(anyhow!("talk {talk_id} is already running"));
        }
        active.insert(talk_id.clone(), cancel_tx);
    }

    let _work_permit = context.work_gate.acquire("relay", &talk_id).await;
    emit(
        context.app,
        "node:job",
        serde_json::json!({
            "job_id": talk_id, "kind": "talk", "state": "started",
            "client_id": client_id, "prompt": request.text, "model": "speech-tts-qwen3-nano",
        }),
    );

    let result = build_talk_result(
        &talk_id,
        &owner_user_id,
        &upload_url,
        direct_audio,
        &request,
        cancel_rx,
    )
    .await;
    context.active_talks.lock().await.remove(&talk_id);
    let state = match &result {
        AgentMessage::TalkResponse { .. } => "done",
        AgentMessage::TalkError { error, .. } if error == "speech synthesis cancelled" => {
            "cancelled"
        }
        _ => "failed",
    };
    context
        .out_tx
        .send(Message::Text(serde_json::to_string(&result)?.into()))?;
    emit(
        context.app,
        "node:job",
        serde_json::json!({
            "job_id": talk_id,
            "kind": "talk",
            "state": state,
        }),
    );
    Ok(())
}

async fn build_talk_result(
    talk_id: &str,
    owner_user_id: &str,
    upload_url: &str,
    direct_audio: bool,
    request: &TalkRequest,
    cancel: watch::Receiver<bool>,
) -> AgentMessage {
    let out_dir = std::env::temp_dir().join("mere-run-node").join("talk");
    let outcome: Result<(Option<String>, Option<String>, f64, u32)> = async {
        let speech = mererun::synthesize_speech(request, &out_dir, talk_id, cancel).await?;
        let delivery: Result<(Option<String>, Option<String>)> = async {
            let bytes = tokio::fs::read(&speech.path).await?;
            if direct_audio {
                Ok((
                    None,
                    Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
                ))
            } else {
                Ok((
                    Some(upload_output(upload_url, "audio/wav", bytes).await?),
                    None,
                ))
            }
        }
        .await;
        let _ = tokio::fs::remove_file(&speech.path).await;
        let delivery = delivery?;
        Ok((
            delivery.0,
            delivery.1,
            speech.duration_seconds,
            speech.sample_rate,
        ))
    }
    .await;

    match outcome {
        Ok((audio_url, audio_data, duration_seconds, sample_rate)) => AgentMessage::TalkResponse {
            talk_id: talk_id.to_string(),
            owner_user_id: Some(owner_user_id.to_string()),
            audio_url,
            audio_data,
            duration_seconds,
            sample_rate,
            output_format: "wav".to_string(),
        },
        Err(error) => AgentMessage::TalkError {
            talk_id: talk_id.to_string(),
            owner_user_id: Some(owner_user_id.to_string()),
            error: error.to_string(),
        },
    }
}

struct OcrExecutionContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    out_tx: &'a mpsc::UnboundedSender<Message>,
    active_ocrs: &'a ActiveOcrJobs,
    work_gate: &'a DeviceWorkGate,
}

async fn handle_ocr_server_message<R: Runtime>(
    context: OcrExecutionContext<'_, R>,
    text: &str,
) -> Result<()> {
    match serde_json::from_str::<OcrServerMessage>(text)? {
        OcrServerMessage::OcrRequest {
            ocr_id,
            client_id,
            owner_user_id,
            request,
        } => execute_ocr_request(context, ocr_id, client_id, owner_user_id, request).await,
        OcrServerMessage::OcrCancel { ocr_id } => {
            if let Some(cancel) = context.active_ocrs.lock().await.get(&ocr_id) {
                let _ = cancel.send(true);
            }
            emit(
                context.app,
                "node:log",
                serde_json::json!({
                    "level": "info", "message": format!("OCR cancel requested for {ocr_id}")
                }),
            );
            Ok(())
        }
        OcrServerMessage::Other => Ok(()),
    }
}

async fn execute_ocr_request<R: Runtime>(
    context: OcrExecutionContext<'_, R>,
    ocr_id: String,
    client_id: String,
    owner_user_id: String,
    request: OcrRequest,
) -> Result<()> {
    let (cancel_tx, cancel_rx) = watch::channel(false);
    {
        let mut active = context.active_ocrs.lock().await;
        if active.contains_key(&ocr_id) {
            return Err(anyhow!("OCR {ocr_id} is already running"));
        }
        active.insert(ocr_id.clone(), cancel_tx);
    }

    let _work_permit = context.work_gate.acquire("relay", &ocr_id).await;
    emit(
        context.app,
        "node:job",
        serde_json::json!({
            "job_id": ocr_id, "kind": "ocr", "state": "started",
            "client_id": client_id, "prompt": "remote image", "model": "mere.run vision ocr",
        }),
    );

    let result = build_ocr_result(&ocr_id, &owner_user_id, &request, cancel_rx).await;
    context.active_ocrs.lock().await.remove(&ocr_id);
    let state = match &result {
        AgentMessage::OcrResponse { .. } => "done",
        AgentMessage::OcrError { error, .. } if error == "OCR extraction cancelled" => "cancelled",
        _ => "failed",
    };
    context
        .out_tx
        .send(Message::Text(serde_json::to_string(&result)?.into()))?;
    emit(
        context.app,
        "node:job",
        serde_json::json!({
            "job_id": ocr_id,
            "kind": "ocr",
            "state": state,
        }),
    );
    Ok(())
}

async fn build_ocr_result(
    ocr_id: &str,
    owner_user_id: &str,
    request: &OcrRequest,
    cancel: watch::Receiver<bool>,
) -> AgentMessage {
    let out_dir = std::env::temp_dir().join("mere-run-node").join("ocr");
    match mererun::extract_ocr_text(request, &out_dir, ocr_id, cancel).await {
        Ok(output) => AgentMessage::OcrResponse {
            ocr_id: ocr_id.to_string(),
            owner_user_id: Some(owner_user_id.to_string()),
            text: output.text,
            tokens_generated: output.tokens_generated,
        },
        Err(error) => AgentMessage::OcrError {
            ocr_id: ocr_id.to_string(),
            owner_user_id: Some(owner_user_id.to_string()),
            error: error.to_string(),
        },
    }
}

async fn run_tool(
    req: &ToolRequest,
    tool_id: &str,
    upload_url_base: &str,
    cancel: watch::Receiver<bool>,
) -> Result<plugins::ToolRunOutcome> {
    plugins::run_tool(req, tool_id, upload_url_base, cancel).await
}

async fn upload_output(upload_url: &str, content_type: &str, bytes: Vec<u8>) -> Result<String> {
    #[derive(serde::Deserialize)]
    struct UploadResponse {
        #[serde(default)]
        image_url: String,
        #[serde(default)]
        media_url: String,
        #[serde(default)]
        audio_url: String,
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(upload_url)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("upload failed: {}", resp.status()));
    }
    let parsed: UploadResponse = resp.json().await?;
    if !parsed.media_url.is_empty() {
        Ok(parsed.media_url)
    } else if !parsed.audio_url.is_empty() {
        Ok(parsed.audio_url)
    } else {
        Ok(parsed.image_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_ocr_messages_to_the_typed_dispatcher() {
        assert!(is_ocr_message(
            r#"{"type":"ocr_request","ocr_id":"ocr_123"}"#
        ));
        assert!(is_ocr_message(
            r#"{"type":"ocr_cancel","ocr_id":"ocr_123"}"#
        ));
        assert!(!is_ocr_message(
            r#"{"type":"asr_request","asr_id":"asr_123"}"#
        ));
    }

    #[test]
    fn connected_auth_errors_distinguish_retry_from_sign_in() {
        assert_eq!(
            classify_connected_auth_error(
                "auth_refresh_failed: broker temporarily unavailable".to_string()
            ),
            ConnectedAuthEvent::Retry(
                "auth_refresh_failed: broker temporarily unavailable".to_string()
            )
        );
        assert_eq!(
            classify_connected_auth_error(
                "auth_required: saved session expired; sign in again".to_string()
            ),
            ConnectedAuthEvent::SignInRequired(
                "auth_required: saved session expired; sign in again".to_string()
            )
        );
    }

    #[test]
    fn completed_plugin_probe_survives_unrelated_inventory_timeouts() {
        let fallback = fallback_inventory(&["video-ltx23-av-mlx".to_string()]);
        let plugin = PluginCapability {
            name: "mere-animatic-tools".to_string(),
            version: Some("0.2.0".to_string()),
            executable: Some("mere-animatic-tools".to_string()),
            description: None,
            commands: vec!["build-set-proxy".to_string()],
            capabilities: vec!["usd".to_string()],
        };

        let inventory =
            assemble_inventory(fallback, None, Some(vec![plugin]), None, None, None, None);

        assert_eq!(
            inventory.capabilities.models,
            vec!["video-ltx23-av-mlx".to_string()]
        );
        assert_eq!(inventory.capabilities.plugins.len(), 1);
        assert_eq!(
            inventory.capabilities.plugins[0].name,
            "mere-animatic-tools"
        );
        assert!(matches!(
            inventory.runtime.inventory_status,
            Some(ModelInventoryStatus::Failed)
        ));
    }

    #[tokio::test]
    #[ignore = "requires installed mere.run and companion plugins"]
    async fn live_inventory_probe_reports_graph_worker_and_companion_plugins() {
        let started = Instant::now();
        let inventory = collect_inventory(&[]).await;
        let names = inventory
            .capabilities
            .plugins
            .iter()
            .map(|plugin| plugin.name.as_str())
            .collect::<Vec<_>>();
        let encoded = serde_json::to_vec(&inventory.capabilities).expect("inventory JSON");
        println!(
            "inventory_ms={} bytes={} plugins={names:?}",
            started.elapsed().as_millis(),
            encoded.len()
        );
        assert!(names.contains(&"mere-animatic-tools"));
        assert!(names.contains(&"mere-vfx-tools"));
        assert!(names.contains(&"mere-run-subject-video"));
        let graph_worker = inventory
            .capabilities
            .graph_worker
            .expect("live inventory dropped the graph worker contract");
        assert!(graph_worker
            .contract_versions
            .iter()
            .any(|version| version == "mere.run/job-bundle.v1"));
    }

    #[tokio::test]
    async fn graph_completion_releases_local_slot_before_notifying_relay() {
        let active = ActiveGraphJobs::default();
        let (cancel, _) = watch::channel(false);
        active.lock().await.insert("retry-job".to_string(), cancel);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        let observing_active = active.clone();
        let observer = tokio::spawn(async move {
            let message = out_rx.recv().await.expect("completion message");
            assert!(!observing_active.lock().await.contains_key("retry-job"));
            message
        });

        send_graph_completion(
            &active,
            &out_tx,
            "retry-job",
            AgentMessage::GraphError {
                job_id: "retry-job".to_string(),
                owner_user_id: Some("owner".to_string()),
                error: "cancelled".to_string(),
            },
        )
        .await;

        let sent = observer.await.expect("observer");
        assert!(sent.to_text().expect("text frame").contains("graph_error"));
    }

    /// Live regression check that slow model and graph probes cannot erase the
    /// companion-plugin inventory required by Animatic placement.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn e2e_relay_reports_companion_plugin_inventory() {
        const RELAY_HTTP: &str = "https://relay.mere.run";

        let auth_path = std::env::var("MERERUN_NODE_AUTH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").expect("HOME"))
                    .join("Library/Application Support/com.mere.run.node/auth.json")
            });
        let token = deviceauth::load_fresh(&auth_path)
            .await
            .expect("fresh node token");
        let bearer = format!("Bearer {}", token.access_token);
        let device_id = format!("node-plugin-inventory-e2e-{}", std::process::id());
        let config = NodeConfig {
            relay_url: format!("{}/agent", RELAY_HTTP.replace("https", "wss")),
            auth_path,
            device_name: "plugin inventory e2e (temporary)".to_string(),
            device_id: device_id.clone(),
            models: Vec::new(),
        };
        let app = tauri::test::mock_app();
        let app_handle = app.handle().clone();
        let connected_device_id = device_id.clone();
        let (stop_tx, stop_rx) = watch::channel(false);
        let mut agent_task = tokio::spawn(async move {
            let mut stop_rx = stop_rx;
            connect_and_serve(
                &app_handle,
                &config,
                &connected_device_id,
                &DeviceWorkGate::default(),
                &mut stop_rx,
            )
            .await
        });
        let client = reqwest::Client::builder()
            .http1_only()
            .pool_max_idle_per_host(0)
            .timeout(Duration::from_secs(5))
            .build()
            .expect("HTTP client");
        let deadline = Instant::now() + Duration::from_secs(45);

        let plugins = loop {
            assert!(
                Instant::now() < deadline,
                "temporary node never reported companion plugins"
            );
            let fleet: serde_json::Value = client
                .get(format!("{RELAY_HTTP}/api/fleet"))
                .header("Authorization", &bearer)
                .send()
                .await
                .expect("fleet request")
                .json()
                .await
                .expect("fleet json");
            let plugins = fleet["nodes"].as_array().and_then(|nodes| {
                nodes
                    .iter()
                    .find(|node| node["device_id"] == device_id)
                    .and_then(|node| node["capabilities"]["plugins"].as_array())
            });
            if plugins.is_some_and(|plugins| plugins.len() >= 3) {
                break plugins.cloned().expect("plugin list");
            }
            tokio::select! {
                result = &mut agent_task => {
                    panic!("temporary node connection ended before inventory: {result:?}");
                }
                () = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        };

        let _ = stop_tx.send(true);
        let _ = agent_task.await;

        for (name, command_count) in [
            ("mere-animatic-tools", 19),
            ("mere-vfx-tools", 25),
            ("mere-run-subject-video", 3),
        ] {
            let plugin = plugins
                .iter()
                .find(|plugin| plugin["name"] == name)
                .unwrap_or_else(|| panic!("missing {name}: {plugins:?}"));
            assert_eq!(
                plugin["commands"].as_array().map(Vec::len),
                Some(command_count),
                "wrong {name} command inventory"
            );
        }
    }

    /// Live end-to-end check of per-step job progress against the production
    /// relay. The agent connects with a throwaway device_id (so it never
    /// replaces an installed node's identity), a job is pinned to it, and the
    /// relay's job status is polled while the image generates.
    ///
    /// Requires network access, a signed-in node auth file, and a local
    /// `mere.run` with image models installed. Run explicitly:
    ///
    /// ```sh
    /// MERERUN_BIN=/path/to/mere.run \
    ///   cargo test --lib -- --ignored e2e_relay_reports_per_step_progress --nocapture
    /// ```
    ///
    /// Auth-sharing caveat: the broker's refresh tokens are single-use. This
    /// test refreshes the token ONCE, up front, before the agent starts, so
    /// the agent's own `load_fresh` finds a fresh token and does not race a
    /// second rotation. If the installed node app reconnects mid-test it will
    /// pick up the rotated file (see `resolve_refresh_failure`). Prefer a
    /// dedicated `MERERUN_NODE_AUTH` token file when running repeatedly.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn e2e_relay_reports_per_step_progress() {
        const RELAY_HTTP: &str = "https://relay.mere.run";
        const MODEL: &str = "image-zimage-nano";

        let auth_path = std::env::var("MERERUN_NODE_AUTH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").expect("HOME"))
                    .join("Library/Application Support/com.mere.run.node/auth.json")
            });
        assert!(
            auth_path.is_file(),
            "no node auth at {auth_path:?}; sign in with the node app first or set MERERUN_NODE_AUTH"
        );

        // Refresh once BEFORE the agent starts: both consumers then share one
        // fresh token instead of racing two single-use refresh grants.
        let token = deviceauth::load_fresh(&auth_path)
            .await
            .expect("fresh token");
        let client = reqwest::Client::new();
        let bearer = format!("Bearer {}", token.access_token);

        let device_id = format!("node-progress-e2e-{}", std::process::id());
        let config = NodeConfig {
            relay_url: format!("{}/agent", RELAY_HTTP.replace("https", "wss")),
            auth_path: auth_path.clone(),
            device_name: "progress e2e (temporary)".to_string(),
            device_id: device_id.clone(),
            models: Vec::new(),
        };

        let app = tauri::test::mock_app();
        let (stop_tx, stop_rx) = watch::channel(false);
        let agent_task = tokio::spawn(run_agent(
            app.handle().clone(),
            config,
            DeviceWorkGate::default(),
            stop_rx,
        ));

        // Wait for the throwaway node to come online, then grab its agent_id.
        let deadline = Instant::now() + Duration::from_secs(60);
        let agent_id = loop {
            assert!(Instant::now() < deadline, "test node never came online");
            let fleet: serde_json::Value = client
                .get(format!("{RELAY_HTTP}/api/fleet"))
                .header("Authorization", &bearer)
                .send()
                .await
                .expect("fleet request")
                .json()
                .await
                .expect("fleet json");
            let found = fleet["nodes"].as_array().and_then(|nodes| {
                nodes.iter().find(|node| {
                    node["device_id"] == device_id.as_str()
                        && (node["status"] == "online" || node["status"] == "busy")
                })
            });
            if let Some(node) = found {
                break node["agent_id"].as_str().expect("agent_id").to_string();
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };

        let submit: serde_json::Value = client
            .post(format!("{RELAY_HTTP}/api/generate"))
            .header("Authorization", &bearer)
            .json(&serde_json::json!({
                "prompt": "relay progress e2e: a lighthouse at dawn",
                "model": MODEL,
                "width": 1024,
                "height": 1024,
                "steps": 4,
                "agent_id": agent_id,
            }))
            .send()
            .await
            .expect("submit request")
            .json()
            .await
            .expect("submit json");
        let job_id = submit["job_id"].as_str().expect("job_id").to_string();
        println!("submitted {job_id} pinned to {agent_id}");

        // Poll GET /api/job/{id} like a client would and record progress.
        type Observation = (u128, String, Option<(u64, u64)>);
        let started = Instant::now();
        let deadline = started + Duration::from_secs(240);
        let mut transitions: Vec<Observation> = Vec::new();
        let final_status = loop {
            assert!(
                Instant::now() < deadline,
                "job did not finish in time; saw {transitions:?}"
            );
            let job: serde_json::Value = client
                .get(format!("{RELAY_HTTP}/api/job/{job_id}"))
                .header("Authorization", &bearer)
                .send()
                .await
                .expect("job request")
                .json()
                .await
                .expect("job json");
            let status = job["status"].as_str().unwrap_or("?").to_string();
            let progress = job["progress"]
                .as_object()
                .and_then(|p| Some((p.get("step")?.as_u64()?, p.get("total_steps")?.as_u64()?)));
            let observation = (started.elapsed().as_millis(), status.clone(), progress);
            if transitions.last().map(|last| (&last.1, &last.2))
                != Some((&observation.1, &observation.2))
            {
                println!(
                    "t={}ms status={} progress={:?}",
                    observation.0, observation.1, observation.2
                );
                transitions.push(observation);
            }
            if status == "complete" || status == "failed" || status == "cancelled" {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        };

        let _ = stop_tx.send(true);
        let _ = agent_task.await;

        assert_eq!(final_status, "complete", "transitions: {transitions:?}");

        // Every non-zero step we polled, in order. The relay retains the last
        // progress on the completed job, so the final (4,4) is legitimately
        // observed twice — once while `generating`, once at `complete` — and
        // this raw sequence may contain a trailing repeat.
        let raw_steps: Vec<u64> = transitions
            .iter()
            .filter_map(|(_, _, progress)| progress.map(|(step, _)| step))
            .filter(|step| *step > 0)
            .collect();
        assert!(
            raw_steps.windows(2).all(|pair| pair[0] <= pair[1]),
            "steps must never regress, saw {raw_steps:?}"
        );

        // Collapse consecutive repeats to the distinct steps we advanced through.
        let mut steps: Vec<u64> = Vec::new();
        for step in &raw_steps {
            if steps.last() != Some(step) {
                steps.push(*step);
            }
        }
        assert!(
            steps.windows(2).all(|pair| pair[0] < pair[1]),
            "distinct steps must strictly advance, saw {steps:?}"
        );
        assert!(
            steps.len() >= 2,
            "expected to observe several distinct steps, saw {steps:?}"
        );
        assert_eq!(
            steps.last(),
            Some(&4),
            "final step must reach total, saw {steps:?}"
        );
        println!("observed advancing steps: {steps:?} (raw polls: {raw_steps:?})");
    }
}
