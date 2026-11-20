//! Terminal host for the existing Relay agent. No window, webview, or model API proxy.
use crate::{
    agent::{self, NodeConfig},
    deviceauth,
    event_sink::NodeEvents,
    work_gate::DeviceWorkGate,
};
use anyhow::{anyhow, Context, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Default)]
pub struct DaemonEvents {
    state: Arc<Mutex<Value>>,
}
impl NodeEvents for DaemonEvents {
    fn emit_event(&self, event: &str, payload: Value) {
        // Shared desktop events may contain prompts, URLs, or provider errors.
        // Project only operational fields into daemon output and health state.
        let mut safe = json!({ "event": event, "timestamp": epoch() });
        for key in [
            "connected",
            "running",
            "authRequired",
            "job_id",
            "kind",
            "state",
            "level",
        ] {
            if let Some(value) = payload.get(key) {
                safe[key] = value.clone();
            }
        }
        if event == "node:status" {
            let mut state = self.state.lock().expect("health lock");
            if state.is_null() {
                *state = json!({});
            }
            for key in ["connected", "running", "authRequired"] {
                if let Some(value) = safe.get(key) {
                    state[key] = value.clone();
                }
            }
        }
        println!("{safe}");
    }
}

pub fn initialize(directory: &Path) -> Result<()> {
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        verify_private_directory(directory)?;
    }
    Ok(())
}

#[cfg(unix)]
fn verify_private_directory(directory: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(directory)?;
    // Some mounted filesystems report chmod success without enforcing it.
    // Enrollment must reject them before creating identity or auth files.
    if !metadata.is_dir()
        || metadata.mode() & 0o777 != 0o700
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(anyhow!("Node state requires an owner-only POSIX directory"));
    }
    Ok(())
}

pub fn lock(directory: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(directory.join("daemon.lock"))?;
    file.try_lock_exclusive()
        .context("This identity is already used by a running daemon or enrollment")?;
    Ok(file)
}

pub fn device_id(directory: &Path) -> Result<String> {
    let path = directory.join("device-id");
    if path.exists() {
        return Ok(fs::read_to_string(path)?.trim().to_string());
    }
    // /dev/urandom is present on the supported Unix hosts. Never derive identity
    // from hostname, which is shared by cloned containers.
    use std::io::Read;
    let mut random = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let id = format!(
        "node-{}",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    fs::write(path, &id)?;
    Ok(id)
}

fn write_health(directory: &Path, events: &DaemonEvents, gate: &DeviceWorkGate) -> Result<()> {
    let state = events.state.lock().expect("health lock").clone();
    let health = json!({ "timestamp": epoch(), "pid": std::process::id(), "state": state, "work": gate.current() });
    let temporary = directory.join("health.tmp");
    fs::write(&temporary, serde_json::to_vec(&health)?)?;
    fs::rename(temporary, directory.join("health.json"))?;
    Ok(())
}

pub fn health_ready(health: &Value, now: u64) -> bool {
    let timestamp = health["timestamp"].as_u64().unwrap_or(0);
    now >= timestamp
        && now - timestamp <= 5
        && health["state"]["connected"] == true
        && health["state"]["running"] == true
        && health["work"]["accepting"] == true
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = terminate.recv() => {} }
    Ok(())
}

pub async fn serve(directory: PathBuf, relay_url: String) -> Result<()> {
    crate::protocol::declared_hosting_from_env().map_err(|error| anyhow!(error))?;
    let _lock = lock(&directory)?;
    // Explicit enrollment is required. Do not silently adopt desktop credentials.
    deviceauth::load_fresh(&directory.join("auth.json")).await?;
    let gate = DeviceWorkGate::default();
    if directory.join("drain").exists() {
        gate.begin_drain();
    }
    let events = DaemonEvents::default();
    let config = NodeConfig {
        relay_url,
        auth_path: directory.join("auth.json"),
        device_id: device_id(&directory)?,
        device_name: std::env::var("MERERUN_NODE_NAME").unwrap_or_else(|_| "Headless Node".into()),
        models: Vec::new(),
    };
    let (stop_tx, stop_rx) = watch::channel(false);
    let mut agent = tokio::spawn(agent::run_agent(
        events.clone(),
        config,
        gate.clone(),
        stop_rx,
    ));
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    let mut stopping = false;
    loop {
        tokio::select! {
            result = &mut agent => { result?; break; }
            result = &mut signal, if !stopping => {
                result?; stopping = true; gate.begin_drain();
                println!("{}", json!({"event":"node:draining", "reason":"shutdown"}));
            }
            _ = ticker.tick() => {
                if !stopping {
                    if directory.join("drain").exists() { gate.begin_drain(); }
                    else if !gate.is_accepting() { gate.resume(); }
                }
                write_health(&directory, &events, &gate)?;
                // The shared gate marks node-control only once active work has
                // released its permit. Keep the connection alive for upload and
                // lease/result delivery until then; never kill an active job here.
                if stopping && gate.current().source == "node-control" { let _ = stop_tx.send(true); }
            }
        }
    }
    write_health(&directory, &events, &gate)?;
    Ok(())
}

pub async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".into());
    if command == "help" || command == "--help" {
        println!("mere-run-node-headless <enroll|run|health|drain|resume> --state-dir PATH\nMERERUN_BIN pins the runtime. MERERUN_NODE_RELAY_URL optionally selects Relay.\nSIGTERM/Ctrl-C drains active work before disconnecting. State is private and separate from desktop.");
        return Ok(());
    }
    if args.next().as_deref() != Some("--state-dir") {
        return Err(anyhow!("--state-dir PATH is required"));
    }
    let directory = PathBuf::from(args.next().context("--state-dir PATH is required")?);
    if args.next().is_some() {
        return Err(anyhow!("Unexpected arguments"));
    }
    initialize(&directory)?;
    match command.as_str() {
        "enroll" => {
            let _lock = lock(&directory)?;
            let grant = deviceauth::start().await?;
            println!(
                "Approve this device at {} using code {}",
                grant.verification_uri, grant.user_code
            );
            println!(
                "{}",
                json!({"event":"node:enrollment-pending",
                "expires_in_seconds":grant.expires_in,
                "expires_at_epoch_seconds":epoch().saturating_add(grant.expires_in)})
            );
            let tokens =
                deviceauth::poll(&grant.device_code, grant.interval, grant.expires_in).await?;
            deviceauth::save(&directory.join("auth.json"), &tokens)?;
            let id = device_id(&directory)?;
            println!("{}", json!({ "event":"node:enrolled", "device_id":id }));
        }
        "run" => {
            let relay = std::env::var("MERERUN_NODE_RELAY_URL")
                .unwrap_or_else(|_| "wss://relay.mere.run/agent".into());
            let url = reqwest::Url::parse(&relay)?;
            let loopback = url
                .host_str()
                .is_some_and(|host| ["127.0.0.1", "localhost", "::1", "[::1]"].contains(&host));
            if url.scheme() != "wss" && !(url.scheme() == "ws" && loopback) {
                return Err(anyhow!(
                    "Relay must use WSS, or WS on loopback for local tests"
                ));
            }
            serve(directory, relay).await?;
        }
        "health" => {
            let health: Value = serde_json::from_slice(&fs::read(directory.join("health.json"))?)?;
            println!("{health}");
            if !health_ready(&health, epoch()) {
                return Err(anyhow!("Node is not ready"));
            }
        }
        "drain" => {
            fs::write(directory.join("drain"), b"drain\n")?;
        }
        "resume" => {
            if directory.join("drain").exists() {
                fs::remove_file(directory.join("drain"))?;
            }
        }
        _ => return Err(anyhow!("Unknown command; use --help")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn private_state_validation_rejects_unenforced_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("mere-headless-private-{}", std::process::id()));
        initialize(&dir).unwrap();
        verify_private_directory(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(verify_private_directory(&dir).is_err());
        assert!(!dir.join("auth.json").exists());
        initialize(&dir).unwrap();
        verify_private_directory(&dir).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn health_is_not_ready_after_crash_or_while_draining() {
        let mut value = json!({"timestamp":100, "state":{"connected":true,"running":true},"work":{"accepting":true}});
        assert!(health_ready(&value, 104));
        assert!(!health_ready(&value, 106));
        value["work"]["accepting"] = json!(false);
        assert!(!health_ready(&value, 101));
    }
    #[test]
    fn health_projection_excludes_prompts_tokens_and_signed_urls() {
        let events = DaemonEvents::default();
        events.emit_event("node:status", json!({"connected":true,"running":true,"prompt":"private", "token":"secret", "message":"signed-url"}));
        assert_eq!(
            *events.state.lock().unwrap(),
            json!({"connected":true,"running":true})
        );
    }
    #[test]
    fn identity_is_stable_and_only_one_process_can_use_it() {
        let dir = std::env::temp_dir().join(format!(
            "mere-headless-test-{}-{}",
            std::process::id(),
            epoch()
        ));
        initialize(&dir).unwrap();
        let guard = lock(&dir).unwrap();
        let id = device_id(&dir).unwrap();
        assert_eq!(device_id(&dir).unwrap(), id);
        assert!(lock(&dir).is_err());
        drop(guard);
        assert!(lock(&dir).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn shared_agent_authenticates_drains_and_stops_without_desktop_runtime() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/agent", listener.local_addr().unwrap());
        let dir =
            std::env::temp_dir().join(format!("mere-headless-protocol-{}", std::process::id()));
        initialize(&dir).unwrap();
        let auth = dir.join("auth.json");
        deviceauth::save(
            &auth,
            &deviceauth::TokenSet {
                access_token: "local-test-token".into(),
                refresh_token: None,
                token_type: None,
                expires_in: None,
                obtained_at_epoch_seconds: None,
            },
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let auth = socket.next().await.unwrap().unwrap();
            let auth: Value = serde_json::from_str(auth.to_text().unwrap()).unwrap();
            assert_eq!(auth["type"], "auth");
            assert_eq!(auth["device_id"], "headless-test-node");
            assert_eq!(auth["capacity"]["lease_protocol"], true);
            socket
                .send(Message::Text(
                    json!({"type":"auth_result", "success":true,
                "agent_id":"local-agent", "user_id":"local-user"})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            loop {
                let message = socket.next().await.unwrap().unwrap();
                if let Message::Text(text) = message {
                    let message: Value = serde_json::from_str(&text).unwrap();
                    if message["type"] == "availability_update"
                        && message["source"] == "node-control"
                    {
                        assert_eq!(message["status"], "busy");
                        break;
                    }
                }
            }
        });
        let gate = DeviceWorkGate::default();
        let events = DaemonEvents::default();
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(agent::run_agent(
            events.clone(),
            NodeConfig {
                relay_url: url,
                auth_path: auth,
                device_id: "headless-test-node".into(),
                device_name: "Protocol fixture".into(),
                models: vec![],
            },
            gate.clone(),
            receiver,
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events.state.lock().unwrap()["connected"] == true {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        gate.begin_drain();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(events.state.lock().unwrap()["running"], false);
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn rejected_session_stops_claiming_and_clears_the_private_token() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/agent", listener.local_addr().unwrap());
        let dir =
            std::env::temp_dir().join(format!("mere-headless-rejected-{}", std::process::id()));
        initialize(&dir).unwrap();
        let auth = dir.join("auth.json");
        deviceauth::save(
            &auth,
            &deviceauth::TokenSet {
                access_token: "revoked-fixture".into(),
                refresh_token: None,
                token_type: None,
                expires_in: None,
                obtained_at_epoch_seconds: None,
            },
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            tcp.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let events = DaemonEvents::default();
        let (_stop, receiver) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(3),
            agent::run_agent(
                events.clone(),
                NodeConfig {
                    relay_url: url,
                    auth_path: auth.clone(),
                    device_id: "rejected-headless-node".into(),
                    device_name: "Rejected fixture".into(),
                    models: vec![],
                },
                DeviceWorkGate::default(),
                receiver,
            ),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(!auth.exists());
        assert_eq!(events.state.lock().unwrap()["authRequired"], true);
        assert_eq!(events.state.lock().unwrap()["running"], false);
        fs::remove_dir_all(dir).unwrap();
    }
}
