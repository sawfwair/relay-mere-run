use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::mererun;
use crate::protocol::AgentMessage;
use crate::work_gate::{DeviceWorkGate, WorkPermit};

const HEADER_BYTES: usize = 44;
const MAX_AUDIO_FRAME_BYTES: usize = 6_400;
const AUDIO_QUEUE_FRAMES: usize = 50;
const MAX_AUDIO_QUEUE_BYTES: usize = 160 * 1024;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 8 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DURATION: Duration = Duration::from_secs(4 * 60 * 60);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
enum SessionControl {
    Running,
    Stop,
    Cancel,
    Abort { code: String, message: String },
}

struct ActiveSession {
    audio: mpsc::Sender<Vec<u8>>,
    control: watch::Sender<SessionControl>,
    next_frame_sequence: u32,
    last_audio_ms: Arc<AtomicU64>,
    queued_audio_bytes: Arc<AtomicUsize>,
}

#[derive(Clone)]
pub struct LiveAsrSessions {
    active: Arc<Mutex<HashMap<String, ActiveSession>>>,
    work_gate: DeviceWorkGate,
    outbound: mpsc::UnboundedSender<Message>,
}

impl LiveAsrSessions {
    pub fn new(work_gate: DeviceWorkGate, outbound: mpsc::UnboundedSender<Message>) -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            work_gate,
            outbound,
        }
    }

    pub async fn start(
        &self,
        session_id: String,
        protocol: u32,
        sample_rate: u32,
        input_format: String,
        language: Option<String>,
    ) {
        if !valid_session_id(&session_id)
            || protocol != 1
            || sample_rate != 16_000
            || input_format != "pcm-s16le"
        {
            self.send_error(
                &session_id,
                "unsupported_stream",
                "protocol v1 requires pcm-s16le at 16000 Hz",
            );
            return;
        }
        let permit = match self.work_gate.try_acquire("relay", &session_id) {
            Some(permit) => permit,
            None => {
                self.send_error(&session_id, "node_busy", "node inference slot is busy");
                return;
            }
        };
        {
            let active = self.active.lock().await;
            if active.contains_key(&session_id) || !active.is_empty() {
                drop(active);
                self.send_error(
                    &session_id,
                    "node_busy",
                    "node already has a live ASR session",
                );
                return;
            }
        }

        let binary = mererun::resolve_mere_run_binary().await;
        let mut command = Command::new(binary);
        command
            .arg("speech")
            .arg("transcribe")
            .arg("-")
            .arg("--stream")
            .arg("--input-format")
            .arg("pcm-s16le")
            .arg("--sample-rate")
            .arg("16000")
            .arg("--jsonl")
            .arg("--quiet")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(language) = language.filter(|value| !value.trim().is_empty()) {
            command.arg("--language").arg(language);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.send_error(
                    &session_id,
                    "subprocess_failed",
                    &format!("could not start mere.run: {error}"),
                );
                return;
            }
        };
        let Some(stdin) = child.stdin.take() else {
            self.send_error(
                &session_id,
                "subprocess_failed",
                "mere.run stdin was unavailable",
            );
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            self.send_error(
                &session_id,
                "subprocess_failed",
                "mere.run stdout was unavailable",
            );
            return;
        };
        let Some(stderr) = child.stderr.take() else {
            self.send_error(
                &session_id,
                "subprocess_failed",
                "mere.run stderr was unavailable",
            );
            return;
        };

        let (audio_tx, audio_rx) = mpsc::channel(AUDIO_QUEUE_FRAMES);
        let (control_tx, control_rx) = watch::channel(SessionControl::Running);
        let last_audio_ms = Arc::new(AtomicU64::new(now_ms()));
        let queued_audio_bytes = Arc::new(AtomicUsize::new(0));
        self.active.lock().await.insert(
            session_id.clone(),
            ActiveSession {
                audio: audio_tx,
                control: control_tx.clone(),
                next_frame_sequence: 0,
                last_audio_ms: last_audio_ms.clone(),
                queued_audio_bytes: queued_audio_bytes.clone(),
            },
        );

        let active = self.active.clone();
        let outbound = self.outbound.clone();
        tokio::spawn(async move {
            run_session(
                session_id.clone(),
                child,
                stdin,
                stdout,
                stderr,
                audio_rx,
                queued_audio_bytes,
                control_tx,
                control_rx,
                last_audio_ms,
                outbound,
                permit,
            )
            .await;
            active.lock().await.remove(&session_id);
        });
    }

    pub async fn feed_binary(&self, frame: &[u8]) {
        let parsed = match parse_audio_frame(frame) {
            Ok(value) => value,
            Err(_) => return,
        };
        let mut active = self.active.lock().await;
        let Some(session) = active.get_mut(&parsed.session_id) else {
            return;
        };
        let expected = session.next_frame_sequence.saturating_add(1);
        if parsed.sequence != expected {
            let _ = session.control.send(SessionControl::Abort {
                code: "frame_sequence_error".to_string(),
                message: format!(
                    "expected audio frame {expected}, received {}",
                    parsed.sequence
                ),
            });
            return;
        }
        let payload_bytes = parsed.payload.len();
        let queued_before = session
            .queued_audio_bytes
            .fetch_add(payload_bytes, Ordering::Relaxed);
        if queued_before.saturating_add(payload_bytes) > MAX_AUDIO_QUEUE_BYTES {
            session
                .queued_audio_bytes
                .fetch_sub(payload_bytes, Ordering::Relaxed);
            let _ = session.control.send(SessionControl::Abort {
                code: "backpressure_exceeded".to_string(),
                message: "node audio queue exceeded five seconds".to_string(),
            });
            return;
        }
        match session.audio.try_send(parsed.payload.to_vec()) {
            Ok(()) => {
                session.next_frame_sequence = parsed.sequence;
                session.last_audio_ms.store(now_ms(), Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                session
                    .queued_audio_bytes
                    .fetch_sub(payload_bytes, Ordering::Relaxed);
                let _ = session.control.send(SessionControl::Abort {
                    code: "backpressure_exceeded".to_string(),
                    message: "node audio queue exceeded five seconds".to_string(),
                });
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                session
                    .queued_audio_bytes
                    .fetch_sub(payload_bytes, Ordering::Relaxed);
            }
        }
    }

    pub async fn stop(&self, session_id: &str) {
        if let Some(session) = self.active.lock().await.get(session_id) {
            let _ = session.control.send(SessionControl::Stop);
        }
    }

    pub async fn cancel(&self, session_id: &str) {
        if let Some(session) = self.active.lock().await.get(session_id) {
            let _ = session.control.send(SessionControl::Cancel);
        }
    }

    pub async fn cancel_all(&self) {
        for session in self.active.lock().await.values() {
            let _ = session.control.send(SessionControl::Cancel);
        }
    }

    fn send_error(&self, session_id: &str, code: &str, message: &str) {
        send_event(
            &self.outbound,
            session_id,
            json!({ "protocol": 1, "type": "error", "code": code, "message": message }),
        );
    }
}

struct ParsedAudioFrame<'a> {
    session_id: String,
    sequence: u32,
    payload: &'a [u8],
}

fn parse_audio_frame(frame: &[u8]) -> Result<ParsedAudioFrame<'_>> {
    if frame.len() <= HEADER_BYTES || &frame[0..4] != b"ASR1" {
        return Err(anyhow!("invalid ASR1 frame"));
    }
    let session_id = std::str::from_utf8(&frame[4..40])?.to_string();
    if !valid_session_id(&session_id) {
        return Err(anyhow!("invalid ASR session id"));
    }
    let sequence = u32::from_be_bytes(frame[40..44].try_into()?);
    let payload = &frame[44..];
    if payload.is_empty()
        || payload.len() > MAX_AUDIO_FRAME_BYTES
        || !payload.len().is_multiple_of(2)
    {
        return Err(anyhow!("invalid PCM16 payload"));
    }
    Ok(ParsedAudioFrame {
        session_id,
        sequence,
        payload,
    })
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

async fn write_audio(
    mut stdin: tokio::process::ChildStdin,
    mut audio: mpsc::Receiver<Vec<u8>>,
    queued_audio_bytes: Arc<AtomicUsize>,
    mut control: watch::Receiver<SessionControl>,
) -> Result<()> {
    loop {
        tokio::select! {
            biased;
            changed = control.changed() => {
                if changed.is_err() { break; }
                let command = control.borrow().clone();
                match command {
                    SessionControl::Running => {}
                    SessionControl::Stop => {
                        audio.close();
                        while let Some(bytes) = audio.recv().await {
                            queued_audio_bytes.fetch_sub(bytes.len(), Ordering::Relaxed);
                            stdin.write_all(&bytes).await?;
                        }
                        stdin.shutdown().await?;
                        return Ok(());
                    }
                    SessionControl::Cancel | SessionControl::Abort { .. } => return Ok(()),
                }
            }
            bytes = audio.recv() => {
                match bytes {
                    Some(bytes) => {
                        queued_audio_bytes.fetch_sub(bytes.len(), Ordering::Relaxed);
                        stdin.write_all(&bytes).await?;
                    }
                    None => break,
                }
            }
        }
    }
    Ok(())
}

async fn read_stdout<R: AsyncRead + Unpin>(
    stdout: R,
    events: mpsc::UnboundedSender<Result<Value, String>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        match read_bounded_line(&mut reader, &mut line).await {
            Ok(false) => break,
            Ok(true) => {
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                let value = serde_json::from_slice::<Value>(&line)
                    .map_err(|_| "CLI emitted malformed JSONL".to_string())
                    .and_then(|value| {
                        if valid_cli_event(&value) {
                            Ok(value)
                        } else {
                            Err("CLI emitted an invalid protocol-v1 event".to_string())
                        }
                    });
                if events.send(value).is_err() {
                    break;
                }
            }
            Err(message) => {
                let _ = events.send(Err(message));
                break;
            }
        }
    }
}

async fn read_bounded_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    output: &mut Vec<u8>,
) -> Result<bool, String> {
    output.clear();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|error| format!("could not read CLI stdout: {error}"))?;
        if available.is_empty() {
            return Ok(!output.is_empty());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if output.len().saturating_add(count) > MAX_EVENT_BYTES {
            return Err("CLI JSONL event exceeded 64 KiB".to_string());
        }
        output.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

async fn retain_stderr<R: AsyncRead + Unpin>(mut stderr: R, retained: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0_u8; 1024];
    while let Ok(count) = stderr.read(&mut chunk).await {
        if count == 0 {
            break;
        }
        let mut output = retained.lock().await;
        output.extend_from_slice(&chunk[..count]);
        if output.len() > MAX_STDERR_BYTES {
            let remove = output.len() - MAX_STDERR_BYTES;
            output.drain(..remove);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    session_id: String,
    mut child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    audio: mpsc::Receiver<Vec<u8>>,
    queued_audio_bytes: Arc<AtomicUsize>,
    control_tx: watch::Sender<SessionControl>,
    mut control: watch::Receiver<SessionControl>,
    last_audio_ms: Arc<AtomicU64>,
    outbound: mpsc::UnboundedSender<Message>,
    _permit: WorkPermit,
) {
    let retained_stderr = Arc::new(Mutex::new(Vec::new()));
    let writer = tokio::spawn(write_audio(
        stdin,
        audio,
        queued_audio_bytes,
        control.clone(),
    ));
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let stdout_reader = tokio::spawn(read_stdout(stdout, event_tx));
    let stderr_reader = tokio::spawn(retain_stderr(stderr, retained_stderr.clone()));
    let started = tokio::time::Instant::now();
    let mut stop_deadline: Option<tokio::time::Instant> = None;
    let mut terminal = false;
    let mut ready = false;
    let mut ticker = tokio::time::interval(Duration::from_millis(100));

    loop {
        tokio::select! {
            changed = control.changed() => {
                if changed.is_err() { break; }
                let command = control.borrow().clone();
                match command {
                    SessionControl::Running => {}
                    SessionControl::Stop => {
                        if stop_deadline.is_none() {
                            stop_deadline = Some(tokio::time::Instant::now() + STOP_TIMEOUT);
                        }
                    }
                    SessionControl::Cancel => {
                        let _ = child.kill().await;
                        send_event(&outbound, &session_id, json!({ "protocol": 1, "type": "final", "reason": "cancelled" }));
                        terminal = true;
                        break;
                    }
                    SessionControl::Abort { code, message } => {
                        let _ = child.kill().await;
                        send_event(&outbound, &session_id, json!({ "protocol": 1, "type": "error", "code": code, "message": message }));
                        terminal = true;
                        break;
                    }
                }
            }
            event = event_rx.recv() => {
                match event {
                    Some(Ok(event)) => {
                        if terminal {
                            continue;
                        }
                        if event.get("type").and_then(Value::as_str) == Some("ready") {
                            ready = true;
                            last_audio_ms.store(now_ms(), Ordering::Relaxed);
                        }
                        let is_terminal = matches!(
                            event.get("type").and_then(Value::as_str),
                            Some("final" | "error")
                        );
                        send_event(&outbound, &session_id, event);
                        if is_terminal {
                            terminal = true;
                            stop_deadline = Some(tokio::time::Instant::now() + STOP_TIMEOUT);
                        }
                    }
                    Some(Err(message)) => {
                        let _ = child.kill().await;
                        send_event(&outbound, &session_id, json!({ "protocol": 1, "type": "error", "code": "invalid_cli_event", "message": message }));
                        terminal = true;
                        break;
                    }
                    None => {}
                }
            }
            _ = ticker.tick() => {
                if let Ok(Some(status)) = child.try_wait() {
                    if !terminal {
                        let diagnostic = String::from_utf8_lossy(&retained_stderr.lock().await).trim().to_string();
                        let message = if diagnostic.is_empty() {
                            format!("mere.run exited with {status}")
                        } else {
                            format!("mere.run exited with {status}: {diagnostic}")
                        };
                        send_event(&outbound, &session_id, json!({ "protocol": 1, "type": "error", "code": "subprocess_failed", "message": message }));
                    }
                    break;
                }
                if terminal {
                    if stop_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                        let _ = child.kill().await;
                        break;
                    }
                    continue;
                }
                if let Some(deadline) = stop_deadline {
                    if tokio::time::Instant::now() >= deadline {
                        let _ = child.kill().await;
                        send_event(&outbound, &session_id, json!({ "protocol": 1, "type": "error", "code": "stop_timeout", "message": "mere.run did not finish within 15 seconds" }));
                        terminal = true;
                        break;
                    }
                    continue;
                }
                let now = now_ms();
                if ready && now.saturating_sub(last_audio_ms.load(Ordering::Relaxed)) >= IDLE_TIMEOUT.as_millis() as u64 {
                    let _ = control_tx.send(SessionControl::Abort {
                        code: "idle_timeout".to_string(),
                        message: "no audio received for 30 seconds".to_string(),
                    });
                } else if started.elapsed() >= MAX_DURATION && stop_deadline.is_none() {
                    let _ = control_tx.send(SessionControl::Stop);
                    stop_deadline = Some(tokio::time::Instant::now() + STOP_TIMEOUT);
                }
            }
        }
    }

    if !terminal {
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
    writer.abort();
    stdout_reader.abort();
    stderr_reader.abort();
}

fn send_event(outbound: &mpsc::UnboundedSender<Message>, session_id: &str, event: Value) {
    let message = AgentMessage::AsrStreamEvent {
        session_id: session_id.to_string(),
        event,
    };
    if let Ok(text) = serde_json::to_string(&message) {
        let _ = outbound.send(Message::Text(text.into()));
    }
}

fn valid_cli_event(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.get("protocol").and_then(Value::as_u64) != Some(1) {
        return false;
    }
    match object.get("type").and_then(Value::as_str) {
        Some("ready") => {
            object.get("sampleRate").and_then(Value::as_u64) == Some(16_000)
                && object.get("inputFormat").and_then(Value::as_str) == Some("pcm-s16le")
        }
        Some("partial" | "commit") => {
            object.get("utteranceId").and_then(Value::as_str).is_some()
                && object.get("revision").and_then(Value::as_u64).is_some()
                && object.get("text").and_then(Value::as_str).is_some()
                && object.get("startMs").and_then(Value::as_u64).is_some()
                && object.get("endMs").and_then(Value::as_u64).is_some()
        }
        Some("stats") => {
            object
                .get("decodeLatencyMs")
                .and_then(Value::as_f64)
                .is_some()
                && object.get("audioMs").and_then(Value::as_u64).is_some()
                && object
                    .get("queuedAudioMs")
                    .and_then(Value::as_u64)
                    .is_some()
        }
        Some("final") => object.get("reason").and_then(Value::as_str).is_some(),
        Some("error") => {
            object.get("code").and_then(Value::as_str).is_some()
                && object.get("message").and_then(Value::as_str).is_some()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_binary_header_and_network_sequence() {
        let session = "123e4567-e89b-12d3-a456-426614174000";
        let mut frame = Vec::from(&b"ASR1"[..]);
        frame.extend_from_slice(session.as_bytes());
        frame.extend_from_slice(&9_u32.to_be_bytes());
        frame.extend_from_slice(&[0x34, 0x12]);
        let parsed = parse_audio_frame(&frame).expect("valid frame");
        assert_eq!(parsed.session_id, session);
        assert_eq!(parsed.sequence, 9);
        assert_eq!(parsed.payload, &[0x34, 0x12]);
    }

    #[test]
    fn rejects_bad_audio_frames_and_cli_events() {
        assert!(parse_audio_frame(b"ASR1").is_err());
        assert!(!valid_cli_event(
            &json!({ "protocol": 2, "type": "final", "reason": "eof" })
        ));
        assert!(valid_cli_event(&json!({
            "protocol": 1,
            "type": "commit",
            "utteranceId": "id",
            "revision": 2,
            "text": "hello",
            "startMs": 0,
            "endMs": 1_000
        })));
    }

    #[tokio::test]
    async fn bounds_cli_jsonl_before_a_newline_arrives() {
        let oversized = vec![b'x'; MAX_EVENT_BYTES + 1];
        let mut reader = BufReader::new(oversized.as_slice());
        let mut line = Vec::new();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line).await,
            Err("CLI JSONL event exceeded 64 KiB".to_string())
        );
        assert!(line.len() <= MAX_EVENT_BYTES);
    }
}
