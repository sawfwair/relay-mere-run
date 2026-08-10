//! Driver that wraps the local `mere.run` binary as the generation engine.
//!
//! Flags mirror the public mere.run CLI: `mere.run image generate --prompt ..
//! --model .. --output ..
//! --width .. --height .. --seed .. [--ref-image ..]`.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::protocol::{
    AsrBackend, AsrOutput, AsrRequest, AsrSentenceAlignment, AsrSpeakerSegment,
    AsrStreamingCapabilities, ChatMessage, ChatRequest, EmbedDataRow, EmbedOutput, EmbedRequest,
    JobKind, JobRequest, ModelInventoryStatus, OcrRequest, RuntimeDiagnostic, TalkRequest,
    TextAdapterCapability, TextAdapterReference,
};

const DEFAULT_MODEL: &str = "image-klein-9b";
const DEFAULT_EMBED_MODEL: &str = "text-embed-qwen3-0.6b";
const DEFAULT_TTS_MODEL: &str = "speech-tts-qwen3-nano";
const DIARIZATION_MODEL: &str = "speech-diarization-sortformer";
const IMAGE_CAPABILITY: &str = "image";
const TEXT_CAPABILITY: &str = "text";
const MUSIC_CAPABILITY: &str = "music";
const VIDEO_CAPABILITY: &str = "video";
const ASR_CAPABILITY: &str = "asr";
const EMBED_CAPABILITY: &str = "embed";
const TALK_CAPABILITY: &str = "talk-nano";
const OCR_CAPABILITY: &str = "ocr";
const LIGHTON_OCR_MODEL: &str = "vision-ocr-lighton";
const INFINITY_OCR_FLASH_MODEL: &str = "vision-ocr-infinity-flash";
const INFINITY_OCR_PRO_MODEL: &str = "vision-ocr-infinity-pro-int8";
const ADVERTISABLE_MODEL_CATEGORIES: &[&str] = &[
    "image",
    "text-chat",
    "music",
    "video",
    "speech-tts",
    "speech-diarization",
    "vision-ocr",
];
const ADVERTISABLE_MODEL_PREFIXES: &[&str] = &[
    "image-",
    "text-chat-",
    "music-",
    "video-",
    "speech-tts-",
    "speech-diarization-",
    "vision-ocr-",
];
const MAX_ASR_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_OCR_DOWNLOAD_BYTES: u64 = 10 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct LocalAdapterManifest {
    #[serde(alias = "base_model_id")]
    base_model_alias: String,
    #[serde(default)]
    files: Vec<LocalAdapterFile>,
    #[serde(default)]
    weights_sha256: Option<String>,
    #[serde(default)]
    weights_file: Option<String>,
}

#[derive(serde::Deserialize)]
struct LocalAdapterFile {
    path: String,
    role: String,
    sha256: String,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn text_adapter_root() -> Option<PathBuf> {
    std::env::var_os("MERE_RUN_ADAPTER_ROOT").map(PathBuf::from)
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn require_confined_regular_file(root: &Path, path: &Path, code: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!(
            "{code}: adapter file must be a regular non-symlink"
        ));
    }
    let canonical_root = root.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(anyhow!("{code}: adapter file escapes the configured root"));
    }
    Ok(())
}

fn declared_adapter_path(adapter_dir: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(anyhow!(
            "ADAPTER_MANIFEST_INVALID: invalid file declaration"
        ));
    }
    let declared = adapter_dir.join(path);
    require_confined_regular_file(adapter_dir, &declared, "ADAPTER_MANIFEST_INVALID")?;
    Ok(declared)
}

fn read_adapter_manifest_from_root(
    root: &Path,
    manifest_sha256: &str,
) -> Result<(LocalAdapterManifest, PathBuf)> {
    if !valid_sha256(manifest_sha256) {
        return Err(anyhow!(
            "ADAPTER_DIGEST_INVALID: manifest digest must be lowercase SHA-256"
        ));
    }
    let adapter_dir = root.join(manifest_sha256);
    let adapter_metadata = std::fs::symlink_metadata(&adapter_dir)?;
    if adapter_metadata.file_type().is_symlink() || !adapter_metadata.is_dir() {
        return Err(anyhow!(
            "ADAPTER_MANIFEST_INVALID: adapter directory must be confined"
        ));
    }
    let manifest_path = adapter_dir.join("manifest.json");
    require_confined_regular_file(&adapter_dir, &manifest_path, "ADAPTER_MANIFEST_INVALID")?;
    if file_sha256(&manifest_path)? != manifest_sha256 {
        return Err(anyhow!(
            "ADAPTER_MANIFEST_MISMATCH: manifest digest verification failed"
        ));
    }
    let manifest: LocalAdapterManifest = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    for file in &manifest.files {
        if !valid_sha256(&file.sha256) {
            return Err(anyhow!(
                "ADAPTER_MANIFEST_INVALID: invalid file declaration"
            ));
        }
        let declared_path = declared_adapter_path(&adapter_dir, &file.path)?;
        if file_sha256(&declared_path)? != file.sha256 {
            return Err(anyhow!(
                "ADAPTER_FILE_MISMATCH: declared file digest verification failed"
            ));
        }
    }
    Ok((manifest, adapter_dir))
}

fn resolve_text_adapter_from_root(
    root: &Path,
    reference: &TextAdapterReference,
) -> Result<PathBuf> {
    let (manifest, adapter_dir) =
        read_adapter_manifest_from_root(root, &reference.manifest_sha256)?;
    if manifest.base_model_alias != reference.base_model_id {
        return Err(anyhow!(
            "ADAPTER_BASE_MODEL_MISMATCH: requested base model does not match manifest"
        ));
    }
    let weights = manifest.files.iter().find(|file| file.role == "weights");
    let (weights_file, weights_sha256) = if let Some(weights) = weights {
        (weights.path.as_str(), weights.sha256.as_str())
    } else if let (Some(path), Some(digest)) = (
        manifest.weights_file.as_deref(),
        manifest.weights_sha256.as_deref(),
    ) {
        (path, digest)
    } else {
        return Err(anyhow!(
            "ADAPTER_MANIFEST_INVALID: weights declaration is missing"
        ));
    };
    if !valid_sha256(weights_sha256) {
        return Err(anyhow!(
            "ADAPTER_MANIFEST_INVALID: invalid weights declaration"
        ));
    }
    let weights_path = declared_adapter_path(&adapter_dir, weights_file)?;
    if file_sha256(&weights_path)? != weights_sha256 {
        return Err(anyhow!(
            "ADAPTER_WEIGHTS_MISMATCH: weights digest verification failed"
        ));
    }
    Ok(weights_path)
}

fn resolve_text_adapter(reference: &TextAdapterReference) -> Result<PathBuf> {
    let root = text_adapter_root().ok_or_else(|| {
        anyhow!("ADAPTER_ROOT_UNAVAILABLE: MERE_RUN_ADAPTER_ROOT is not configured")
    })?;
    resolve_text_adapter_from_root(&root, reference)
}

pub fn text_adapter_capabilities() -> Vec<TextAdapterCapability> {
    let Some(root) = text_adapter_root() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut adapters = entries
        .flatten()
        .filter_map(|entry| {
            let digest = entry.file_name().to_string_lossy().to_string();
            let (manifest, _) = read_adapter_manifest_from_root(&root, &digest).ok()?;
            let reference = TextAdapterReference {
                manifest_sha256: digest.clone(),
                base_model_id: manifest.base_model_alias.clone(),
                scale: None,
            };
            resolve_text_adapter_from_root(&root, &reference).ok()?;
            Some(TextAdapterCapability {
                manifest_sha256: digest,
                base_model_id: manifest.base_model_alias,
            })
        })
        .collect::<Vec<_>>();
    adapters.sort_by(|left, right| left.manifest_sha256.cmp(&right.manifest_sha256));
    adapters
}

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

pub(crate) async fn resolve_mere_run_binary() -> PathBuf {
    crate::runtime_binary::selected_binary().await
}

pub(crate) async fn mere_run_output(args: &[&str]) -> std::io::Result<Output> {
    let binary = resolve_mere_run_binary().await;
    Command::new(binary).args(args).output().await
}

async fn cancellable_command_output(
    binary: &Path,
    args: &[String],
    mut cancel: watch::Receiver<bool>,
    cancellation_message: &str,
) -> Result<Output> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn()?;
    let output = child.wait_with_output();
    tokio::pin!(output);
    loop {
        tokio::select! {
            result = &mut output => return Ok(result?),
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Err(anyhow!(cancellation_message.to_string()));
                }
            }
        }
    }
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
    #[serde(default, rename = "asrStreamingBackends")]
    asr_streaming_backends: Vec<String>,
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

fn include_required_runtime_models(
    mut configured: Vec<String>,
    installed: &[String],
) -> Vec<String> {
    for model in installed.iter().filter(|model| {
        model.starts_with("speech-tts-")
            || model.starts_with("speech-diarization-")
            || model.starts_with("vision-ocr-")
    }) {
        push_unique(&mut configured, model.clone());
    }
    configured
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
    let installed_models = installed_model_ids(&status.installed_models);
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
        backends: capabilities
            .asr_streaming_backends
            .into_iter()
            .filter_map(|backend| match backend.as_str() {
                "auto" => Some(AsrBackend::Auto),
                "parakeet"
                    if installed_models
                        .iter()
                        .any(|model| model == "speech-asr-parakeet") =>
                {
                    Some(AsrBackend::Parakeet)
                }
                "qwen"
                    if installed_models
                        .iter()
                        .any(|model| model == "speech-asr-qwen3") =>
                {
                    Some(AsrBackend::Qwen)
                }
                _ => None,
            })
            .collect(),
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

/// Merge configured model names with modality capability markers. Runtime
/// service models remain discoverable when saved preferences predate a feature.
pub async fn capability_models(configured: &[String]) -> Vec<String> {
    let configured_models = configured_capability_models(configured);
    let installed_models = installed_capability_models().await;
    let base = if configured_models.is_empty() {
        installed_models.clone()
    } else {
        configured_models
    };
    let base = include_required_runtime_models(base, &installed_models);
    capability_models_from(base).await
}

async fn capability_models_from(base: Vec<String>) -> Vec<String> {
    let has_tts_model = base.iter().any(|model| model.starts_with("speech-tts-"));
    let has_ocr_model = base.iter().any(|model| model.starts_with("vision-ocr-"));
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

    if has_tts_model && command_supports(&["speech", "synthesize", "--help"]).await {
        push_unique(&mut models, TALK_CAPABILITY);
    }

    if has_ocr_model && command_supports(&["vision", "ocr", "--help"]).await {
        push_unique(&mut models, OCR_CAPABILITY);
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

#[derive(Debug)]
pub struct SynthesizedSpeech {
    pub path: PathBuf,
    pub duration_seconds: f64,
    pub sample_rate: u32,
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

/// Build the `mere.run video generate` argument list. Source audio engages the
/// native LTX 2.3 audio-to-video lane; the segment length is governed by
/// `--duration`, so only the start offset is passed alongside the file.
fn build_video_generate_args(
    req: &JobRequest,
    model: &str,
    out_path: &Path,
    input_image: Option<&Path>,
    input_audio: Option<&Path>,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![
        "video".into(),
        "generate".into(),
        req.prompt.clone().into(),
        "--model".into(),
        model.into(),
        "--output".into(),
        out_path.into(),
        "--width".into(),
        req.width.to_string().into(),
        "--height".into(),
        req.height.to_string().into(),
        "--quiet".into(),
    ];
    if let Some(duration) = req.duration_seconds {
        args.push("--duration".into());
        args.push(duration.to_string().into());
    }
    if let Some(fps) = req.fps {
        args.push("--fps".into());
        args.push(fps.to_string().into());
    }
    if let Some(num_frames) = req.num_frames {
        args.push("--num-frames".into());
        args.push(num_frames.to_string().into());
    }
    if let Some(seed) = req.seed {
        args.push("--seed".into());
        args.push(seed.to_string().into());
    }
    if let Some(image) = input_image {
        args.push("--image".into());
        args.push(image.into());
        if let Some(strength) = req.input_strength {
            args.push("--image-strength".into());
            args.push(strength.to_string().into());
        }
    }
    if let Some(audio) = input_audio {
        args.push("--audio".into());
        args.push(audio.into());
        if let Some(start) = req.audio_start_seconds {
            if start > 0.0 {
                args.push("--audio-start-time".into());
                args.push(start.to_string().into());
            }
        }
    }
    args
}

pub async fn generate_video(req: &JobRequest, out_dir: &Path, job_id: &str) -> Result<PathBuf> {
    tokio::fs::create_dir_all(out_dir).await.ok();
    let out_path = out_dir.join(format!("{job_id}.mp4"));
    let model = req
        .model
        .clone()
        .unwrap_or_else(|| "video-ltx23-av-mlx".to_string());

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
    let audio_path = if let Some(url) = req.input_audio_url.as_deref() {
        Some(download_asr_input(url, out_dir).await?)
    } else {
        None
    };

    let mut cmd = Command::new(resolve_mere_run_binary().await);
    cmd.args(build_video_generate_args(
        req,
        &model,
        &out_path,
        input_path.as_deref(),
        audio_path.as_deref(),
    ));

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

fn speech_synthesis_command(binary: &Path, req: &TalkRequest, output: &Path) -> Result<Command> {
    if req.text.trim().is_empty() {
        return Err(anyhow!("speech synthesis text is empty"));
    }
    if req.output_format != "wav" {
        return Err(anyhow!(
            "unsupported speech output format: {}",
            req.output_format
        ));
    }
    if (req.speed - 1.0).abs() > f32::EPSILON {
        return Err(anyhow!(
            "mere.run speech synthesis currently supports speed 1.0"
        ));
    }
    if !req.temperature.is_finite() {
        return Err(anyhow!("speech synthesis temperature must be finite"));
    }

    let mut command = Command::new(binary);
    command
        .arg("speech")
        .arg("synthesize")
        .arg(&req.text)
        .arg("--model")
        .arg(DEFAULT_TTS_MODEL)
        .arg("--output")
        .arg(output)
        .arg("--temperature")
        .arg(req.temperature.to_string())
        .arg("--quiet");
    if let Some(voice) = req
        .voice_description
        .as_deref()
        .map(str::trim)
        .filter(|voice| !voice.is_empty())
    {
        command.arg("--voice").arg(voice);
    }
    Ok(command)
}

fn read_wav_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| anyhow!("truncated WAV metadata"))?;
    Ok(u32::from_le_bytes(
        value.try_into().expect("four-byte WAV field"),
    ))
}

fn wav_metadata(bytes: &[u8]) -> Result<(u32, f64)> {
    if bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") || bytes.len() < 12 {
        return Err(anyhow!("mere.run produced an invalid WAV file"));
    }

    let mut sample_rate = None;
    let mut byte_rate = None;
    let mut data_bytes = None;
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = read_wav_u32(bytes, offset + 4)? as usize;
        let data_offset = offset + 8;
        let data_end = data_offset
            .checked_add(chunk_size)
            .ok_or_else(|| anyhow!("invalid WAV chunk size"))?;
        if data_end > bytes.len() {
            return Err(anyhow!("truncated WAV chunk"));
        }
        if chunk_id == b"fmt " {
            if chunk_size < 16 {
                return Err(anyhow!("invalid WAV format chunk"));
            }
            sample_rate = Some(read_wav_u32(bytes, data_offset + 4)?);
            byte_rate = Some(read_wav_u32(bytes, data_offset + 8)?);
        } else if chunk_id == b"data" {
            data_bytes = Some(chunk_size as u64);
        }
        offset = data_end + (chunk_size % 2);
    }

    let sample_rate = sample_rate.ok_or_else(|| anyhow!("WAV sample rate is missing"))?;
    let byte_rate = byte_rate.ok_or_else(|| anyhow!("WAV byte rate is missing"))?;
    let data_bytes = data_bytes.ok_or_else(|| anyhow!("WAV audio data is missing"))?;
    if sample_rate == 0 || byte_rate == 0 {
        return Err(anyhow!("invalid WAV sample or byte rate"));
    }
    Ok((sample_rate, data_bytes as f64 / f64::from(byte_rate)))
}

pub async fn synthesize_speech(
    req: &TalkRequest,
    out_dir: &Path,
    talk_id: &str,
    cancel: watch::Receiver<bool>,
) -> Result<SynthesizedSpeech> {
    let binary = resolve_mere_run_binary().await;
    synthesize_speech_with_binary(req, out_dir, talk_id, cancel, &binary).await
}

async fn synthesize_speech_with_binary(
    req: &TalkRequest,
    out_dir: &Path,
    talk_id: &str,
    mut cancel: watch::Receiver<bool>,
    binary: &Path,
) -> Result<SynthesizedSpeech> {
    tokio::fs::create_dir_all(out_dir).await?;
    let output_path = out_dir.join(format!("{talk_id}.wav"));
    let mut command = speech_synthesis_command(binary, req, &output_path)?;
    command.kill_on_drop(true);
    let child = command.spawn()?;
    let output = child.wait_with_output();
    tokio::pin!(output);

    let command_output = loop {
        tokio::select! {
            result = &mut output => break result?,
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    let _ = tokio::fs::remove_file(&output_path).await;
                    return Err(anyhow!("speech synthesis cancelled"));
                }
            }
        }
    };

    if !command_output.status.success() {
        let _ = tokio::fs::remove_file(&output_path).await;
        let stderr = String::from_utf8_lossy(&command_output.stderr);
        return Err(anyhow!(
            "mere.run speech synthesize failed: {}",
            stderr.trim()
        ));
    }

    let bytes = tokio::fs::read(&output_path).await?;
    let (sample_rate, duration_seconds) = wav_metadata(&bytes)?;
    Ok(SynthesizedSpeech {
        path: output_path,
        duration_seconds,
        sample_rate,
    })
}

/// Download the ASR input to a per-job temp file and invoke `mere.run speech transcribe`.
pub async fn transcribe_speech(
    req: &AsrRequest,
    out_dir: &Path,
    asr_id: &str,
    cancel: watch::Receiver<bool>,
) -> Result<AsrOutput> {
    let binary = resolve_mere_run_binary().await;
    transcribe_speech_with_binary(req, out_dir, asr_id, cancel, &binary).await
}

async fn transcribe_speech_with_binary(
    req: &AsrRequest,
    out_dir: &Path,
    asr_id: &str,
    mut cancel: watch::Receiver<bool>,
    binary: &Path,
) -> Result<AsrOutput> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let job_dir = out_dir.join(format!("{asr_id}-{unique:x}"));
    tokio::fs::create_dir_all(&job_dir).await?;
    let result = async {
        let audio_path = tokio::select! {
            result = download_asr_input(&req.audio_url, &job_dir) => result?,
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Err(anyhow!("speech transcription cancelled"));
                }
                return Err(anyhow!("speech transcription cancellation channel changed unexpectedly"));
            }
        };
        let args = build_transcribe_args(&audio_path, req);
        let output = cancellable_command_output(
            binary,
            &args,
            cancel.clone(),
            "speech transcription cancelled",
        )
        .await?;
        if !output.status.success() {
            return Err(anyhow!(
                "downloaded_payload_invalid_audio: verified audio container could not be decoded"
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let mut transcript = parse_transcript_output(&stdout, req)?;
        if req.diarize {
            let diarization = cancellable_command_output(
                binary,
                &build_diarize_args(&audio_path),
                cancel,
                "speaker diarization cancelled",
            )
            .await?;
            if !diarization.status.success() {
                let stderr = String::from_utf8_lossy(&diarization.stderr);
                return Err(anyhow!("mere.run speech diarize failed: {}", stderr.trim()));
            }
            transcript.speaker_segments = Some(parse_diarization_output(
                String::from_utf8_lossy(&diarization.stdout).trim(),
            )?);
        }
        Ok(transcript)
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

#[derive(Debug, Clone, PartialEq)]
pub struct OcrOutput {
    pub text: String,
    pub tokens_generated: Option<u32>,
}

/// Download one verified image and extract its text with an installed OCR model.
pub async fn extract_ocr_text(
    req: &OcrRequest,
    out_dir: &Path,
    ocr_id: &str,
    cancel: watch::Receiver<bool>,
) -> Result<OcrOutput> {
    let binary = resolve_mere_run_binary().await;
    let installed = installed_capability_models().await;
    let model = select_ocr_model(&installed).ok_or_else(|| {
        anyhow!(
            "OCR requires an installed supported model: {LIGHTON_OCR_MODEL}, \
             {INFINITY_OCR_FLASH_MODEL}, or {INFINITY_OCR_PRO_MODEL}"
        )
    })?;
    extract_ocr_text_with_binary(req, out_dir, ocr_id, cancel, &binary, &model).await
}

async fn extract_ocr_text_with_binary(
    req: &OcrRequest,
    out_dir: &Path,
    ocr_id: &str,
    mut cancel: watch::Receiver<bool>,
    binary: &Path,
    model: &OcrRuntimeModel,
) -> Result<OcrOutput> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let job_dir = out_dir.join(format!("{ocr_id}-{unique:x}"));
    tokio::fs::create_dir_all(&job_dir).await?;
    let result = async {
        let image_path = tokio::select! {
            result = download_ocr_input(&req.image_url, &job_dir) => result?,
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Err(anyhow!("OCR extraction cancelled"));
                }
                return Err(anyhow!("OCR cancellation channel changed unexpectedly"));
            }
        };
        let args = build_ocr_args(&image_path, req, model);
        let output =
            cancellable_command_output(binary, &args, cancel, "OCR extraction cancelled").await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("mere.run vision ocr failed: {}", stderr.trim()));
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return Err(anyhow!("mere.run vision ocr returned no text"));
        }
        Ok(OcrOutput {
            text,
            tokens_generated: None,
        })
    }
    .await;
    let keep_failed = std::env::var("MERERUN_NODE_KEEP_FAILED_OCR")
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

pub async fn chat_text(req: &ChatRequest, cancel: watch::Receiver<bool>) -> Result<String> {
    let args = build_chat_args(req)?;
    let binary = resolve_mere_run_binary().await;
    let output = cancellable_command_output(&binary, &args, cancel, "text chat cancelled").await?;
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
    if req.use_lora.unwrap_or(false) && req.adapter.is_none() {
        return Err(anyhow!(
            "ADAPTER_REFERENCE_REQUIRED: use_lora requires an exact adapter reference"
        ));
    }
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
    let requested_model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let selected_model = if let Some(adapter) = &req.adapter {
        if requested_model.is_some_and(|model| model != adapter.base_model_id) {
            return Err(anyhow!(
                "ADAPTER_BASE_MODEL_MISMATCH: requested model does not match adapter base model"
            ));
        }
        Some(adapter.base_model_id.as_str())
    } else {
        requested_model
    };
    if let Some(model) = selected_model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(adapter) = &req.adapter {
        if adapter
            .scale
            .is_some_and(|scale| !(0.0..=4.0).contains(&scale) || scale == 0.0)
        {
            return Err(anyhow!(
                "ADAPTER_SCALE_INVALID: adapter scale must be greater than zero and at most four"
            ));
        }
        let weights_path = resolve_text_adapter(adapter)?;
        args.push("--lora".to_string());
        args.push(weights_path.to_string_lossy().to_string());
        args.push("--lora-scale".to_string());
        args.push(adapter.scale.unwrap_or(1.0).to_string());
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
        req.backend.as_str().to_string(),
        "--task".to_string(),
        req.task.clone(),
        "--quiet".to_string(),
        "--timestamps".to_string(),
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

fn build_diarize_args(audio_path: &Path) -> Vec<String> {
    vec![
        "speech".to_string(),
        "diarize".to_string(),
        audio_path.to_string_lossy().to_string(),
        "--model".to_string(),
        DIARIZATION_MODEL.to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--quiet".to_string(),
    ]
}

#[derive(serde::Deserialize)]
struct DiarizationCommandOutput {
    segments: Vec<AsrSpeakerSegment>,
}

fn parse_diarization_output(stdout: &str) -> Result<Vec<AsrSpeakerSegment>> {
    let output: DiarizationCommandOutput = serde_json::from_str(stdout)
        .map_err(|error| anyhow!("mere.run speech diarize returned invalid JSON: {error}"))?;
    for (index, segment) in output.segments.iter().enumerate() {
        if segment.speaker.trim().is_empty()
            || !segment.start_seconds.is_finite()
            || !segment.end_seconds.is_finite()
            || !segment.duration_seconds.is_finite()
            || segment.start_seconds < 0.0
            || segment.end_seconds < segment.start_seconds
            || segment.duration_seconds < 0.0
        {
            return Err(anyhow!(
                "mere.run speech diarize returned an invalid segment at index {index}"
            ));
        }
    }
    Ok(output.segments)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OcrRuntimeModel {
    LightOn(String),
    Infinity(String),
}

fn select_ocr_model(installed: &[String]) -> Option<OcrRuntimeModel> {
    if installed.iter().any(|model| model == LIGHTON_OCR_MODEL) {
        return Some(OcrRuntimeModel::LightOn(LIGHTON_OCR_MODEL.to_string()));
    }
    if installed
        .iter()
        .any(|model| model == INFINITY_OCR_FLASH_MODEL)
    {
        return Some(OcrRuntimeModel::Infinity(
            INFINITY_OCR_FLASH_MODEL.to_string(),
        ));
    }
    if installed
        .iter()
        .any(|model| model == INFINITY_OCR_PRO_MODEL)
    {
        return Some(OcrRuntimeModel::Infinity(
            INFINITY_OCR_PRO_MODEL.to_string(),
        ));
    }
    None
}

fn build_ocr_args(image_path: &Path, req: &OcrRequest, model: &OcrRuntimeModel) -> Vec<String> {
    let mut args = vec![
        "vision".to_string(),
        "ocr".to_string(),
        image_path.to_string_lossy().to_string(),
    ];
    match model {
        OcrRuntimeModel::LightOn(model) => {
            args.extend([
                "--backend".to_string(),
                "lighton".to_string(),
                "--model".to_string(),
                model.clone(),
            ]);
        }
        OcrRuntimeModel::Infinity(model) => {
            args.extend([
                "--backend".to_string(),
                "infinity".to_string(),
                "--infinity-model".to_string(),
                model.clone(),
                "--infinity-task".to_string(),
                "doc2md".to_string(),
            ]);
        }
    }
    args.extend([
        "--max-tokens".to_string(),
        req.max_tokens.max(1).to_string(),
        "--temperature".to_string(),
        req.temperature.to_string(),
        "--quiet".to_string(),
    ]);
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
                speaker_segments: None,
            });
        }
    }

    if let Some(sentences) = parse_timestamped_transcript(stdout) {
        let duration_seconds = sentences.last().map(|sentence| sentence.end_seconds);
        let text = sentences
            .iter()
            .map(|sentence| sentence.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(AsrOutput {
            text,
            language: req.language.clone(),
            duration_seconds,
            token_alignments: None,
            sentence_alignments: Some(sentences),
            speaker_segments: None,
        });
    }

    Ok(AsrOutput {
        text: stdout.trim().to_string(),
        language: req.language.clone(),
        duration_seconds: None,
        token_alignments: None,
        sentence_alignments: None,
        speaker_segments: None,
    })
}

fn parse_timestamped_transcript(stdout: &str) -> Option<Vec<AsrSentenceAlignment>> {
    let mut sentences = Vec::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some((timestamps, text)) = line
            .strip_prefix('[')
            .and_then(|line| line.split_once("] "))
        else {
            continue;
        };
        let Some((start, end)) = timestamps.split_once(" --> ") else {
            continue;
        };
        let (Some(start_seconds), Some(end_seconds)) =
            (parse_transcript_time(start), parse_transcript_time(end))
        else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || end_seconds < start_seconds {
            continue;
        }
        sentences.push(AsrSentenceAlignment {
            text: text.to_string(),
            start_seconds,
            duration_seconds: end_seconds - start_seconds,
            end_seconds,
            tokens: Vec::new(),
        });
    }
    (!sentences.is_empty()).then_some(sentences)
}

fn parse_transcript_time(value: &str) -> Option<f64> {
    let parts = value.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (
            0.0,
            minutes.parse::<f64>().ok()?,
            seconds.parse::<f64>().ok()?,
        ),
        [hours, minutes, seconds] => (
            hours.parse::<f64>().ok()?,
            minutes.parse::<f64>().ok()?,
            seconds.parse::<f64>().ok()?,
        ),
        _ => return None,
    };
    if minutes >= 60.0 || seconds >= 60.0 {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OcrImageContainer {
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl OcrImageContainer {
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Gif => "gif",
        }
    }
}

fn sniff_ocr_image_container(prefix: &[u8]) -> Result<OcrImageContainer> {
    let trimmed = prefix
        .iter()
        .copied()
        .skip_while(u8::is_ascii_whitespace)
        .collect::<Vec<_>>();
    if trimmed.starts_with(b"<") || trimmed.starts_with(b"{") || trimmed.starts_with(b"[") {
        return Err(anyhow!(
            "unsupported_image_container: downloaded payload was text data"
        ));
    }
    if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(OcrImageContainer::Png);
    }
    if prefix.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok(OcrImageContainer::Jpeg);
    }
    if prefix.len() >= 12 && &prefix[0..4] == b"RIFF" && &prefix[8..12] == b"WEBP" {
        return Ok(OcrImageContainer::Webp);
    }
    if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        return Ok(OcrImageContainer::Gif);
    }
    Err(anyhow!(
        "unsupported_image_container: downloaded payload has an unknown container"
    ))
}

async fn download_ocr_input(url: &str, job_dir: &Path) -> Result<PathBuf> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|_| anyhow!("OCR image download request failed"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!(
            "OCR image download failed with HTTP status {status}"
        ));
    }
    let declared_length = response.content_length();
    if declared_length.is_some_and(|length| length > MAX_OCR_DOWNLOAD_BYTES) {
        return Err(anyhow!("OCR image download exceeded the 10 MiB limit"));
    }

    let pending_path = job_dir.join("input.download");
    let mut file = tokio::fs::File::create(&pending_path).await?;
    let mut stream = response.bytes_stream();
    let mut actual_bytes = 0_u64;
    let mut prefix = Vec::with_capacity(16);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow!("OCR image download body was truncated"))?;
        actual_bytes = actual_bytes.saturating_add(chunk.len() as u64);
        if actual_bytes > MAX_OCR_DOWNLOAD_BYTES {
            return Err(anyhow!("OCR image download exceeded the 10 MiB limit"));
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
            "unsupported_image_container: downloaded payload was empty"
        ));
    }
    if declared_length.is_some_and(|length| length != actual_bytes) {
        return Err(anyhow!(
            "unsupported_image_container: downloaded payload was truncated"
        ));
    }
    let container = sniff_ocr_image_container(&prefix)?;
    let image_path = job_dir.join(format!("input.{}", container.extension()));
    tokio::fs::rename(pending_path, &image_path).await?;
    Ok(image_path)
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
                { "id": "speech-tts-qwen3-nano", "category": "speech-tts", "size": "4.57 GB" },
                { "id": "speech-diarization-sortformer", "category": "speech-diarization", "size": "236 MB" },
                { "id": "speech-asr-qwen3", "category": "speech-asr", "size": "2.47 GB" },
                { "id": "text-embed-qwen3-0.6b", "category": "text-embed", "size": "1.21 GB" },
                { "id": "vision-ocr-lighton", "category": "vision-ocr", "size": "4.1 GB" },
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
                "video-ltx23-av-mlx",
                "speech-tts-qwen3-nano",
                "speech-diarization-sortformer",
                "vision-ocr-lighton"
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
          "installedModels": [
            { "id": "speech-asr-parakeet", "category": "speech-asr" }
          ],
          "capabilities": {
            "asrStreamingProtocols": [1],
            "asrStreamingInputFormats": ["pcm-s16le/16000/mono"],
            "asrStreamingBackends": ["parakeet", "qwen", "future"]
          }
        }"#,
        )
        .expect("streaming capability");
        assert_eq!(supported.protocols, vec![1]);
        assert_eq!(supported.backends, vec![AsrBackend::Parakeet]);
        let legacy = parse_asr_streaming_capabilities(
            r#"{
          "installedModels": [],
          "capabilities": {
            "asrStreamingProtocols": [1],
            "asrStreamingInputFormats": ["pcm-s16le/16000/mono"]
          }
        }"#,
        )
        .expect("legacy streaming capability");
        assert!(legacy.backends.is_empty());
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
    fn sniffs_supported_ocr_images_and_rejects_text_and_unknown_payloads() {
        assert_eq!(
            sniff_ocr_image_container(b"\x89PNG\r\n\x1a\n00000000").unwrap(),
            OcrImageContainer::Png
        );
        assert_eq!(
            sniff_ocr_image_container(&[0xff, 0xd8, 0xff, 0xe0]).unwrap(),
            OcrImageContainer::Jpeg
        );
        assert_eq!(
            sniff_ocr_image_container(b"RIFF0000WEBP0000").unwrap(),
            OcrImageContainer::Webp
        );
        assert_eq!(
            sniff_ocr_image_container(b"GIF89a0000000000").unwrap(),
            OcrImageContainer::Gif
        );
        assert!(sniff_ocr_image_container(b"<svg></svg>").is_err());
        assert!(sniff_ocr_image_container(br#"{"error":true}"#).is_err());
        assert!(sniff_ocr_image_container(b"not-an-image").is_err());
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
speech-tts-qwen3-nano            speech-tts      installed  4.57 GB
speech-diarization-sortformer    speech-diarization installed 236 MB
speech-asr-qwen3                 speech-asr      installed  2.47 GB
text-embed-qwen3-0.6b            text-embed      installed  1.21 GB
vision-ocr-lighton               vision-ocr      installed  4.1 GB
sfx-woosh-flow                   sfx             installed  5 GB"#,
        );

        assert_eq!(
            parsed,
            vec![
                "image-klein-nano",
                "text-chat-gemma4",
                "music-acestep",
                "video-ltx23-av-mlx",
                "speech-tts-qwen3-nano",
                "speech-diarization-sortformer",
                "vision-ocr-lighton"
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
            "speech-tts-qwen3-nano".to_string(),
            "speech-diarization-sortformer".to_string(),
            "vision-ocr-lighton".to_string(),
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
                "speech-tts-qwen3-nano",
                "speech-diarization-sortformer",
                "vision-ocr-lighton",
                "image-zimage-max"
            ]
        );
    }

    #[test]
    fn configured_models_include_installed_service_models() {
        let configured = vec!["image-klein-nano".to_string()];
        let installed = vec![
            "image-zimage-nano".to_string(),
            "speech-tts-qwen3-nano".to_string(),
            "speech-diarization-sortformer".to_string(),
            "vision-ocr-lighton".to_string(),
        ];

        assert_eq!(
            include_required_runtime_models(configured, &installed),
            vec![
                "image-klein-nano",
                "speech-tts-qwen3-nano",
                "speech-diarization-sortformer",
                "vision-ocr-lighton"
            ]
        );
    }

    #[test]
    fn builds_speech_synthesis_command_without_running_inference() {
        let request = TalkRequest {
            text: "Hello from the relay.".to_string(),
            voice_description: Some("A warm, clear narrator".to_string()),
            speed: 1.0,
            temperature: 0.5,
            output_format: "wav".to_string(),
        };
        let command = speech_synthesis_command(
            Path::new("/usr/local/bin/mere.run"),
            &request,
            Path::new("/tmp/talk_123.wav"),
        )
        .expect("speech command");
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            args,
            vec![
                "speech",
                "synthesize",
                "Hello from the relay.",
                "--model",
                "speech-tts-qwen3-nano",
                "--output",
                "/tmp/talk_123.wav",
                "--temperature",
                "0.5",
                "--quiet",
                "--voice",
                "A warm, clear narrator",
            ]
        );
    }

    #[test]
    fn reads_wav_sample_rate_and_duration() {
        let data_bytes = 48_000u32;
        let mut wav = Vec::with_capacity(44 + data_bytes as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        wav.resize(44 + data_bytes as usize, 0);

        let (sample_rate, duration) = wav_metadata(&wav).expect("WAV metadata");
        assert_eq!(sample_rate, 24_000);
        assert!((duration - 1.0).abs() < f64::EPSILON);
        assert!(wav_metadata(b"not a wave file").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_speech_child() {
        use std::os::unix::fs::PermissionsExt;

        let unique = format!(
            "mere-run-node-talk-cancel-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("create test directory");
        let fake_binary = dir.join("mere.run");
        std::fs::write(&fake_binary, "#!/bin/sh\nexec sleep 30\n").expect("write fake runtime");
        let mut permissions = std::fs::metadata(&fake_binary)
            .expect("fake runtime metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_binary, permissions).expect("make fake runtime executable");

        let request = TalkRequest {
            text: "This job should be cancelled.".to_string(),
            voice_description: None,
            speed: 1.0,
            temperature: 0.6,
            output_format: "wav".to_string(),
        };
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task_dir = dir.clone();
        let task_binary = fake_binary.clone();
        let task = tokio::spawn(async move {
            synthesize_speech_with_binary(
                &request,
                &task_dir,
                "talk_cancel",
                cancel_rx,
                &task_binary,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel_tx.send(true).expect("send cancellation");
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("cancelled child should exit promptly")
            .expect("speech task should join");

        assert_eq!(
            result.expect_err("speech should be cancelled").to_string(),
            "speech synthesis cancelled"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellable_commands_capture_stdout_and_stderr() {
        use std::os::unix::fs::PermissionsExt;

        let unique = format!(
            "mere-run-node-captured-output-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("create test directory");
        let fake_binary = dir.join("mere.run");
        std::fs::write(
            &fake_binary,
            "#!/bin/sh\nprintf 'captured transcript'\nprintf 'diagnostic' >&2\n",
        )
        .expect("write fake runtime");
        let mut permissions = std::fs::metadata(&fake_binary)
            .expect("fake runtime metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_binary, permissions).expect("make fake runtime executable");
        let (_cancel_tx, cancel_rx) = watch::channel(false);

        let output =
            cancellable_command_output(&fake_binary, &[], cancel_rx, "test command cancelled")
                .await
                .expect("captured command output");

        assert_eq!(output.stdout, b"captured transcript");
        assert_eq!(output.stderr, b"diagnostic");
        let _ = std::fs::remove_dir_all(dir);
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
            adapter: None,
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
    fn rejects_chat_adapter_with_a_different_requested_base_model() {
        let req = ChatRequest {
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                image_url: None,
            }],
            max_tokens: None,
            temperature: None,
            requires_json: None,
            use_lora: Some(true),
            adapter: Some(TextAdapterReference {
                manifest_sha256: "a".repeat(64),
                base_model_id: "text-chat-gemma4-turbo".to_string(),
                scale: Some(1.0),
            }),
            model: Some("text-chat-other-model".to_string()),
        };
        let error = build_chat_args(&req).expect_err("mismatched model should fail closed");
        assert!(error.to_string().contains("ADAPTER_BASE_MODEL_MISMATCH"));
    }

    #[test]
    fn adapter_manifest_paths_allow_nested_files_but_reject_traversal() {
        let root = std::env::temp_dir().join(format!(
            "mere-run-node-adapter-paths-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let nested = root.join("weights").join("adapter.safetensors");
        std::fs::create_dir_all(nested.parent().expect("nested parent"))
            .expect("create nested adapter directory");
        std::fs::write(&nested, b"weights").expect("write adapter weights");

        assert_eq!(
            declared_adapter_path(&root, "weights/adapter.safetensors")
                .expect("nested path should be confined"),
            nested
        );
        assert!(declared_adapter_path(&root, "../adapter.safetensors").is_err());
        assert!(declared_adapter_path(&root, "/tmp/adapter.safetensors").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exact_adapter_resolution_revalidates_manifest_model_and_weights() {
        let root = std::env::temp_dir().join(format!(
            "mere-run-node-adapter-resolution-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let weights = b"verified adapter weights";
        let weights_sha256 = format!("{:x}", Sha256::digest(weights));
        let manifest_bytes = serde_json::to_vec(&serde_json::json!({
            "base_model_alias": "text-chat-gemma4-turbo",
            "files": [{
                "path": "weights/adapter.safetensors",
                "role": "weights",
                "sha256": weights_sha256
            }]
        }))
        .expect("serialize adapter manifest");
        let manifest_sha256 = format!("{:x}", Sha256::digest(&manifest_bytes));
        let adapter_dir = root.join(&manifest_sha256);
        let weights_path = adapter_dir.join("weights/adapter.safetensors");
        std::fs::create_dir_all(weights_path.parent().expect("weights parent"))
            .expect("create adapter directory");
        std::fs::write(adapter_dir.join("manifest.json"), manifest_bytes)
            .expect("write adapter manifest");
        std::fs::write(&weights_path, weights).expect("write adapter weights");
        let reference = TextAdapterReference {
            manifest_sha256,
            base_model_id: "text-chat-gemma4-turbo".to_string(),
            scale: Some(0.8),
        };

        assert_eq!(
            resolve_text_adapter_from_root(&root, &reference)
                .expect("verified adapter should resolve"),
            weights_path
        );
        let wrong_model = TextAdapterReference {
            base_model_id: "text-chat-other-model".to_string(),
            ..reference.clone()
        };
        assert!(resolve_text_adapter_from_root(&root, &wrong_model)
            .expect_err("wrong model should fail")
            .to_string()
            .contains("ADAPTER_BASE_MODEL_MISMATCH"));
        std::fs::write(&weights_path, b"tampered").expect("tamper adapter weights");
        assert!(resolve_text_adapter_from_root(&root, &reference)
            .expect_err("tampered weights should fail")
            .to_string()
            .contains("ADAPTER_FILE_MISMATCH"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn builds_video_generate_args_with_audio_to_video_lane() {
        let req: JobRequest = serde_json::from_value(serde_json::json!({
            "kind": "video",
            "prompt": "the band tears through the chorus",
            "width": 1280,
            "height": 704,
            "duration_seconds": 28.42,
            "fps": 24,
            "seed": 7,
            "input_audio_url": "https://relay.example/audio/segment.mp3",
            "audio_start_seconds": 90.5
        }))
        .unwrap();
        let args = build_video_generate_args(
            &req,
            "video-ltx23-a2vid-mlx",
            Path::new("/tmp/out.mp4"),
            None,
            Some(Path::new("/tmp/input.mp3")),
        );
        let args: Vec<String> = args
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "video",
                "generate",
                "the band tears through the chorus",
                "--model",
                "video-ltx23-a2vid-mlx",
                "--output",
                "/tmp/out.mp4",
                "--width",
                "1280",
                "--height",
                "704",
                "--quiet",
                "--duration",
                "28.42",
                "--fps",
                "24",
                "--seed",
                "7",
                "--audio",
                "/tmp/input.mp3",
                "--audio-start-time",
                "90.5"
            ]
        );
    }

    #[test]
    fn builds_video_generate_args_without_audio_or_start_offset() {
        let req: JobRequest = serde_json::from_value(serde_json::json!({
            "kind": "video",
            "prompt": "silent skyline",
            "width": 768,
            "height": 512,
            "input_audio_url": "https://relay.example/audio/segment.mp3",
            "audio_start_seconds": 0.0
        }))
        .unwrap();
        let with_zero_start = build_video_generate_args(
            &req,
            "video-ltx23-av-mlx",
            Path::new("/tmp/out.mp4"),
            None,
            Some(Path::new("/tmp/input.wav")),
        );
        let rendered: Vec<String> = with_zero_start
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(rendered.contains(&"--audio".to_string()));
        assert!(!rendered.contains(&"--audio-start-time".to_string()));

        let no_audio = build_video_generate_args(
            &req,
            "video-ltx23-av-mlx",
            Path::new("/tmp/out.mp4"),
            None,
            None,
        );
        let rendered: Vec<String> = no_audio
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!rendered.contains(&"--audio".to_string()));
    }

    #[test]
    fn builds_transcribe_command_without_running_inference() {
        let req = AsrRequest {
            audio_url: "https://example.com/audio.wav".to_string(),
            language: Some("en".to_string()),
            task: "transcribe".to_string(),
            backend: AsrBackend::Parakeet,
            diarize: false,
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
                "parakeet",
                "--task",
                "transcribe",
                "--quiet",
                "--timestamps",
                "--language",
                "en",
                "--max-tokens",
                "448"
            ]
        );
    }

    #[test]
    fn builds_diarization_command_and_normalizes_speaker_segments() {
        assert_eq!(
            build_diarize_args(Path::new("/tmp/audio.wav")),
            vec![
                "speech",
                "diarize",
                "/tmp/audio.wav",
                "--model",
                "speech-diarization-sortformer",
                "--format",
                "json",
                "--quiet"
            ]
        );

        let segments = parse_diarization_output(
            r#"{"schema_version":1,"segments":[{"speaker":"speaker_2","speaker_index":2,"start_seconds":1.25,"end_seconds":3.5,"duration_seconds":2.25}]}"#,
        )
        .expect("diarization output");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].speaker, "speaker_2");
        assert_eq!(segments[0].speaker_index, 2);
        assert_eq!(segments[0].start_seconds, 1.25);
        assert_eq!(segments[0].end_seconds, 3.5);
        assert!(parse_diarization_output(
            r#"{"segments":[{"speaker":"","speaker_index":0,"start_seconds":2,"end_seconds":1,"duration_seconds":0}]}"#
        )
        .is_err());
    }

    #[test]
    fn parses_timestamped_transcript_without_duplicating_plain_text() {
        let req = AsrRequest {
            audio_url: "https://example.com/audio.wav".to_string(),
            language: Some("en".to_string()),
            task: "transcribe".to_string(),
            backend: AsrBackend::Parakeet,
            diarize: false,
            max_tokens: 448,
        };
        let output = parse_transcript_output(
            "Agents Markdown can now read this document aloud.\n\n\
             [00:00.000 --> 00:03.040] Agents Markdown can now read this document aloud.",
            &req,
        )
        .expect("timestamped transcript");

        assert_eq!(
            output.text,
            "Agents Markdown can now read this document aloud."
        );
        assert_eq!(output.duration_seconds, Some(3.04));
        let sentences = output.sentence_alignments.expect("sentence alignments");
        assert_eq!(sentences.len(), 1);
        assert_eq!(sentences[0].start_seconds, 0.0);
        assert_eq!(sentences[0].end_seconds, 3.04);
        assert!(sentences[0].tokens.is_empty());
    }

    #[test]
    fn parses_multiple_timestamp_formats_and_skips_malformed_lines() {
        let parsed = parse_timestamped_transcript(
            "[00:58.500 --> 01:02.250] First sentence.\n\
             [01:02:03.125 --> 01:02:05.500] Second sentence.\n\
             [bogus --> 00:01.000] ignored",
        )
        .expect("timestamped transcript");

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].start_seconds, 58.5);
        assert_eq!(parsed[0].end_seconds, 62.25);
        assert_eq!(parsed[1].start_seconds, 3723.125);
        assert_eq!(parsed[1].end_seconds, 3725.5);
    }

    #[test]
    fn plain_transcript_falls_back_without_alignments() {
        let req = AsrRequest {
            audio_url: "https://example.com/audio.wav".to_string(),
            language: None,
            task: "transcribe".to_string(),
            backend: AsrBackend::Auto,
            diarize: false,
            max_tokens: 0,
        };
        let output =
            parse_transcript_output("A plain transcript.", &req).expect("plain transcript");
        assert_eq!(output.text, "A plain transcript.");
        assert!(output.duration_seconds.is_none());
        assert!(output.sentence_alignments.is_none());
    }

    #[test]
    fn selects_and_builds_supported_ocr_commands() {
        let installed = vec![
            INFINITY_OCR_FLASH_MODEL.to_string(),
            LIGHTON_OCR_MODEL.to_string(),
        ];
        assert_eq!(
            select_ocr_model(&installed),
            Some(OcrRuntimeModel::LightOn(LIGHTON_OCR_MODEL.to_string()))
        );

        let request = OcrRequest {
            image_url: "https://example.com/page.png".to_string(),
            max_tokens: 2048,
            temperature: 0.1,
        };
        assert_eq!(
            build_ocr_args(
                Path::new("/tmp/page.png"),
                &request,
                &OcrRuntimeModel::LightOn(LIGHTON_OCR_MODEL.to_string())
            ),
            vec![
                "vision",
                "ocr",
                "/tmp/page.png",
                "--backend",
                "lighton",
                "--model",
                LIGHTON_OCR_MODEL,
                "--max-tokens",
                "2048",
                "--temperature",
                "0.1",
                "--quiet"
            ]
        );
        assert_eq!(
            build_ocr_args(
                Path::new("/tmp/page.png"),
                &request,
                &OcrRuntimeModel::Infinity(INFINITY_OCR_FLASH_MODEL.to_string())
            ),
            vec![
                "vision",
                "ocr",
                "/tmp/page.png",
                "--backend",
                "infinity",
                "--infinity-model",
                INFINITY_OCR_FLASH_MODEL,
                "--infinity-task",
                "doc2md",
                "--max-tokens",
                "2048",
                "--temperature",
                "0.1",
                "--quiet"
            ]
        );
        assert!(select_ocr_model(&["vision-ocr-future".to_string()]).is_none());
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
