//! Wire protocol for the mere.run relay device agent.
//!
//! Mirrors `relay-mere-run/src/types.ts` (the broker side). The node connects to
//! `wss://relay.mere.run/agent` with an `Authorization: Bearer <token>` header,
//! sends an `auth` message, then services `job` messages.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Capabilities advertised to the relay on connect.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub models: Vec<String>,
    pub max_resolution: u32,
    pub controlnet: bool,
    pub lora: bool,
    pub img2img: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<PluginCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_worker: Option<GraphWorkerCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asr_streaming: Option<AsrStreamingCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AsrStreamingCapabilities {
    pub protocols: Vec<u32>,
    pub input_formats: Vec<String>,
    pub max_sessions: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backends: Vec<AsrBackend>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AsrBackend {
    #[default]
    Auto,
    Parakeet,
    Qwen,
}

impl AsrBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Parakeet => "parakeet",
            Self::Qwen => "qwen",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphWorkerCapabilities {
    pub schema_version: u32,
    pub worker_version: String,
    pub contract_versions: Vec<String>,
    pub platform: String,
    pub architecture: String,
    pub accelerator_backend: String,
    pub memory_bytes: u64,
    #[serde(default)]
    pub system_memory_bytes: u64,
    #[serde(default)]
    pub logical_cpu_cores: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_disk_bytes: Option<i64>,
    #[serde(default)]
    pub network_access: bool,
    pub node_kinds: Vec<String>,
    pub installed_model_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_secret_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cached_asset_digests: Vec<String>,
    #[serde(default)]
    pub providers: Vec<GraphProviderCapability>,
    /// The authoritative `mere.run graph catalog --json` command document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphProviderCapability {
    pub id: String,
    pub version: String,
    pub catalog_sha256: String,
    pub node_kinds: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphBundleFile {
    pub path: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRunArtifact {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphExecutionMetrics {
    pub bundle_bytes_downloaded: u64,
    pub download_ms: u64,
    pub execution_ms: u64,
    pub upload_ms: u64,
    pub total_ms: u64,
    pub artifact_bytes_uploaded: u64,
    pub artifact_parts_uploaded: u64,
    pub artifact_bytes_reused: u64,
    pub artifact_parts_reused: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPlanApplyResult {
    pub model_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAcceleratorInfo {
    pub backend: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSystemInfo {
    pub platform: String,
    pub architecture: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_cores: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_total_bytes: Option<u64>,
    #[serde(default)]
    pub accelerators: Vec<AgentAcceleratorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mere_run_version: Option<String>,
    #[serde(default)]
    pub installed_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_status: Option<ModelInventoryStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<RuntimeDiagnostic>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelInventoryStatus {
    Reported,
    Empty,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDiagnostic {
    MereRunNotFound,
    VersionCommandUnavailable,
    VersionCommandFailed,
    VersionOutputEmpty,
    InventoryCommandsFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapacity {
    pub max_concurrent_jobs: u32,
    #[serde(default)]
    pub lease_protocol: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTelemetry {
    pub sampled_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_load_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_available_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accelerator_utilization_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accelerator_memory_used_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accelerator_memory_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low_power_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thermal_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCapability {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolInputAsset {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolRequest {
    pub plugin: String,
    pub command: String,
    #[serde(default)]
    pub inputs: Value,
    #[serde(default)]
    pub options: Value,
    #[serde(default)]
    pub assets: Vec<ToolInputAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolArtifact {
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "content_type", alias = "contentType")]
    pub content_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Messages the agent sends to the relay (Agent -> Relay).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Auth {
        device_id: String,
        device_name: String,
        version: String,
        capabilities: AgentCapabilities,
        system: AgentSystemInfo,
        runtime: AgentRuntimeInfo,
        capacity: AgentCapacity,
        #[serde(skip_serializing_if = "Option::is_none")]
        availability: Option<AgentAvailability>,
    },
    InventoryUpdate {
        capabilities: AgentCapabilities,
        system: AgentSystemInfo,
        runtime: AgentRuntimeInfo,
        capacity: AgentCapacity,
    },
    AvailabilityUpdate {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_job_id: Option<String>,
        source: String,
    },
    Progress {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        lease_id: Option<String>,
        step: u32,
        total_steps: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview_base64: Option<String>,
    },
    Result {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        lease_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        image_data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        seed: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        generation_time_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    ToolProgress {
        tool_id: String,
        step: u32,
        total_steps: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    ToolResult {
        tool_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        artifacts: Vec<ToolArtifact>,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_manifest: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<Value>,
    },
    ToolError {
        tool_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        error: String,
    },
    GraphEvent {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        event: Value,
    },
    GraphResult {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        run_manifest: Value,
        artifacts: Vec<GraphRunArtifact>,
        metrics: GraphExecutionMetrics,
    },
    GraphError {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        error: String,
    },
    ModelPlanEvent {
        plan_id: String,
        attempt: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_id: Option<String>,
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    ModelPlanResult {
        plan_id: String,
        attempt: u32,
        results: Vec<ModelPlanApplyResult>,
        installed_model_ids: Vec<String>,
    },
    ChatResponse {
        chat_id: String,
        response: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_generated: Option<u32>,
    },
    ChatError {
        chat_id: String,
        error: String,
    },
    TalkResponse {
        talk_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        audio_data: Option<String>,
        duration_seconds: f64,
        sample_rate: u32,
        output_format: String,
    },
    TalkError {
        talk_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        error: String,
    },
    AsrResponse {
        asr_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        token_alignments: Option<Vec<AsrTokenAlignment>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sentence_alignments: Option<Vec<AsrSentenceAlignment>>,
    },
    AsrError {
        asr_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        error: String,
    },
    OcrResponse {
        ocr_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_generated: Option<u32>,
    },
    OcrError {
        ocr_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        error: String,
    },
    AsrStreamEvent {
        session_id: String,
        event: Value,
    },
    EmbedResponse {
        embed_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dimensions: Option<usize>,
        data: Vec<EmbedDataRow>,
    },
    EmbedError {
        embed_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        owner_user_id: Option<String>,
        error: String,
    },
    Ping {
        timestamp_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        telemetry: Option<AgentTelemetry>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentAvailability {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_job_id: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Image,
    Music,
    Video,
}

fn default_job_kind() -> JobKind {
    JobKind::Image
}

/// Generation request parameters (relay `JobRequest`).
#[derive(Debug, Clone, Deserialize)]
pub struct JobRequest {
    #[serde(default = "default_job_kind")]
    pub kind: JobKind,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub steps: u32,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub input_image_url: Option<String>,
    #[serde(default)]
    pub input_image_data: Option<String>,
    #[serde(default)]
    pub input_strength: Option<f32>,
    /// Identity-locking reference images (character refs), passed as --ref-image.
    #[serde(default)]
    pub reference_image_urls: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub num_frames: Option<u32>,
    #[serde(default)]
    pub lyrics: Option<String>,
    /// Source audio for native audio-to-video lanes (LTX 2.3 A2Vid).
    #[serde(default)]
    pub input_audio_url: Option<String>,
    #[serde(default)]
    pub audio_start_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub image_url: Option<String>,
}

/// Text chat request parameters (relay `ChatRequestMessage`).
#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub requires_json: Option<bool>,
    #[serde(default)]
    pub use_lora: Option<bool>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Speech synthesis request parameters (relay `TalkRequest`).
#[derive(Debug, Clone, Deserialize)]
pub struct TalkRequest {
    pub text: String,
    #[serde(default)]
    pub voice_description: Option<String>,
    #[serde(default = "default_talk_speed")]
    pub speed: f32,
    #[serde(default = "default_talk_temperature")]
    pub temperature: f32,
    #[serde(default = "default_talk_output_format")]
    pub output_format: String,
}

fn default_talk_speed() -> f32 {
    1.0
}

fn default_talk_temperature() -> f32 {
    0.6
}

fn default_talk_output_format() -> String {
    "wav".to_string()
}

/// Talk-specific relay messages are decoded separately from the legacy
/// generation dispatcher so adding the modality does not grow its match loop.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TalkServerMessage {
    TalkRequest {
        talk_id: String,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        upload_url: String,
        #[serde(default)]
        direct_audio: bool,
        request: TalkRequest,
    },
    TalkCancel {
        talk_id: String,
    },
    #[serde(other)]
    Other,
}

/// OCR request parameters (relay `OcrRequest`).
#[derive(Debug, Clone, Deserialize)]
pub struct OcrRequest {
    pub image_url: String,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: f32,
}

/// OCR-specific relay messages stay outside the legacy generation dispatcher.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OcrServerMessage {
    OcrRequest {
        ocr_id: String,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        request: OcrRequest,
    },
    OcrCancel {
        ocr_id: String,
    },
    #[serde(other)]
    Other,
}

/// Speech transcription request parameters (relay `AsrRequest`).
#[derive(Debug, Clone, Deserialize)]
pub struct AsrRequest {
    pub audio_url: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default = "default_asr_task")]
    pub task: String,
    #[serde(default)]
    pub backend: AsrBackend,
    #[serde(default)]
    pub max_tokens: u32,
}

fn default_asr_task() -> String {
    "transcribe".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrTokenAlignment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    pub text: String,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrSentenceAlignment {
    pub text: String,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub end_seconds: f64,
    pub tokens: Vec<AsrTokenAlignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrOutput {
    pub text: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub token_alignments: Option<Vec<AsrTokenAlignment>>,
    #[serde(default)]
    pub sentence_alignments: Option<Vec<AsrSentenceAlignment>>,
}

/// Text embedding request parameters (relay `EmbedRequest`).
#[derive(Debug, Clone, Deserialize)]
pub struct EmbedRequest {
    pub texts: Vec<String>,
    pub model: String,
    #[serde(default)]
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedDataRow {
    pub index: usize,
    pub embedding: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbedOutput {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub dimensions: Option<usize>,
    pub data: Vec<EmbedDataRow>,
}

/// Messages the relay sends to the agent (Relay -> Agent).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    AuthResult {
        success: bool,
        agent_id: String,
        user_id: String,
        #[serde(default)]
        error: Option<String>,
    },
    Job {
        job_id: String,
        #[serde(default)]
        lease_id: Option<String>,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        upload_url: String,
        #[serde(default)]
        direct_image: bool,
        request: JobRequest,
    },
    ChatRequest {
        chat_id: String,
        #[serde(default)]
        client_id: String,
        #[serde(flatten)]
        request: ChatRequest,
    },
    AsrRequest {
        asr_id: String,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        request: AsrRequest,
    },
    EmbedRequest {
        embed_id: String,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        request: EmbedRequest,
    },
    ToolRequest {
        tool_id: String,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        upload_url_base: String,
        request: ToolRequest,
    },
    GraphRequest {
        job_id: String,
        #[serde(default)]
        client_id: String,
        owner_user_id: String,
        bundle_files: Vec<GraphBundleFile>,
        upload_url_base: String,
    },
    Cancel {
        job_id: String,
    },
    AsrCancel {
        asr_id: String,
    },
    AsrStreamStart {
        session_id: String,
        protocol: u32,
        sample_rate: u32,
        input_format: String,
        #[serde(default)]
        backend: AsrBackend,
        #[serde(default)]
        language: Option<String>,
    },
    AsrStreamStop {
        session_id: String,
    },
    AsrStreamCancel {
        session_id: String,
    },
    EmbedCancel {
        embed_id: String,
    },
    ToolCancel {
        tool_id: String,
    },
    GraphCancel {
        job_id: String,
    },
    ModelPlanRequest {
        plan_id: String,
        attempt: u32,
        model_ids: Vec<String>,
        #[serde(default)]
        accept_model_licenses: bool,
    },
    ModelPlanCancel {
        plan_id: String,
    },
    InventoryRequest,
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod inventory_tests {
    use super::*;

    #[test]
    fn decodes_inventory_request() {
        let message: ServerMessage = serde_json::from_str(r#"{"type":"inventory_request"}"#)
            .expect("inventory request should decode");
        assert!(matches!(message, ServerMessage::InventoryRequest));
    }

    #[test]
    fn encodes_inventory_update() {
        let message = AgentMessage::InventoryUpdate {
            capabilities: AgentCapabilities {
                models: vec!["image-krea2-raw".to_string()],
                max_resolution: 2048,
                controlnet: false,
                lora: true,
                img2img: true,
                plugins: vec![],
                graph_worker: None,
                asr_streaming: None,
            },
            system: AgentSystemInfo {
                platform: "linux".to_string(),
                architecture: "x86_64".to_string(),
                os_version: None,
                hostname: None,
                cpu_model: None,
                logical_cores: None,
                memory_total_bytes: None,
                accelerators: vec![],
            },
            runtime: AgentRuntimeInfo {
                mere_run_version: Some("0.21.0".to_string()),
                installed_models: vec!["image-krea2-raw".to_string()],
                inventory_status: Some(ModelInventoryStatus::Reported),
                diagnostic: Some(RuntimeDiagnostic::VersionCommandFailed),
            },
            capacity: AgentCapacity {
                max_concurrent_jobs: 1,
                lease_protocol: true,
            },
        };
        let value = serde_json::to_value(message).expect("inventory update should encode");
        assert_eq!(value["type"], "inventory_update");
        assert_eq!(value["runtime"]["installed_models"][0], "image-krea2-raw");
        assert_eq!(value["runtime"]["inventory_status"], "reported");
        assert_eq!(value["runtime"]["diagnostic"], "version_command_failed");
    }

    #[test]
    fn decodes_talk_request_and_cancel() {
        let message: TalkServerMessage = serde_json::from_str(
            r#"{
              "type": "talk_request",
              "talk_id": "talk_123",
              "client_id": "client_123",
              "owner_user_id": "user_123",
              "upload_url": "https://relay.example/api/audio-upload/user_123/talk_123",
              "direct_audio": false,
              "request": {
                "text": "Hello from mere.run.",
                "voice_description": "A warm narrator",
                "speed": 1.0,
                "temperature": 0.5,
                "output_format": "wav"
              }
            }"#,
        )
        .expect("talk request should decode");
        match message {
            TalkServerMessage::TalkRequest {
                talk_id,
                request,
                direct_audio,
                ..
            } => {
                assert_eq!(talk_id, "talk_123");
                assert_eq!(request.text, "Hello from mere.run.");
                assert_eq!(
                    request.voice_description.as_deref(),
                    Some("A warm narrator")
                );
                assert_eq!(request.speed, 1.0);
                assert_eq!(request.temperature, 0.5);
                assert_eq!(request.output_format, "wav");
                assert!(!direct_audio);
            }
            _ => panic!("expected talk request"),
        }

        let cancel: TalkServerMessage =
            serde_json::from_str(r#"{"type":"talk_cancel","talk_id":"talk_123"}"#)
                .expect("talk cancel should decode");
        assert!(matches!(
            cancel,
            TalkServerMessage::TalkCancel { talk_id } if talk_id == "talk_123"
        ));
    }

    #[test]
    fn encodes_talk_response_contract() {
        let message = AgentMessage::TalkResponse {
            talk_id: "talk_123".to_string(),
            owner_user_id: Some("user_123".to_string()),
            audio_url: Some("https://assets.example/talk.wav".to_string()),
            audio_data: None,
            duration_seconds: 1.25,
            sample_rate: 24_000,
            output_format: "wav".to_string(),
        };
        let value = serde_json::to_value(message).expect("talk response JSON");
        assert_eq!(value["type"], "talk_response");
        assert_eq!(value["talk_id"], "talk_123");
        assert_eq!(value["owner_user_id"], "user_123");
        assert_eq!(value["sample_rate"], 24_000);
        assert_eq!(value["output_format"], "wav");
        assert!(value.get("audio_data").is_none());
    }

    #[test]
    fn decodes_ocr_request_and_cancel() {
        let message: OcrServerMessage = serde_json::from_str(
            r#"{
              "type": "ocr_request",
              "ocr_id": "ocr_123",
              "client_id": "client_123",
              "owner_user_id": "user_123",
              "request": {
                "image_url": "https://assets.example/page.png",
                "max_tokens": 2048,
                "temperature": 0.1
              }
            }"#,
        )
        .expect("OCR request should decode");
        match message {
            OcrServerMessage::OcrRequest {
                ocr_id, request, ..
            } => {
                assert_eq!(ocr_id, "ocr_123");
                assert_eq!(request.image_url, "https://assets.example/page.png");
                assert_eq!(request.max_tokens, 2048);
                assert_eq!(request.temperature, 0.1);
            }
            _ => panic!("expected OCR request"),
        }

        let cancel: OcrServerMessage =
            serde_json::from_str(r#"{"type":"ocr_cancel","ocr_id":"ocr_123"}"#)
                .expect("OCR cancel should decode");
        assert!(matches!(
            cancel,
            OcrServerMessage::OcrCancel { ocr_id } if ocr_id == "ocr_123"
        ));
    }

    #[test]
    fn encodes_ocr_response_contract() {
        let message = AgentMessage::OcrResponse {
            ocr_id: "ocr_123".to_string(),
            owner_user_id: Some("user_123".to_string()),
            text: "Invoice total: $42.00".to_string(),
            tokens_generated: Some(8),
        };
        let value = serde_json::to_value(message).expect("OCR response JSON");
        assert_eq!(value["type"], "ocr_response");
        assert_eq!(value["ocr_id"], "ocr_123");
        assert_eq!(value["owner_user_id"], "user_123");
        assert_eq!(value["text"], "Invoice total: $42.00");
        assert_eq!(value["tokens_generated"], 8);
    }
}

#[cfg(test)]
mod contract_fixture_tests {
    use serde::Deserialize;
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    #[derive(Deserialize)]
    struct CompatibilityFixture {
        kind: String,
        canonical_fixture: CanonicalFixture,
    }

    #[derive(Deserialize)]
    struct CanonicalFixture {
        graph_fingerprint: String,
        input_fingerprint: String,
        execution_order: Vec<String>,
    }

    fn canonical_json(value: &Value) -> String {
        match value {
            Value::Null => "null".to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            Value::String(value) => serde_json::to_string(value).expect("string should encode"),
            Value::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Value::Object(values) => {
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort();
                format!(
                    "{{{}}}",
                    keys.into_iter()
                        .map(|key| format!(
                            "{}:{}",
                            serde_json::to_string(key).expect("key should encode"),
                            canonical_json(&values[key])
                        ))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
        }
    }

    fn sha256(value: &Value) -> String {
        format!("{:x}", Sha256::digest(canonical_json(value).as_bytes()))
    }

    #[test]
    fn matches_cross_runtime_graph_fingerprints() {
        let compatibility: CompatibilityFixture = serde_json::from_str(include_str!(
            "../../../test/fixtures/graph-v1/graph-compatibility.v1.json"
        ))
        .expect("compatibility fixture should decode");
        let graph: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/graph-v1/parallel-image-video.workflow.json"
        ))
        .expect("graph fixture should decode");
        let inputs: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/graph-v1/parallel-image-video.inputs.json"
        ))
        .expect("inputs fixture should decode");
        let assets: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/graph-v1/parallel-image-video.assets.json"
        ))
        .expect("assets fixture should decode");
        let portable_inputs = serde_json::json!({"inputs": inputs, "assets": assets});
        let node_ids = graph["nodes"]
            .as_array()
            .expect("nodes should be an array")
            .iter()
            .map(|node| {
                node["id"]
                    .as_str()
                    .expect("node id should be a string")
                    .to_string()
            })
            .collect::<Vec<_>>();

        assert_eq!(compatibility.kind, "mere.run/graph-compatibility");
        assert_eq!(node_ids, compatibility.canonical_fixture.execution_order);
        assert_eq!(
            sha256(&graph),
            compatibility.canonical_fixture.graph_fingerprint
        );
        assert_eq!(
            sha256(&portable_inputs),
            compatibility.canonical_fixture.input_fingerprint
        );
    }
}
