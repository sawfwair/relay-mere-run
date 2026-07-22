use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use tokio::process::Command;

use crate::mererun::resolve_mere_run_binary;
use crate::protocol::{PluginCapability, ToolRequest};

pub const PLUGIN_NAME: &str = "mere-run-subject-video";
const PREVIEW_COMMAND: &str = "preview_subject_masks";
const PREPARE_COMMAND: &str = "prepare_subject_masks";
const GENERATE_COMMAND: &str = "generate_subject_video";

pub fn capability() -> PluginCapability {
    PluginCapability {
        name: PLUGIN_NAME.to_string(),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        executable: None,
        description: Some("Native mere.run subject masking and motion transfer".to_string()),
        commands: vec![
            PREVIEW_COMMAND.to_string(),
            PREPARE_COMMAND.to_string(),
            GENERATE_COMMAND.to_string(),
        ],
        capabilities: vec![
            PREVIEW_COMMAND.to_string(),
            PREPARE_COMMAND.to_string(),
            GENERATE_COMMAND.to_string(),
            "vision-segment-sam31".to_string(),
            "video-scail2-14b-mlx".to_string(),
        ],
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MaskInputs {
    plan: Value,
    #[serde(default)]
    preview_frame: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubjectReference {
    image: String,
    mask: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SubjectVideoMode {
    Animation,
    Replacement,
}

impl SubjectVideoMode {
    fn cli_value(self) -> &'static str {
        match self {
            Self::Animation => "animation",
            Self::Replacement => "replacement",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RenderProfile {
    Fast,
    Quality,
}

impl RenderProfile {
    fn cli_value(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Quality => "quality",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Sampler {
    Euler,
    Unipc,
}

impl Sampler {
    fn cli_value(self) -> &'static str {
        match self {
            Self::Euler => "euler",
            Self::Unipc => "unipc",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
enum TailPolicy {
    #[serde(rename = "drop")]
    Drop,
    #[serde(rename = "pad-trim")]
    PadTrim,
}

impl TailPolicy {
    fn cli_value(self) -> &'static str {
        match self {
            Self::Drop => "drop",
            Self::PadTrim => "pad-trim",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AudioSource {
    None,
    Driving,
}

impl AudioSource {
    fn cli_value(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Driving => "driving",
        }
    }
}

fn default_profile() -> RenderProfile {
    RenderProfile::Fast
}

fn default_sampler() -> Sampler {
    Sampler::Euler
}

fn default_tail_policy() -> TailPolicy {
    TailPolicy::PadTrim
}

fn default_audio_source() -> AudioSource {
    AudioSource::Driving
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerateInputs {
    prompt: String,
    mode: SubjectVideoMode,
    references: Vec<SubjectReference>,
    driving_video: String,
    driving_mask: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default = "default_profile")]
    profile: RenderProfile,
    #[serde(default = "default_sampler")]
    sampler: Sampler,
    width: u32,
    height: u32,
    fps: u32,
    steps: u32,
    guidance_scale: f32,
    shift: f32,
    seed: i64,
    segment_length: u32,
    segment_overlap: u32,
    #[serde(default = "default_tail_policy")]
    tail_policy: TailPolicy,
    #[serde(default = "default_audio_source")]
    audio_source: AudioSource,
}

fn output_error(label: &str, output: &std::process::Output) -> anyhow::Error {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    anyhow!(
        "{label} failed: {}",
        if stderr.is_empty() { stdout } else { stderr }
    )
}

fn artifact_item(path: &Path, name: impl Into<String>, kind: &str, label: &str) -> Value {
    json!({
        "name": name.into(),
        "kind": kind,
        "label": label,
        "path": path.to_string_lossy(),
    })
}

fn sanitize_native_manifest(manifest: &mut Value) {
    let Some(object) = manifest.as_object_mut() else {
        return;
    };
    object.insert(
        "driving_source_path".to_string(),
        Value::String("relay-asset:driving-video".to_string()),
    );
    if let Some(subjects) = object.get_mut("subjects").and_then(Value::as_array_mut) {
        for subject in subjects {
            let Some(subject) = subject.as_object_mut() else {
                continue;
            };
            let id = subject
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("subject")
                .to_string();
            subject.insert(
                "reference_image_path".to_string(),
                Value::String(format!("relay-asset:reference:{id}")),
            );
        }
    }
    if let Some(corrections) = object.get_mut("corrections").and_then(Value::as_array_mut) {
        for correction in corrections {
            let Some(correction) = correction.as_object_mut() else {
                continue;
            };
            if correction
                .get("painted_mask_path")
                .is_some_and(|value| !value.is_null())
            {
                correction.insert(
                    "painted_mask_path".to_string(),
                    Value::String("relay-asset:painted-correction".to_string()),
                );
            }
        }
    }
}

fn preflight_status(report: &Value) -> Value {
    json!({
        "status": report.get("status").cloned().unwrap_or(Value::Null)
    })
}

fn manifest_artifacts(manifest: &Value, artifact_root: &Path) -> Result<Vec<Value>> {
    let mut items = vec![artifact_item(
        &artifact_root.join("manifest.json"),
        "manifest.json",
        "manifest",
        "Canonical mask manifest",
    )];
    let artifacts = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("native mask manifest has no artifacts array"))?;
    for artifact in artifacts {
        let relative = artifact
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("native mask manifest artifact has no path"))?;
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(anyhow!(
                "native mask manifest artifact escapes its output directory: {relative}"
            ));
        }
        let path = artifact_root.join(relative_path);
        if !path.is_file() {
            return Err(anyhow!(
                "native mask manifest artifact is missing: {relative}"
            ));
        }
        let name = relative
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let mut item = artifact_item(
            &path,
            name,
            artifact
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("mask_artifact"),
            relative,
        );
        if let Some(object) = item.as_object_mut() {
            if let Some(sha256) = artifact.get("sha256").and_then(Value::as_str) {
                object.insert("sha256".to_string(), Value::String(sha256.to_string()));
            }
            if let Some(byte_count) = artifact.get("byte_count").and_then(Value::as_u64) {
                object.insert("bytes".to_string(), Value::Number(byte_count.into()));
            }
        }
        items.push(item);
    }
    Ok(items)
}

async fn run_masks(request: &ToolRequest, output_dir: &Path, preview: bool) -> Result<Value> {
    let inputs = serde_json::from_value::<MaskInputs>(request.inputs.clone())
        .context("invalid native mask inputs")?;
    if preview != inputs.preview_frame.is_some() {
        return Err(anyhow!(
            "{} requires {}preview_frame",
            request.command,
            if preview { "a " } else { "no " }
        ));
    }
    let plan_path = output_dir.join("mask-plan.json");
    tokio::fs::write(&plan_path, serde_json::to_vec_pretty(&inputs.plan)?).await?;
    let artifact_root = output_dir.join("artifacts");
    let binary = resolve_mere_run_binary().await;
    let base_args = vec![
        "video".to_string(),
        "prepare-masks".to_string(),
        "--plan".to_string(),
        plan_path.to_string_lossy().to_string(),
        "--output-dir".to_string(),
        artifact_root.to_string_lossy().to_string(),
    ];
    let mut preflight_args = base_args.clone();
    if let Some(frame) = inputs.preview_frame {
        preflight_args.extend(["--preview-frame".to_string(), frame.to_string()]);
    }
    preflight_args.extend(["--preflight".to_string(), "--json".to_string()]);
    let preflight = Command::new(&binary)
        .args(&preflight_args)
        .kill_on_drop(true)
        .output()
        .await?;
    if !preflight.status.success() {
        return Err(output_error(
            "mere.run video prepare-masks preflight",
            &preflight,
        ));
    }
    let report: Value = serde_json::from_slice(&preflight.stdout)
        .context("mere.run mask preflight returned invalid JSON")?;
    if report.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(anyhow!("mere.run mask preflight blocked: {report}"));
    }

    let mut args = base_args;
    if let Some(frame) = inputs.preview_frame {
        args.extend(["--preview-frame".to_string(), frame.to_string()]);
    }
    args.extend(["--json".to_string(), "--quiet".to_string()]);
    let output = Command::new(binary)
        .args(&args)
        .kill_on_drop(true)
        .output()
        .await?;
    if !output.status.success() {
        return Err(output_error("mere.run video prepare-masks", &output));
    }
    let result: Value = serde_json::from_slice(&output.stdout)
        .context("mere.run mask preparation returned invalid JSON")?;
    let manifest_path = result
        .get("manifest_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| artifact_root.join("manifest.json"));
    let mut manifest: Value = serde_json::from_slice(&tokio::fs::read(&manifest_path).await?)?;
    sanitize_native_manifest(&mut manifest);
    tokio::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
    let artifacts = manifest_artifacts(&manifest, &artifact_root)?;
    Ok(json!({
        "schema": "mere.run.subject-video-tool.v1",
        "tool": {
            "plugin": PLUGIN_NAME,
            "command": request.command,
            "status": result.get("status").cloned().unwrap_or(Value::Null),
        },
        "native_manifest": manifest,
        "preflight": preflight_status(&report),
        "artifacts": { "items": artifacts },
    }))
}

async fn run_generate(request: &ToolRequest, output_dir: &Path) -> Result<Value> {
    let inputs = serde_json::from_value::<GenerateInputs>(request.inputs.clone())
        .context("invalid native subject-video inputs")?;
    let output_path = output_dir.join("subject-video.mp4");
    let args = generate_args(&inputs, &output_path)?;
    let binary = resolve_mere_run_binary().await;

    let mut preflight_args = args.clone();
    preflight_args.extend(["--preflight".to_string(), "--json".to_string()]);
    let preflight = Command::new(&binary)
        .args(&preflight_args)
        .kill_on_drop(true)
        .output()
        .await?;
    if !preflight.status.success() {
        return Err(output_error("mere.run video animate preflight", &preflight));
    }
    let report: Value = serde_json::from_slice(&preflight.stdout)
        .context("mere.run animate preflight returned invalid JSON")?;
    if report.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(anyhow!("mere.run animate preflight blocked: {report}"));
    }

    let mut execution_args = args;
    execution_args.push("--quiet".to_string());
    let output = Command::new(binary)
        .args(&execution_args)
        .kill_on_drop(true)
        .output()
        .await?;
    if !output.status.success() {
        return Err(output_error("mere.run video animate", &output));
    }
    if !output_path.is_file() {
        return Err(anyhow!(
            "mere.run animate completed without subject-video.mp4"
        ));
    }
    Ok(json!({
        "schema": "mere.run.subject-video-tool.v1",
        "tool": {
            "plugin": PLUGIN_NAME,
            "command": request.command,
            "status": "succeeded",
        },
        "preflight": preflight_status(&report),
        "artifacts": {
            "items": [artifact_item(&output_path, "subject-video.mp4", "video", "Subject video")]
        },
    }))
}

fn generate_args(inputs: &GenerateInputs, output_path: &Path) -> Result<Vec<String>> {
    if inputs.references.is_empty() || inputs.references.len() > 6 {
        return Err(anyhow!(
            "generate_subject_video requires one to six references"
        ));
    }
    if inputs.tail_policy != TailPolicy::PadTrim || inputs.audio_source != AudioSource::Driving {
        return Err(anyhow!(
            "generate_subject_video requires tail_policy pad-trim and audio_source driving"
        ));
    }
    let first = &inputs.references[0];
    let mut args = vec![
        "video".to_string(),
        "animate".to_string(),
        inputs.prompt.clone(),
        "--reference".to_string(),
        first.image.clone(),
        "--reference-mask".to_string(),
        first.mask.clone(),
        "--driving-video".to_string(),
        inputs.driving_video.clone(),
        "--driving-mask".to_string(),
        inputs.driving_mask.clone(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
        "--mode".to_string(),
        inputs.mode.cli_value().to_string(),
        "--profile".to_string(),
        inputs.profile.cli_value().to_string(),
        "--width".to_string(),
        inputs.width.to_string(),
        "--height".to_string(),
        inputs.height.to_string(),
        "--fps".to_string(),
        inputs.fps.to_string(),
        "--steps".to_string(),
        inputs.steps.to_string(),
        "--guidance-scale".to_string(),
        inputs.guidance_scale.to_string(),
        "--shift".to_string(),
        inputs.shift.to_string(),
        "--sampler".to_string(),
        inputs.sampler.cli_value().to_string(),
        "--seed".to_string(),
        inputs.seed.to_string(),
        "--segment-length".to_string(),
        inputs.segment_length.to_string(),
        "--segment-overlap".to_string(),
        inputs.segment_overlap.to_string(),
        "--tail-policy".to_string(),
        inputs.tail_policy.cli_value().to_string(),
        "--audio-source".to_string(),
        inputs.audio_source.cli_value().to_string(),
    ];
    if let Some(model) = inputs
        .model
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        args.extend(["--model".to_string(), model.clone()]);
    }
    for reference in inputs.references.iter().skip(1) {
        args.extend([
            "--additional-reference".to_string(),
            reference.image.clone(),
        ]);
        args.extend([
            "--additional-reference-mask".to_string(),
            reference.mask.clone(),
        ]);
    }

    Ok(args)
}

pub async fn run(request: &ToolRequest, output_dir: &Path, _tool_id: &str) -> Result<Value> {
    match request.command.as_str() {
        PREVIEW_COMMAND => run_masks(request, output_dir, true).await,
        PREPARE_COMMAND => run_masks(request, output_dir, false).await,
        GENERATE_COMMAND => run_generate(request, output_dir).await,
        other => Err(anyhow!("unsupported native subject-video command: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_advertises_exact_subject_video_actions() {
        let capability = capability();
        assert_eq!(capability.name, PLUGIN_NAME);
        assert_eq!(
            capability.commands,
            vec![PREVIEW_COMMAND, PREPARE_COMMAND, GENERATE_COMMAND]
        );
        assert!(capability.executable.is_none());
    }

    #[test]
    fn generation_inputs_reject_untyped_fields() {
        let value = json!({
            "prompt": "subject",
            "mode": "replacement",
            "references": [{ "image": "/tmp/ref.png", "mask": "/tmp/mask.png" }],
            "driving_video": "/tmp/driver.mov",
            "driving_mask": "/tmp/driver-mask.mov",
            "width": 832,
            "height": 480,
            "fps": 16,
            "steps": 4,
            "guidance_scale": 1,
            "shift": 5,
            "seed": 42,
            "segment_length": 81,
            "segment_overlap": 5,
            "unexpected": true
        });
        assert!(serde_json::from_value::<GenerateInputs>(value).is_err());
    }

    #[test]
    fn generation_command_is_exact_and_preserves_reference_order() {
        let inputs = serde_json::from_value::<GenerateInputs>(json!({
            "prompt": "large puppet follows the dancer",
            "mode": "replacement",
            "references": [
                { "image": "/inputs/ref-a.png", "mask": "/inputs/mask-a.png" },
                { "image": "/inputs/ref-b.png", "mask": "/inputs/mask-b.png" }
            ],
            "driving_video": "/inputs/driver.mov",
            "driving_mask": "/inputs/driver-mask.mov",
            "model": "video-scail2-14b-mlx",
            "width": 832,
            "height": 480,
            "fps": 16,
            "steps": 4,
            "guidance_scale": 1,
            "shift": 5,
            "seed": 42,
            "segment_length": 81,
            "segment_overlap": 5
        }))
        .expect("typed inputs");
        let args =
            generate_args(&inputs, Path::new("/outputs/subject-video.mp4")).expect("command");
        let expected = [
            "video",
            "animate",
            "large puppet follows the dancer",
            "--reference",
            "/inputs/ref-a.png",
            "--reference-mask",
            "/inputs/mask-a.png",
            "--driving-video",
            "/inputs/driver.mov",
            "--driving-mask",
            "/inputs/driver-mask.mov",
            "--output",
            "/outputs/subject-video.mp4",
            "--mode",
            "replacement",
            "--profile",
            "fast",
            "--width",
            "832",
            "--height",
            "480",
            "--fps",
            "16",
            "--steps",
            "4",
            "--guidance-scale",
            "1",
            "--shift",
            "5",
            "--sampler",
            "euler",
            "--seed",
            "42",
            "--segment-length",
            "81",
            "--segment-overlap",
            "5",
            "--tail-policy",
            "pad-trim",
            "--audio-source",
            "driving",
            "--model",
            "video-scail2-14b-mlx",
            "--additional-reference",
            "/inputs/ref-b.png",
            "--additional-reference-mask",
            "/inputs/mask-b.png",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        assert_eq!(args, expected);
    }

    #[test]
    fn generation_rejects_non_animatic_duration_and_audio_policies() {
        let inputs = serde_json::from_value::<GenerateInputs>(json!({
            "prompt": "subject",
            "mode": "animation",
            "references": [{ "image": "/ref.png", "mask": "/mask.png" }],
            "driving_video": "/driver.mov",
            "driving_mask": "/driver-mask.mov",
            "width": 832,
            "height": 480,
            "fps": 16,
            "steps": 4,
            "guidance_scale": 1,
            "shift": 5,
            "seed": 42,
            "segment_length": 81,
            "segment_overlap": 5,
            "tail_policy": "drop",
            "audio_source": "none"
        }))
        .expect("typed inputs");
        let error = generate_args(&inputs, Path::new("/out.mp4")).expect_err("policy");
        assert!(error.to_string().contains("pad-trim"));
    }

    #[test]
    fn outbound_manifest_redacts_materialized_input_paths() {
        let mut manifest = json!({
            "driving_source_path": "/tmp/tools/job/inputs/driver.mov",
            "subjects": [{
                "id": "performer",
                "reference_image_path": "/tmp/tools/job/inputs/reference.png",
                "reference_mask_path": "references/performer-mask.png"
            }],
            "corrections": [{
                "painted_mask_path": "/tmp/tools/job/inputs/correction.png"
            }]
        });
        sanitize_native_manifest(&mut manifest);
        assert_eq!(manifest["driving_source_path"], "relay-asset:driving-video");
        assert_eq!(
            manifest["subjects"][0]["reference_image_path"],
            "relay-asset:reference:performer"
        );
        assert_eq!(
            manifest["subjects"][0]["reference_mask_path"],
            "references/performer-mask.png"
        );
        assert_eq!(
            manifest["corrections"][0]["painted_mask_path"],
            "relay-asset:painted-correction"
        );
    }
}
