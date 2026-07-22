//! Driver that wraps the local `mere.run` binary as the generation engine.
//!
//! Flags mirror the public mere.run CLI: `mere.run image generate --prompt ..
//! --model .. --output ..
//! --width .. --height .. --seed .. [--ref-image ..]`.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::protocol::{
    AsrOutput, AsrRequest, AsrStreamingCapabilities, ChatMessage, ChatRequest, EmbedDataRow,
    EmbedOutput, EmbedRequest, JobKind, JobRequest, ModelInventoryStatus, RuntimeDiagnostic,
};

const DEFAULT_MODEL: &str = "image-klein-9b";
const DEFAULT_EMBED_MODEL: &str = "text-embed-qwen3-0.6b";
const IMAGE_CAPABILITY: &str = "image";
const TEXT_CAPABILITY: &str = "text";
const MUSIC_CAPABILITY: &str = "music";
const VIDEO_CAPABILITY: &str = "video";
const ASR_CAPABILITY: &str = "asr";
const EMBED_CAPABILITY: &str = "embed";
const ADVERTISABLE_MODEL_CATEGORIES: &[&str] = &["image", "text-chat", "music", "video"];
const ADVERTISABLE_MODEL_PREFIXES: &[&str] = &["image-", "text-chat-", "music-", "video-"];
const MAX_ASR_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

fn push_unique(models: &mut Vec<String>, model: impl Into<String>) {
    let model = model.into();
    if !model.trim().is_empty() && !models.iter().any(|m| m == &model) {
        models.push(model);
    }
}

async fn command_supports(args: &[&str]) -> bool {
    match mere_run_output(args).await {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

fn configured_mere_run_binary() -> Option<PathBuf> {
    let value = std::env::var("MERERUN_BIN").ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn common_mere_run_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/usr/local/bin/mere.run"),
        PathBuf::from("/opt/homebrew/bin/mere.run"),
    ];

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".local/bin/mere.run"));
        paths.push(home.join("bin/mere.run"));
    }

    paths
}

pub(crate) async fn resolve_mere_run_binary() -> PathBuf {
    if let Some(configured) = configured_mere_run_binary() {
        return configured;
    }

    for path in common_mere_run_paths() {
        if path.is_file() {
            return path;
        }
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let lookup_commands = [
        ("/usr/bin/which", vec!["mere.run"]),
        (shell.as_str(), vec!["-lc", "command -v mere.run"]),
    ];
    for (program, args) in lookup_commands {
        if let Ok(out) = Command::new(program).args(args).output().await {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return PathBuf::from(path);
                }
            }
        }
    }

    PathBuf::from("mere.run")
}

pub(crate) async fn mere_run_output(args: &[&str]) -> std::io::Result<Output> {
    let binary = resolve_mere_run_binary().await;
    Command::new(binary).args(args).output().await
}

pub struct RuntimeInventory {
    pub mere_run_version: Option<String>,
    pub installed_models: Vec<String>,
    pub inventory_status: ModelInventoryStatus,
    pub diagnostic: Option<RuntimeDiagnostic>,
}

enum InventoryProbeFailure {
    Unavailable,
    Failed,
}

async fn probe_version() -> (Option<String>, Option<RuntimeDiagnostic>) {
    let output = match mere_run_output(&["--version"]).await {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (None, Some(RuntimeDiagnostic::MereRunNotFound));
        }
        Err(_) => return (None, Some(RuntimeDiagnostic::VersionCommandUnavailable)),
    };
    if !output.status.success() {
        return (None, Some(RuntimeDiagnostic::VersionCommandFailed));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        (None, Some(RuntimeDiagnostic::VersionOutputEmpty))
    } else {
        (Some(version), None)
    }
}

#[derive(serde::Deserialize)]
struct MereRunStatus {
    #[serde(rename = "installedModels")]
    installed_models: Vec<InstalledModel>,
    #[serde(default)]
    capabilities: Option<MereRunStatusCapabilities>,
}

#[derive(serde::Deserialize)]
struct MereRunStatusCapabilities {
    #[serde(default, rename = "asrStreamingProtocols")]
    asr_streaming_protocols: Vec<u32>,
    #[serde(default, rename = "asrStreamingInputFormats")]
    asr_streaming_input_formats: Vec<String>,
}

#[derive(Clone, serde::Deserialize)]
struct InstalledModel {
    id: String,
    category: Option<String>,
}

fn push_unique_model(models: &mut Vec<InstalledModel>, model: InstalledModel) {
    if !model.id.trim().is_empty() && !models.iter().any(|m| m.id == model.id) {
        models.push(model);
    }
}

fn is_advertisable_model_id(id: &str) -> bool {
    ADVERTISABLE_MODEL_PREFIXES
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

fn is_advertisable_model(model: &InstalledModel) -> bool {
    match model.category.as_deref() {
        Some(category) => ADVERTISABLE_MODEL_CATEGORIES.contains(&category),
        None => is_advertisable_model_id(&model.id),
    }
}

fn configured_capability_models(configured: &[String]) -> Vec<String> {
    let mut models = Vec::new();
    for model in configured {
        let trimmed = model.trim();
        if is_advertisable_model_id(trimmed) {
            push_unique(&mut models, trimmed.to_string());
        }
    }
    models
}

fn installed_model_ids(inventory: &[InstalledModel]) -> Vec<String> {
    let mut ids = Vec::new();
    for model in inventory {
        push_unique(&mut ids, model.id.clone());
    }
    ids
}

fn installed_capability_model_ids(inventory: &[InstalledModel]) -> Vec<String> {
    let mut ids = Vec::new();
    for model in inventory
        .iter()
        .filter(|model| is_advertisable_model(model))
    {
        push_unique(&mut ids, model.id.clone());
    }
    ids
}

fn decode_status_inventory(stdout: &str) -> Option<Vec<InstalledModel>> {
    serde_json::from_str::<MereRunStatus>(stdout)
        .ok()
        .map(|status| status.installed_models)
}

fn parse_status_inventory(stdout: &str) -> Vec<InstalledModel> {
    decode_status_inventory(stdout).unwrap_or_default()
}

fn parse_status_capability_models(stdout: &str) -> Vec<String> {
    installed_capability_model_ids(&parse_status_inventory(stdout))
}

fn parse_asr_streaming_capabilities(stdout: &str) -> Option<AsrStreamingCapabilities> {
    let status = serde_json::from_str::<MereRunStatus>(stdout).ok()?;
    let capabilities = status.capabilities?;
    if !capabilities.asr_streaming_protocols.contains(&1)
        || !capabilities
            .asr_streaming_input_formats
            .iter()
            .any(|value| value == "pcm-s16le/16000/mono")
    {
        return None;
    }
    Some(AsrStreamingCapabilities {
        protocols: vec![1],
        input_formats: vec!["pcm-s16le/16000/mono".to_string()],
        max_sessions: 1,
    })
}

pub async fn asr_streaming_capabilities() -> Option<AsrStreamingCapabilities> {
    let output = mere_run_output(&["status", "--json"]).await.ok()?;
    if !output.status.success() {
        return None;
    }
    parse_asr_streaming_capabilities(&String::from_utf8_lossy(&output.stdout))
}

fn parse_model_list_inventory(stdout: &str) -> Vec<InstalledModel> {
    let mut inventory = Vec::new();

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.starts_with('-') && !line.starts_with("---") {
            if let Some(model) = line.trim_start_matches('-').split_whitespace().next() {
                push_unique_model(
                    &mut inventory,
                    InstalledModel {
                        id: model.to_string(),
                        category: None,
                    },
                );
            }
            continue;
        }

        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() >= 3 && parts[2] == "installed" {
            push_unique_model(
                &mut inventory,
                InstalledModel {
                    id: parts[0].to_string(),
                    category: Some(parts[1].to_string()),
                },
            );
        }
    }

    inventory
}

fn parse_model_list_capability_models(stdout: &str) -> Vec<String> {
    installed_capability_model_ids(&parse_model_list_inventory(stdout))
}

fn model_list_inventory(stdout: &str) -> Option<Vec<InstalledModel>> {
    let inventory = parse_model_list_inventory(stdout);
    let recognized = !inventory.is_empty()
        || stdout.lines().any(|line| {
            let line = line.trim();
            line.starts_with("ID") && line.contains("Category") && line.contains("Status")
        });
    recognized.then_some(inventory)
}

async fn probe_installed_models() -> Result<Vec<String>, InventoryProbeFailure> {
    let mut binary_was_available = false;

    match mere_run_output(&["status", "--json"]).await {
        Ok(output) => {
            binary_was_available = true;
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(inventory) = decode_status_inventory(&stdout) {
                    return Ok(installed_model_ids(&inventory));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => binary_was_available = true,
    }

    match mere_run_output(&["model", "list"]).await {
        Ok(output) => {
            binary_was_available = true;
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(inventory) = model_list_inventory(&stdout) {
                    return Ok(installed_model_ids(&inventory));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => binary_was_available = true,
    }

    Err(if binary_was_available {
        InventoryProbeFailure::Failed
    } else {
        InventoryProbeFailure::Unavailable
    })
}

pub async fn runtime_inventory() -> RuntimeInventory {
    let (mere_run_version, version_diagnostic) = probe_version().await;
    match probe_installed_models().await {
        Ok(installed_models) => RuntimeInventory {
            inventory_status: if installed_models.is_empty() {
                ModelInventoryStatus::Empty
            } else {
                ModelInventoryStatus::Reported
            },
            mere_run_version,
            installed_models,
            diagnostic: version_diagnostic,
        },
        Err(InventoryProbeFailure::Unavailable) => RuntimeInventory {
            mere_run_version,
            installed_models: Vec::new(),
            inventory_status: ModelInventoryStatus::Unavailable,
            diagnostic: Some(version_diagnostic.unwrap_or(RuntimeDiagnostic::MereRunNotFound)),
        },
        Err(InventoryProbeFailure::Failed) => RuntimeInventory {
            mere_run_version,
            installed_models: Vec::new(),
            inventory_status: ModelInventoryStatus::Failed,
            diagnostic: Some(RuntimeDiagnostic::InventoryCommandsFailed),
        },
    }
}

async fn installed_capability_models() -> Vec<String> {
    if let Ok(out) = mere_run_output(&["status", "--json"]).await {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let models = parse_status_capability_models(&text);
            if !models.is_empty() {
                return models;
            }
        }
    }

    if let Ok(out) = mere_run_output(&["model", "list"]).await {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let models = parse_model_list_capability_models(&text);
            if !models.is_empty() {
                return models;
            }
        }
    }

    Vec::new()
}

/// Best-effort discovery of relay-advertisable capabilities.
pub async fn list_models() -> Vec<String> {
    capability_models_from(installed_capability_models().await).await
}

/// Best-effort inventory for the node's local status surface. Relay inventory
/// uses `runtime_inventory()` so it can distinguish empty from failed scans.
pub async fn installed_models() -> Vec<String> {
    probe_installed_models().await.unwrap_or_default()
}

/// Merge configured model names with modality capability markers. The relay's
/// scheduler keys on `asr` and `embed`; concrete model names are still reported.
pub async fn capability_models(configured: &[String]) -> Vec<String> {
    let configured_models = configured_capability_models(configured);
    let base = if configured_models.is_empty() {
        installed_capability_models().await
    } else {
        configured_models
    };
    capability_models_from(base).await
}

async fn capability_models_from(base: Vec<String>) -> Vec<String> {
    let mut models = Vec::new();
    for model in base {
        push_unique(&mut models, model);
    }

    if command_supports(&["image", "generate", "--help"]).await {
        push_unique(&mut models, IMAGE_CAPABILITY);
    }

    if command_supports(&["text", "chat", "--help"]).await {
        push_unique(&mut models, TEXT_CAPABILITY);
    }

    if command_supports(&["music", "generate", "--help"]).await {
        push_unique(&mut models, MUSIC_CAPABILITY);
    }

    if command_supports(&["video", "generate", "--help"]).await {
        push_unique(&mut models, VIDEO_CAPABILITY);
    }

    if command_supports(&["speech", "transcribe", "--help"]).await {
        push_unique(&mut models, ASR_CAPABILITY);
    }

    if command_supports(&["text", "embed", "--help"]).await {
        push_unique(&mut models, EMBED_CAPABILITY);
        push_unique(&mut models, DEFAULT_EMBED_MODEL);
    }
    models
}

pub struct GeneratedOutput {
    pub path: PathBuf,
    pub content_type: &'static str,
    pub kind: &'static str,
}

/// A per-step generation progress update, in relay terms: `step` counts 1..=N
/// while denoising runs (never regressing), `total_steps` is the real step
/// count reported by the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobProgressUpdate {
    pub step: u32,
    pub total_steps: u32,
}

pub type ProgressSender = mpsc::UnboundedSender<JobProgressUpdate>;

/// Parse one stderr line from `mere.run image generate` into a denoising
/// progress update. Supports both the machine-readable `--progress-json`
/// stream (NDJSON, raw 0-based step index) and the human-readable
/// `Generating (N/M)` text older CLIs print (1-based, already clamped).
fn denoising_update_for_line(line: &str) -> Option<JobProgressUpdate> {
    if let Some((stage, step, total)) = parse_progress_json_event(line) {
        if stage != "denoising" || total == 0 {
            return None;
        }
        return Some(JobProgressUpdate {
            step: step.saturating_add(1).min(total),
            total_steps: total,
        });
    }

    let (step, total) = parse_human_generating_line(line)?;
    if total == 0 {
        return None;
    }
    Some(JobProgressUpdate {
        step: step.min(total),
        total_steps: total,
    })
}

fn parse_progress_json_event(line: &str) -> Option<(String, u32, u32)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }

    #[derive(serde::Deserialize)]
    struct ProgressEvent {
        event: Option<String>,
        stage: Option<String>,
        step: Option<u32>,
        total_steps: Option<u32>,
    }

    let parsed: ProgressEvent = serde_json::from_str(trimmed).ok()?;
    if parsed.event.as_deref().unwrap_or("progress") != "progress" {
        return None;
    }
    Some((parsed.stage?, parsed.step?, parsed.total_steps?))
}

fn parse_human_generating_line(line: &str) -> Option<(u32, u32)> {
    let rest = line.trim().strip_prefix("Generating (")?;
    let (step_text, rest) = rest.split_once('/')?;
    let total_text = rest.strip_suffix(')')?;
    let step = step_text.trim().parse().ok()?;
    let total = total_text.trim().parse().ok()?;
    Some((step, total))
}

/// Incremental stderr scanner: buffers bytes, splits on `\n`/`\r` (the human
/// progress format is `\r`-separated), and emits deduplicated denoising
/// updates as complete lines arrive.
struct ProgressLineScanner {
    pending: Vec<u8>,
    last: Option<JobProgressUpdate>,
}

impl ProgressLineScanner {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            last: None,
        }
    }

    fn push_chunk(&mut self, chunk: &[u8], mut emit: impl FnMut(JobProgressUpdate)) {
        self.pending.extend_from_slice(chunk);
        while let Some(pos) = self
            .pending
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            if let Some(update) = denoising_update_for_line(&line) {
                if self.last != Some(update) {
                    self.last = Some(update);
                    emit(update);
                }
            }
        }
    }
}

/// Whether the installed CLI supports `--progress-json`. Checked per job (the
/// binary can be upgraded or downgraded under a long-lived node); when absent
/// we still stream progress by parsing the human-readable stderr text.
async fn image_progress_json_supported() -> bool {
    match mere_run_output(&["image", "generate", "--help"]).await {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).contains("--progress-json")
        }
        _ => false,
    }
}

/// Cap the retained stderr tail used for error reporting.
const STDERR_TAIL_LIMIT: usize = 16 * 1024;

fn push_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    tail.extend_from_slice(chunk);
    if tail.len() > STDERR_TAIL_LIMIT {
        let excess = tail.len() - STDERR_TAIL_LIMIT;
        tail.drain(..excess);
    }
}

/// Run a prepared `mere.run` command, streaming stderr for per-step progress
/// while retaining a bounded tail for error reporting.
async fn run_streaming_with_progress(
    mut cmd: Command,
    progress: Option<&ProgressSender>,
) -> Result<std::process::ExitStatus> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("child stdout unavailable"))?;
    let stdout_drain = tokio::spawn(async move {
        let mut sink = Vec::new();
        let _ = stdout.read_to_end(&mut sink).await;
    });

    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("child stderr unavailable"))?;
    let mut scanner = ProgressLineScanner::new();
    let mut tail: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stderr.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        push_tail(&mut tail, &chunk[..read]);
        scanner.push_chunk(&chunk[..read], |update| {
            if let Some(sender) = progress {
                let _ = sender.send(update);
            }
        });
    }

    let status = child.wait().await?;
    let _ = stdout_drain.await;
    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&tail);
        return Err(anyhow!(
            "mere.run image generate failed: {}",
            stderr_text.trim()
        ));
    }
    Ok(status)
}

pub async fn generate_job_output(
    req: &JobRequest,
    out_dir: &Path,
    job_id: &str,
    progress: Option<ProgressSender>,
) -> Result<GeneratedOutput> {
    match req.kind {
        JobKind::Image => Ok(GeneratedOutput {
            path: generate_image(req, out_dir, job_id, progress).await?,
            content_type: "image/png",
            kind: "image",
        }),
        JobKind::Music => Ok(GeneratedOutput {
            path: generate_music(req, out_dir, job_id).await?,
            content_type: "audio/wav",
            kind: "music",
        }),
        JobKind::Video => Ok(GeneratedOutput {
            path: generate_video(req, out_dir, job_id).await?,
            content_type: "video/mp4",
            kind: "video",
        }),
    }
}

/// Generate an image for `req` into `out_dir`, returning the produced PNG path.
/// Per-step denoising progress is streamed to `progress` as it happens.
pub async fn generate_image(
    req: &JobRequest,
    out_dir: &Path,
    job_id: &str,
    progress: Option<ProgressSender>,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(out_dir).await.ok();
    let out_path = out_dir.join(format!("{job_id}.png"));
    let model = req
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let binary = resolve_mere_run_binary().await;
    let mut cmd = Command::new(binary);
    cmd.arg("image")
        .arg("generate")
        .arg("--prompt")
        .arg(&req.prompt)
        .arg("--model")
        .arg(&model)
        .arg("--output")
        .arg(&out_path)
        .arg("--width")
        .arg(req.width.to_string())
        .arg("--height")
        .arg(req.height.to_string());
    if image_progress_json_supported().await {
        cmd.arg("--progress-json");
    }
    if let Some(neg) = req.negative_prompt.as_deref() {
        if !neg.is_empty() {
            cmd.arg("--negative-prompt").arg(neg);
        }
    }
    if req.steps > 0 {
        cmd.arg("--steps").arg(req.steps.to_string());
    }
    if let Some(seed) = req.seed {
        cmd.arg("--seed").arg(seed.to_string());
    }

    // image-to-image: bring the input image local and pass it via --input/--strength.
    let input_path = if let Some(url) = req.input_image_url.as_deref() {
        let p = out_dir.join(format!("{job_id}-input.png"));
        download_to(url, &p).await?;
        Some(p)
    } else if let Some(b64) = req.input_image_data.as_deref() {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| anyhow!("bad input_image_data: {e}"))?;
        let p = out_dir.join(format!("{job_id}-input.jpg"));
        tokio::fs::write(&p, bytes).await?;
        Some(p)
    } else {
        None
    };
    if let Some(p) = input_path.as_ref() {
        cmd.arg("--input").arg(p);
        if let Some(strength) = req.input_strength {
            cmd.arg("--strength").arg(strength.to_string());
        }
    }

    // Identity-locking reference images (character refs) -> repeated --ref-image.
    if let Some(urls) = req.reference_image_urls.as_ref() {
        for (i, url) in urls.iter().enumerate() {
            if url.is_empty() {
                continue;
            }
            let p = out_dir.join(format!("{job_id}-ref-{i}.png"));
            download_to(url, &p).await?;
            cmd.arg("--ref-image").arg(p);
        }
    }

    run_streaming_with_progress(cmd, progress.as_ref()).await?;
    if !out_path.exists() {
        return Err(anyhow!(
            "mere.run reported success but produced no file at {out_path:?}"
        ));
    }
    Ok(out_path)
}

pub async fn generate_music(req: &JobRequest, out_dir: &Path, job_id: &str) -> Result<PathBuf> {
    tokio::fs::create_dir_all(out_dir).await.ok();
    let out_path = out_dir.join(format!("{job_id}.wav"));
    let model = req
        .model
        .clone()
        .unwrap_or_else(|| "music-acestep".to_string());

    let mut cmd = Command::new(resolve_mere_run_binary().await);
    cmd.arg("music")
        .arg("generate")
        .arg(&req.prompt)
        .arg("--model")
        .arg(&model)
        .arg("--output")
        .arg(&out_path)
        .arg("--quiet");

    if let Some(duration) = req.duration_seconds {
        cmd.arg("--duration").arg(duration.to_string());
    }
    if req.steps > 0 {
        cmd.arg("--steps").arg(req.steps.to_string());
    }
    if let Some(seed) = req.seed {
        cmd.arg("--seed").arg(seed.to_string());
    }
    if let Some(lyrics) = req.lyrics.as_deref() {
        if !lyrics.trim().is_empty() {
            cmd.arg("--lyrics").arg(lyrics);
        }
    }

    let output = cmd.output().await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("mere.run music generate failed: {}", stderr.trim()));
    }
    if !out_path.exists() {
        return Err(anyhow!(
            "mere.run reported success but produced no file at {out_path:?}"
        ));
    }
    Ok(out_path)
}

pub async fn generate_video(req: &JobRequest, out_dir: &Path, job_id: &str) -> Result<PathBuf> {
    tokio::fs::create_dir_all(out_dir).await.ok();
    let out_path = out_dir.join(format!("{job_id}.mp4"));
    let model = req
        .model
        .clone()
        .unwrap_or_else(|| "video-ltx23-av-mlx".to_string());

    let mut cmd = Command::new(resolve_mere_run_binary().await);
    cmd.arg("video")
        .arg("generate")
        .arg(&req.prompt)
        .arg("--model")
        .arg(&model)
        .arg("--output")
        .arg(&out_path)
        .arg("--width")
        .arg(req.width.to_string())
        .arg("--height")
        .arg(req.height.to_string())
        .arg("--quiet");

    if let Some(duration) = req.duration_seconds {
        cmd.arg("--duration").arg(duration.to_string());
    }
    if let Some(fps) = req.fps {
        cmd.arg("--fps").arg(fps.to_string());
    }
    if let Some(num_frames) = req.num_frames {
        cmd.arg("--num-frames").arg(num_frames.to_string());
    }
    if let Some(seed) = req.seed {
        cmd.arg("--seed").arg(seed.to_string());
    }

    let input_path = if let Some(url) = req.input_image_url.as_deref() {
        let p = out_dir.join(format!("{job_id}-video-input.png"));
        download_to(url, &p).await?;
        Some(p)
    } else if let Some(b64) = req.input_image_data.as_deref() {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| anyhow!("bad input_image_data: {e}"))?;
        let p = out_dir.join(format!("{job_id}-video-input.jpg"));
        tokio::fs::write(&p, bytes).await?;
        Some(p)
    } else {
        None
    };
    if let Some(p) = input_path.as_ref() {
        cmd.arg("--image").arg(p);
        if let Some(strength) = req.input_strength {
            cmd.arg("--image-strength").arg(strength.to_string());
        }
    }

    let output = cmd.output().await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("mere.run video generate failed: {}", stderr.trim()));
    }
    if !out_path.exists() {
        return Err(anyhow!(
            "mere.run reported success but produced no file at {out_path:?}"
        ));
    }
    Ok(out_path)
}

/// Download the ASR input to a per-job temp file and invoke `mere.run speech transcribe`.
pub async fn transcribe_speech(
    req: &AsrRequest,
    out_dir: &Path,
    asr_id: &str,
) -> Result<AsrOutput> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let job_dir = out_dir.join(format!("{asr_id}-{unique:x}"));
    tokio::fs::create_dir_all(&job_dir).await?;
    let result = async {
        let audio_path = download_asr_input(&req.audio_url, &job_dir).await?;
        let args = build_transcribe_args(&audio_path, req);
        let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let output = mere_run_output(&arg_refs).await?;
        if !output.status.success() {
            return Err(anyhow!(
                "downloaded_payload_invalid_audio: verified audio container could not be decoded"
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        parse_transcript_output(&stdout, req)
    }
    .await;
    let keep_failed = std::env::var("MERERUN_NODE_KEEP_FAILED_ASR")
        .ok()
        .is_some_and(|value| value == "1");
    if result.is_ok() || !keep_failed {
        let _ = tokio::fs::remove_dir_all(&job_dir).await;
    }
    result
}

/// Invoke `mere.run text embed` and normalize vector output into relay rows.
pub async fn embed_texts(req: &EmbedRequest) -> Result<EmbedOutput> {
    let args = build_embed_args(req);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = mere_run_output(&arg_refs).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("mere.run text embed failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_embed_output(&stdout, &req.model)
}

pub async fn chat_text(req: &ChatRequest) -> Result<String> {
    let args = build_chat_args(req)?;
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = mere_run_output(&arg_refs).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("mere.run text chat failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err(anyhow!("mere.run text chat returned an empty response"));
    }
    Ok(stdout)
}

fn build_chat_args(req: &ChatRequest) -> Result<Vec<String>> {
    let _use_lora_requested = req.use_lora.unwrap_or(false);
    let (system, prompt) = render_chat_prompt(&req.messages, req.requires_json.unwrap_or(false))?;
    let mut args = vec![
        "text".to_string(),
        "chat".to_string(),
        "--prompt".to_string(),
        prompt,
        "--quiet".to_string(),
    ];

    if let Some(system) = system {
        args.push("--system".to_string());
        args.push(system);
    }
    if let Some(model) = req.model.as_deref() {
        if !model.trim().is_empty() {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    if let Some(max_tokens) = req.max_tokens {
        if max_tokens > 0 {
            args.push("--max-tokens".to_string());
            args.push(max_tokens.to_string());
        }
    }
    if let Some(temperature) = req.temperature {
        args.push("--temperature".to_string());
        args.push(temperature.to_string());
    }

    Ok(args)
}

fn render_chat_prompt(
    messages: &[ChatMessage],
    requires_json: bool,
) -> Result<(Option<String>, String)> {
    if messages.is_empty() {
        return Err(anyhow!("chat request must include at least one message"));
    }

    let mut system_parts = Vec::new();
    let mut turns = Vec::new();
    for message in messages {
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        let content = if let Some(image_url) = message.image_url.as_deref() {
            if image_url.trim().is_empty() {
                content.to_string()
            } else {
                format!("{content}\nImage: {}", image_url.trim())
            }
        } else {
            content.to_string()
        };
        match message.role.as_str() {
            "system" => system_parts.push(content),
            "assistant" => turns.push(format!("Assistant: {content}")),
            "user" => turns.push(format!("User: {content}")),
            other => turns.push(format!("{other}: {content}")),
        }
    }

    if requires_json {
        system_parts.push("Respond with valid JSON only.".to_string());
    }

    let prompt = turns.join("\n\n");
    if prompt.trim().is_empty() {
        return Err(anyhow!(
            "chat request must include a non-empty user or assistant message"
        ));
    }

    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    Ok((system, prompt))
}

fn build_transcribe_args(audio_path: &Path, req: &AsrRequest) -> Vec<String> {
    let mut args = vec![
        "speech".to_string(),
        "transcribe".to_string(),
        audio_path.to_string_lossy().to_string(),
        "--backend".to_string(),
        "auto".to_string(),
        "--task".to_string(),
        req.task.clone(),
        "--quiet".to_string(),
    ];
    if let Some(language) = req.language.as_deref() {
        if !language.trim().is_empty() {
            args.push("--language".to_string());
            args.push(language.to_string());
        }
    }
    if req.max_tokens > 0 {
        args.push("--max-tokens".to_string());
        args.push(req.max_tokens.to_string());
    }
    args
}

fn build_embed_args(req: &EmbedRequest) -> Vec<String> {
    let mut args = vec![
        "text".to_string(),
        "embed".to_string(),
        "--model".to_string(),
        req.model.clone(),
    ];
    if req.max_tokens > 0 {
        args.push("--max-tokens".to_string());
        args.push(req.max_tokens.to_string());
    }
    args.push("--".to_string());
    args.extend(req.texts.iter().cloned());
    args
}

fn parse_transcript_output(stdout: &str, req: &AsrRequest) -> Result<AsrOutput> {
    if stdout.is_empty() {
        return Err(anyhow!("mere.run speech transcribe returned no transcript"));
    }

    if let Ok(parsed) = serde_json::from_str::<AsrOutput>(stdout) {
        if !parsed.text.trim().is_empty() {
            return Ok(parsed);
        }
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) {
        if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
            return Ok(AsrOutput {
                text: text.to_string(),
                language: value
                    .get("language")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| req.language.clone()),
                duration_seconds: value.get("duration_seconds").and_then(|v| v.as_f64()),
                token_alignments: None,
                sentence_alignments: None,
            });
        }
    }

    Ok(AsrOutput {
        text: stdout.to_string(),
        language: req.language.clone(),
        duration_seconds: None,
        token_alignments: None,
        sentence_alignments: None,
    })
}

fn parse_embed_output(stdout: &str, fallback_model: &str) -> Result<EmbedOutput> {
    if stdout.is_empty() {
        return Err(anyhow!("mere.run text embed returned no vectors"));
    }

    if let Ok(mut parsed) = serde_json::from_str::<EmbedOutput>(stdout) {
        if parsed.dimensions.is_none() {
            parsed.dimensions = parsed.data.first().map(|row| row.embedding.len());
        }
        if parsed.model.is_none() {
            parsed.model = Some(fallback_model.to_string());
        }
        validate_embed_output(&parsed)?;
        return Ok(parsed);
    }

    let value: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|e| anyhow!("could not parse embed JSON output: {e}"))?;
    let data_value = value.get("data").unwrap_or(&value);
    let rows = data_value
        .as_array()
        .ok_or_else(|| anyhow!("embed output must be an array or object with data[]"))?;

    let mut data = Vec::with_capacity(rows.len());
    for (position, row) in rows.iter().enumerate() {
        if let Some(vector) = row.as_array() {
            data.push(EmbedDataRow {
                index: position,
                embedding: parse_number_array(vector)?,
            });
            continue;
        }

        let index = row
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(position);
        let embedding_value = row
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("embed row {position} has no embedding[]"))?;
        data.push(EmbedDataRow {
            index,
            embedding: parse_number_array(embedding_value)?,
        });
    }

    let mut output = EmbedOutput {
        model: value
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| Some(fallback_model.to_string())),
        dimensions: value
            .get("dimensions")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .or_else(|| data.first().map(|row| row.embedding.len())),
        data,
    };
    validate_embed_output(&output)?;
    if output.model.is_none() {
        output.model = Some(fallback_model.to_string());
    }
    Ok(output)
}

fn parse_number_array(values: &[serde_json::Value]) -> Result<Vec<f64>> {
    values
        .iter()
        .map(|value| {
            value
                .as_f64()
                .ok_or_else(|| anyhow!("embedding contains a non-number value"))
        })
        .collect()
}

fn validate_embed_output(output: &EmbedOutput) -> Result<()> {
    if output.data.is_empty() {
        return Err(anyhow!("embed output contained no data rows"));
    }
    let dimensions = output
        .dimensions
        .unwrap_or_else(|| output.data[0].embedding.len());
    if dimensions == 0 {
        return Err(anyhow!("embed output vectors are empty"));
    }
    for row in &output.data {
        if row.embedding.len() != dimensions {
            return Err(anyhow!(
                "embed row {} has {} dimensions, expected {dimensions}",
                row.index,
                row.embedding.len()
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AsrAudioContainer {
    Wav,
    Flac,
    Ogg,
    Mp3,
    Mp4,
    Caf,
    Aiff,
}

impl AsrAudioContainer {
    fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
            Self::Mp3 => "mp3",
            Self::Mp4 => "m4a",
            Self::Caf => "caf",
            Self::Aiff => "aiff",
        }
    }
}

fn sniff_asr_audio_container(prefix: &[u8], actual_bytes: u64) -> Result<AsrAudioContainer> {
    let trimmed = prefix
        .iter()
        .copied()
        .skip_while(u8::is_ascii_whitespace)
        .collect::<Vec<_>>();
    if trimmed.starts_with(b"<") || trimmed.starts_with(b"{") || trimmed.starts_with(b"[") {
        return Err(anyhow!(
            "unsupported_audio_container: downloaded payload was text data"
        ));
    }
    if prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Err(anyhow!(
            "unsupported_audio_container: WebM is not supported in protocol v1"
        ));
    }
    if prefix.len() >= 12 && &prefix[0..4] == b"RIFF" && &prefix[8..12] == b"WAVE" {
        let declared = u32::from_le_bytes(prefix[4..8].try_into()?) as u64 + 8;
        if declared > actual_bytes {
            return Err(anyhow!(
                "unsupported_audio_container: truncated RIFF/WAVE payload"
            ));
        }
        return Ok(AsrAudioContainer::Wav);
    }
    if prefix.starts_with(b"fLaC") {
        return Ok(AsrAudioContainer::Flac);
    }
    if prefix.starts_with(b"OggS") {
        return Ok(AsrAudioContainer::Ogg);
    }
    if prefix.starts_with(b"ID3")
        || (prefix.len() >= 2 && prefix[0] == 0xff && (prefix[1] & 0xe0) == 0xe0)
    {
        return Ok(AsrAudioContainer::Mp3);
    }
    if prefix.len() >= 12 && &prefix[4..8] == b"ftyp" {
        return Ok(AsrAudioContainer::Mp4);
    }
    if prefix.starts_with(b"caff") {
        return Ok(AsrAudioContainer::Caf);
    }
    if prefix.len() >= 12
        && &prefix[0..4] == b"FORM"
        && (&prefix[8..12] == b"AIFF" || &prefix[8..12] == b"AIFC")
    {
        return Ok(AsrAudioContainer::Aiff);
    }
    Err(anyhow!(
        "unsupported_audio_container: downloaded payload has an unknown container"
    ))
}

async fn download_asr_input(url: &str, job_dir: &Path) -> Result<PathBuf> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|_| anyhow!("ASR download request failed"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("ASR download failed with HTTP status {status}"));
    }
    let declared_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let declared_length = response.content_length();
    if declared_length.is_some_and(|length| length > MAX_ASR_DOWNLOAD_BYTES) {
        return Err(anyhow!("ASR download exceeded the 256 MiB limit"));
    }

    let pending_path = job_dir.join("input.download");
    let mut file = tokio::fs::File::create(&pending_path).await?;
    let mut stream = response.bytes_stream();
    let mut actual_bytes = 0_u64;
    let mut prefix = Vec::with_capacity(16);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow!("ASR download body was truncated"))?;
        actual_bytes = actual_bytes.saturating_add(chunk.len() as u64);
        if actual_bytes > MAX_ASR_DOWNLOAD_BYTES {
            return Err(anyhow!("ASR download exceeded the 256 MiB limit"));
        }
        if prefix.len() < 16 {
            let take = (16 - prefix.len()).min(chunk.len());
            prefix.extend_from_slice(&chunk[..take]);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    if actual_bytes == 0 {
        return Err(anyhow!(
            "unsupported_audio_container: downloaded payload was empty"
        ));
    }
    if declared_length.is_some_and(|length| length != actual_bytes) {
        return Err(anyhow!(
            "unsupported_audio_container: downloaded payload was truncated"
        ));
    }
    let container = sniff_asr_audio_container(&prefix, actual_bytes).map_err(|error| {
        let prefix_hex = prefix.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        anyhow!(
            "{error}; status={status} content_type={declared_type} declared_length={declared_length:?} actual_bytes={actual_bytes} prefix16={prefix_hex}"
        )
    })?;
    let audio_path = job_dir.join(format!("input.{}", container.extension()));
    tokio::fs::rename(pending_path, &audio_path).await?;
    Ok(audio_path)
}

async fn download_to(url: &str, path: &Path) -> Result<()> {
    let resp = reqwest::get(url).await?;
    if !resp.status().is_success() {
        return Err(anyhow!("download {url} failed: {}", resp.status()));
    }
    let bytes = resp.bytes().await?;
    tokio::fs::write(path, &bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_json_for_advertisable_capability_models() {
        let parsed = parse_status_capability_models(
            r#"{
              "installedModels": [
                { "id": "image-klein-nano", "category": "image", "size": "4.63 GB" },
                { "id": "text-chat-gemma4", "category": "text-chat", "size": "11 GB" },
                { "id": "music-acestep", "category": "music", "size": "10 GB" },
                { "id": "video-ltx23-av-mlx", "category": "video", "size": "48 GB" },
                { "id": "speech-asr-qwen3", "category": "speech-asr", "size": "2.47 GB" },
                { "id": "text-embed-qwen3-0.6b", "category": "text-embed", "size": "1.21 GB" },
                { "id": "sfx-woosh-flow", "category": "sfx", "size": "5 GB" }
              ]
            }"#,
        );

        assert_eq!(
            parsed,
            vec![
                "image-klein-nano",
                "text-chat-gemma4",
                "music-acestep",
                "video-ltx23-av-mlx"
            ]
        );
    }

    #[test]
    fn distinguishes_empty_status_inventory_from_invalid_status_output() {
        assert_eq!(
            decode_status_inventory(r#"{"installedModels": []}"#).map(|models| models.len()),
            Some(0)
        );
        assert!(decode_status_inventory(r#"{"models": []}"#).is_none());
        assert!(decode_status_inventory("not json").is_none());
    }

    #[test]
    fn advertises_streaming_only_from_protocol_one_status() {
        let supported = parse_asr_streaming_capabilities(
            r#"{
          "installedModels": [],
          "capabilities": {
            "asrStreamingProtocols": [1],
            "asrStreamingInputFormats": ["pcm-s16le/16000/mono"]
          }
        }"#,
        )
        .expect("streaming capability");
        assert_eq!(supported.protocols, vec![1]);
        assert!(parse_asr_streaming_capabilities(
            r#"{
          "installedModels": [],
          "capabilities": { "asrStreamingProtocols": [2], "asrStreamingInputFormats": [] }
        }"#
        )
        .is_none());
        assert!(parse_asr_streaming_capabilities(r#"{"installedModels": []}"#).is_none());
    }

    #[test]
    fn sniffs_supported_asr_containers_and_rejects_text_webm_and_truncation() {
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&4_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        assert_eq!(
            sniff_asr_audio_container(&wav, 12).unwrap(),
            AsrAudioContainer::Wav
        );
        assert_eq!(
            sniff_asr_audio_container(b"fLaC000000000000", 16).unwrap(),
            AsrAudioContainer::Flac
        );
        assert_eq!(
            sniff_asr_audio_container(b"OggS000000000000", 16).unwrap(),
            AsrAudioContainer::Ogg
        );
        assert_eq!(
            sniff_asr_audio_container(b"ID30000000000000", 16).unwrap(),
            AsrAudioContainer::Mp3
        );
        assert_eq!(
            sniff_asr_audio_container(b"0000ftypM4A 0000", 16).unwrap(),
            AsrAudioContainer::Mp4
        );
        assert_eq!(
            sniff_asr_audio_container(b"caff000000000000", 16).unwrap(),
            AsrAudioContainer::Caf
        );
        assert_eq!(
            sniff_asr_audio_container(b"FORM0000AIFF0000", 16).unwrap(),
            AsrAudioContainer::Aiff
        );
        assert!(sniff_asr_audio_container(b"<html>bad</html>", 16).is_err());
        assert!(sniff_asr_audio_container(br#"{"error":true}"#, 14).is_err());
        assert!(sniff_asr_audio_container(&[0x1a, 0x45, 0xdf, 0xa3], 4).is_err());

        let mut truncated = b"RIFF".to_vec();
        truncated.extend_from_slice(&100_u32.to_le_bytes());
        truncated.extend_from_slice(b"WAVE");
        assert!(sniff_asr_audio_container(&truncated, 12).is_err());
    }

    #[test]
    fn recognizes_an_empty_model_list_table() {
        let parsed = model_list_inventory(
            "ID                  Category       Status     Size\n\
             ----------------------------------------------------",
        );
        assert_eq!(parsed.map(|models| models.len()), Some(0));
    }

    #[test]
    fn parses_model_list_table_without_missing_or_unsupported_models() {
        let parsed = parse_model_list_capability_models(
            r#"ID                               Category        Status     Size
----------------------------------------------------------------
image-klein-nano                 image           installed  4.63 GB
image-klein-max                  image           missing    —
text-chat-gemma4                 text-chat       installed  11 GB
music-acestep                    music           installed  10 GB
video-ltx23-av-mlx               video           installed  48 GB
speech-asr-qwen3                 speech-asr      installed  2.47 GB
text-embed-qwen3-0.6b            text-embed      installed  1.21 GB
sfx-woosh-flow                   sfx             installed  5 GB"#,
        );

        assert_eq!(
            parsed,
            vec![
                "image-klein-nano",
                "text-chat-gemma4",
                "music-acestep",
                "video-ltx23-av-mlx"
            ]
        );
    }

    #[test]
    fn configured_models_keep_only_backed_model_ids() {
        let parsed = configured_capability_models(&[
            "image-klein-nano".to_string(),
            "asr".to_string(),
            "text-embed-qwen3-0.6b".to_string(),
            "text-chat-gemma4".to_string(),
            "music-acestep".to_string(),
            "video-ltx23-av-mlx".to_string(),
            "sfx-woosh-flow".to_string(),
            "image-zimage-max".to_string(),
        ]);

        assert_eq!(
            parsed,
            vec![
                "image-klein-nano",
                "text-chat-gemma4",
                "music-acestep",
                "video-ltx23-av-mlx",
                "image-zimage-max"
            ]
        );
    }

    #[test]
    fn builds_chat_command_without_running_inference() {
        let req = ChatRequest {
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "Be terse.".to_string(),
                    image_url: None,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: "Hello".to_string(),
                    image_url: None,
                },
            ],
            max_tokens: Some(64),
            temperature: Some(0.2),
            requires_json: Some(true),
            use_lora: None,
            model: Some("text-chat-gemma4-turbo".to_string()),
        };
        let args = build_chat_args(&req).unwrap();
        assert_eq!(
            args,
            vec![
                "text",
                "chat",
                "--prompt",
                "User: Hello",
                "--quiet",
                "--system",
                "Be terse.\n\nRespond with valid JSON only.",
                "--model",
                "text-chat-gemma4-turbo",
                "--max-tokens",
                "64",
                "--temperature",
                "0.2"
            ]
        );
    }

    #[test]
    fn builds_transcribe_command_without_running_inference() {
        let req = AsrRequest {
            audio_url: "https://example.com/audio.wav".to_string(),
            language: Some("en".to_string()),
            task: "transcribe".to_string(),
            max_tokens: 448,
        };
        let args = build_transcribe_args(Path::new("/tmp/audio.wav"), &req);
        assert_eq!(
            args,
            vec![
                "speech",
                "transcribe",
                "/tmp/audio.wav",
                "--backend",
                "auto",
                "--task",
                "transcribe",
                "--quiet",
                "--language",
                "en",
                "--max-tokens",
                "448"
            ]
        );
    }

    #[test]
    fn builds_embed_command_without_running_inference() {
        let req = EmbedRequest {
            texts: vec!["alpha".to_string(), "beta".to_string()],
            model: DEFAULT_EMBED_MODEL.to_string(),
            max_tokens: 512,
        };
        let args = build_embed_args(&req);
        assert_eq!(
            args,
            vec![
                "text",
                "embed",
                "--model",
                DEFAULT_EMBED_MODEL,
                "--max-tokens",
                "512",
                "--",
                "alpha",
                "beta"
            ]
        );
    }

    #[test]
    fn parses_array_embed_output_with_ordered_indexes() {
        let parsed = parse_embed_output("[[0.1,0.2],[0.3,0.4]]", DEFAULT_EMBED_MODEL).unwrap();
        assert_eq!(parsed.model.as_deref(), Some(DEFAULT_EMBED_MODEL));
        assert_eq!(parsed.dimensions, Some(2));
        assert_eq!(parsed.data[0].index, 0);
        assert_eq!(parsed.data[1].index, 1);
    }

    #[test]
    fn maps_progress_json_denoising_events_to_one_based_steps() {
        let update = denoising_update_for_line(
            r#"{"event":"progress","stage":"denoising","step":0,"total_steps":4}"#,
        )
        .unwrap();
        assert_eq!((update.step, update.total_steps), (1, 4));

        // The final stage-complete event clamps to the total.
        let update = denoising_update_for_line(
            r#"{"event":"progress","stage":"denoising","step":4,"total_steps":4}"#,
        )
        .unwrap();
        assert_eq!((update.step, update.total_steps), (4, 4));
    }

    #[test]
    fn ignores_non_denoising_progress_events_and_diagnostics() {
        assert!(denoising_update_for_line(
            r#"{"event":"progress","stage":"loadingModel","step":2,"total_steps":7}"#
        )
        .is_none());
        assert!(denoising_update_for_line("[runtime] image backend: native MLX/Metal").is_none());
        assert!(denoising_update_for_line("Loading transformer (2/7)").is_none());
        assert!(denoising_update_for_line("").is_none());
        assert!(denoising_update_for_line(
            r#"{"event":"progress","stage":"denoising","step":1,"total_steps":0}"#
        )
        .is_none());
    }

    #[test]
    fn parses_human_generating_lines_from_older_clis() {
        let update = denoising_update_for_line("Generating (2/4)").unwrap();
        assert_eq!((update.step, update.total_steps), (2, 4));
    }

    #[test]
    fn scanner_splits_carriage_return_lines_and_dedupes() {
        let mut scanner = ProgressLineScanner::new();
        let mut got = Vec::new();

        // Human-format progress arrives \r-separated, possibly split across
        // arbitrary chunk boundaries, and repeats lines.
        scanner.push_chunk(
            b"Loading model\xE2\x80\xA6\nGenerating (1/4)\rGenera",
            |u| {
                got.push((u.step, u.total_steps));
            },
        );
        scanner.push_chunk(b"ting (1/4)\rGenerating (2/4)\r", |u| {
            got.push((u.step, u.total_steps));
        });
        scanner.push_chunk(b"Generating (3/4)\rGenerating (4/4)\n", |u| {
            got.push((u.step, u.total_steps));
        });

        assert_eq!(got, vec![(1, 4), (2, 4), (3, 4), (4, 4)]);
    }

    #[test]
    fn scanner_reads_progress_json_stream() {
        let mut scanner = ProgressLineScanner::new();
        let mut got = Vec::new();

        for step in 0..=4u32 {
            let line = format!(
                "{{\"event\":\"progress\",\"stage\":\"denoising\",\"step\":{step},\"total_steps\":4}}\n"
            );
            scanner.push_chunk(line.as_bytes(), |u| got.push((u.step, u.total_steps)));
        }

        // Raw steps 3 and 4 both clamp to display step 4; the dup is dropped.
        assert_eq!(got, vec![(1, 4), (2, 4), (3, 4), (4, 4)]);
    }

    #[test]
    fn stderr_tail_is_bounded() {
        let mut tail = Vec::new();
        push_tail(&mut tail, &vec![b'a'; STDERR_TAIL_LIMIT]);
        push_tail(&mut tail, b"tail-end");
        assert_eq!(tail.len(), STDERR_TAIL_LIMIT);
        assert!(tail.ends_with(b"tail-end"));
    }

    fn write_fake_cli(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn image_job_request() -> JobRequest {
        serde_json::from_value(serde_json::json!({
            "kind": "image",
            "prompt": "test prompt",
            "width": 64,
            "height": 64,
            "steps": 4
        }))
        .unwrap()
    }

    /// End-to-end at the process boundary: a fake `mere.run` streams progress
    /// on stderr (NDJSON when advertised, `\r`-separated human text otherwise)
    /// and the node forwards deduplicated 1-based denoising steps.
    #[tokio::test]
    async fn streams_per_step_progress_from_generate_image() {
        let dir = std::env::temp_dir().join(format!(
            "mere-run-node-progress-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let json_cli = dir.join("fake-mere-run-json.sh");
        write_fake_cli(
            &json_cli,
            r#"#!/bin/bash
if [[ "$*" == *"--help"* ]]; then
  echo "  --progress-json  Stream progress to stderr as JSON lines"
  exit 0
fi
out=""
args=("$@")
for ((i=0;i<${#args[@]};i++)); do
  if [[ "${args[i]}" == "--output" ]]; then out="${args[i+1]}"; fi
done
if [[ "$*" != *"--progress-json"* ]]; then
  echo "expected --progress-json" >&2
  exit 1
fi
for s in 0 1 2 3 4; do
  echo "{\"event\":\"progress\",\"stage\":\"denoising\",\"step\":$s,\"total_steps\":4}" >&2
done
printf 'png' > "$out"
echo "$out"
"#,
        );

        let human_cli = dir.join("fake-mere-run-human.sh");
        write_fake_cli(
            &human_cli,
            r#"#!/bin/bash
if [[ "$*" == *"--help"* ]]; then
  echo "  --quiet  Print only the output path."
  exit 0
fi
if [[ "$*" == *"--progress-json"* ]]; then
  echo "Error: Unknown option '--progress-json'" >&2
  exit 64
fi
out=""
args=("$@")
for ((i=0;i<${#args[@]};i++)); do
  if [[ "${args[i]}" == "--output" ]]; then out="${args[i+1]}"; fi
done
printf 'Loading model\n' >&2
printf '\rGenerating (1/4)\rGenerating (2/4)\rGenerating (3/4)\rGenerating (4/4)\n' >&2
printf 'png' > "$out"
echo "$out"
"#,
        );

        for (cli, label) in [(&json_cli, "json"), (&human_cli, "human")] {
            std::env::set_var("MERERUN_BIN", cli);
            let (tx, mut rx) = mpsc::unbounded_channel();
            let out_path = generate_image(
                &image_job_request(),
                &dir,
                &format!("job-{label}"),
                Some(tx),
            )
            .await
            .unwrap_or_else(|e| panic!("{label} run failed: {e}"));
            assert!(out_path.exists(), "{label} output missing");

            let mut got = Vec::new();
            while let Ok(update) = rx.try_recv() {
                got.push((update.step, update.total_steps));
            }
            assert_eq!(got, vec![(1, 4), (2, 4), (3, 4), (4, 4)], "{label}");
        }
        std::env::remove_var("MERERUN_BIN");
    }
}
