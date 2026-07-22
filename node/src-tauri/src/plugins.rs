use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::watch;

use crate::protocol::{PluginCapability, ToolArtifact, ToolRequest};

const NODE_EXECUTABLE_NAMES: &[&str] = &["mere.run-node", "mere-run-node"];

struct ManagedCapabilityPack {
    id: &'static str,
    plugin_id: &'static str,
    title: &'static str,
    description: &'static str,
    required_commands: &'static [&'static str],
    repair_spec: Option<&'static str>,
    installable: bool,
}

const MANAGED_CAPABILITY_PACKS: &[ManagedCapabilityPack] = &[
    ManagedCapabilityPack {
        id: "animatic-tools",
        plugin_id: "mere-animatic-tools",
        title: "Animatic tools",
        description: "Production prep, story, world, performance, finishing, and deterministic USD set bundles.",
        required_commands: &[
            "character-knockout",
            "reference-pack",
            "continuity-check",
            "shot-kit",
            "storyboard-repair",
            "edit-doctor",
            "actor-voice-kit",
            "location-plates",
            "style-lock",
            "delivery-prep",
            "build-set-proxy",
        ],
        repair_spec: Some(
            "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-animatic-tools",
        ),
        installable: true,
    },
    ManagedCapabilityPack {
        id: "blender-sets",
        plugin_id: "mere-animatic-tools",
        title: "Blender sets",
        description: "Local lighting solves, editable .blend scenes, and per-camera set plates.",
        required_commands: &["solve-set-lighting", "render-set-plate"],
        repair_spec: Some(
            "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-animatic-tools",
        ),
        installable: true,
    },
    ManagedCapabilityPack {
        id: "mere-vfx-tools",
        plugin_id: "mere-vfx-tools",
        title: "VFX",
        description: "Roto, tracking, keying, cleanup, depth, relighting, geometry, and 3D reconstruction.",
        required_commands: &[
            "roto",
            "matte-refine",
            "track-export",
            "key",
            "shot-qc",
            "inbetween",
            "turntable",
            "character-sheet",
            "pose-sequence",
            "motion-pass",
            "clean-plate",
            "set-extension",
            "restore",
            "depth-normal",
            "relight",
            "video-depth",
            "multiview-geometry",
            "image-to-3d",
            "multiview-image-to-3d",
        ],
        repair_spec: Some(
            "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-vfx-tools",
        ),
        installable: true,
    },
    ManagedCapabilityPack {
        id: crate::native_video::PLUGIN_NAME,
        plugin_id: crate::native_video::PLUGIN_NAME,
        title: "Subject video",
        description: "Native mask preparation and SCAIL-2 motion transfer.",
        required_commands: &[
            "preview_subject_masks",
            "prepare_subject_masks",
            "generate_subject_video",
        ],
        repair_spec: None,
        installable: false,
    },
];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityPack {
    id: String,
    title: String,
    description: String,
    version: Option<String>,
    installed: bool,
    ready: bool,
    installable: bool,
    commands: Vec<String>,
    missing_commands: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ManifestCommand {
    name: String,
}

#[derive(Debug, Deserialize)]
struct PluginManifest {
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    commands: Vec<ManifestCommand>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PluginDoctor {
    #[serde(default)]
    checks: Vec<PluginDoctorCheck>,
}

#[derive(Debug, Deserialize)]
struct PluginDoctorCheck {
    name: String,
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct UploadResponse {
    #[serde(default)]
    url: String,
    #[serde(default)]
    media_url: String,
}

#[derive(Debug)]
pub struct ToolRunOutput {
    pub artifacts: Vec<ToolArtifact>,
    pub run_manifest: Value,
    pub summary: Option<Value>,
}

pub enum ToolRunOutcome {
    Completed(ToolRunOutput),
    Canceled,
}

struct ToolWorkspace {
    path: PathBuf,
}

impl Drop for ToolWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

fn executable_candidates_in(
    dirs: impl IntoIterator<Item = PathBuf>,
    current_executable: Option<&Path>,
) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut candidates = Vec::new();
    let current_executable = current_executable.and_then(|path| path.canonicalize().ok());

    for dir in dirs {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let managed_companion = MANAGED_CAPABILITY_PACKS
                .iter()
                .any(|pack| pack.installable && pack.plugin_id == name);
            if NODE_EXECUTABLE_NAMES.contains(&name) || !managed_companion {
                continue;
            }
            if !path.is_file() {
                continue;
            }
            if current_executable.as_ref().is_some_and(|current| {
                path.canonicalize()
                    .is_ok_and(|candidate| candidate == *current)
            }) {
                continue;
            }
            if seen.insert(name.to_string()) {
                candidates.push(path);
            }
        }
    }
    candidates
}

fn executable_candidates() -> Vec<PathBuf> {
    let current_executable = std::env::current_exe().ok();
    executable_candidates_in(path_dirs(), current_executable.as_deref())
}

async fn manifest_for(path: &Path) -> Option<PluginCapability> {
    let output = tokio::time::timeout(
        Duration::from_secs(3),
        Command::new(path)
            .args(["manifest", "--json"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut manifest = serde_json::from_slice::<PluginManifest>(&output.stdout).ok()?;
    if manifest.name.trim().is_empty() {
        return None;
    }
    if manifest.name == "mere-animatic-tools" {
        let blender_ready = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(path).arg("doctor").kill_on_drop(true).output(),
        )
        .await
        .ok()
        .and_then(|output| output.ok())
        .filter(|doctor| doctor.status.success())
        .and_then(|doctor| serde_json::from_slice::<PluginDoctor>(&doctor.stdout).ok())
        .and_then(|doctor| {
            doctor
                .checks
                .into_iter()
                .find(|check| check.name == "blender")
        })
        .is_some_and(|check| check.ok);
        if !blender_ready {
            manifest.commands.retain(|command| {
                !matches!(
                    command.name.as_str(),
                    "solve-set-lighting" | "render-set-plate"
                )
            });
            manifest
                .capabilities
                .retain(|capability| capability != "blender");
        }
    }
    Some(PluginCapability {
        name: manifest.name,
        version: manifest.version,
        executable: manifest.executable.or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        }),
        description: manifest.description,
        commands: manifest
            .commands
            .into_iter()
            .map(|command| command.name)
            .collect(),
        capabilities: manifest.capabilities,
    })
}

pub async fn discover_plugins() -> Vec<PluginCapability> {
    let mut pending = futures_util::stream::FuturesUnordered::new();
    for candidate in executable_candidates() {
        pending.push(async move { manifest_for(&candidate).await });
    }
    let mut plugins = Vec::new();
    while let Some(plugin) = pending.next().await {
        if let Some(plugin) = plugin {
            plugins.push(plugin);
        }
    }
    plugins.push(crate::native_video::capability());
    plugins.sort_by(|left, right| left.name.cmp(&right.name));
    plugins
}

fn capability_pack(
    pack: &ManagedCapabilityPack,
    discovered: &[PluginCapability],
) -> CapabilityPack {
    let capability = discovered
        .iter()
        .find(|candidate| candidate.name == pack.plugin_id);
    let commands = capability
        .map(|candidate| candidate.commands.clone())
        .unwrap_or_default();
    let missing_commands = pack
        .required_commands
        .iter()
        .filter(|command| !commands.iter().any(|candidate| candidate == **command))
        .map(|command| (*command).to_string())
        .collect::<Vec<_>>();
    CapabilityPack {
        id: pack.id.to_string(),
        title: pack.title.to_string(),
        description: pack.description.to_string(),
        version: capability.and_then(|candidate| candidate.version.clone()),
        installed: capability.is_some(),
        ready: capability.is_some() && missing_commands.is_empty(),
        installable: pack.installable,
        commands,
        missing_commands,
    }
}

pub async fn capability_packs() -> Vec<CapabilityPack> {
    let discovered = discover_plugins().await;
    MANAGED_CAPABILITY_PACKS
        .iter()
        .map(|pack| capability_pack(pack, &discovered))
        .collect()
}

fn command_failure_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stderr.is_empty() {
        stdout
    } else {
        stderr
    }
}

async fn repair_capability_pack(pack: &ManagedCapabilityPack) -> Result<()> {
    let spec = pack
        .repair_spec
        .ok_or_else(|| anyhow!("{} cannot be repaired separately", pack.title))?;
    let output = Command::new(resolve_plugin_binary("pipx"))
        .args([
            "runpip",
            pack.plugin_id,
            "install",
            "--upgrade",
            "--force-reinstall",
            spec,
        ])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| anyhow!("failed to launch pipx repair: {error}"))?;
    if !output.status.success() {
        return Err(anyhow!(
            "failed to repair {}: {}",
            pack.title,
            command_failure_detail(&output)
        ));
    }
    Ok(())
}

pub async fn install_capability_pack(pack_id: &str) -> Result<()> {
    let pack = MANAGED_CAPABILITY_PACKS
        .iter()
        .find(|candidate| candidate.id == pack_id)
        .ok_or_else(|| anyhow!("unknown managed capability pack: {pack_id}"))?;
    if !pack.installable {
        return Err(anyhow!(
            "{} ships with the Node and cannot be installed separately",
            pack.title
        ));
    }

    let binary = resolve_plugin_binary(pack.plugin_id);
    if manifest_for(&binary).await.is_some() {
        repair_capability_pack(pack).await?;
    } else {
        let output =
            crate::mererun::mere_run_output(&["plugin", "install", pack.plugin_id, "--yes"])
                .await
                .map_err(|error| anyhow!("failed to launch mere.run plugin installer: {error}"))?;
        if !output.status.success() {
            repair_capability_pack(pack).await.map_err(|repair_error| {
                anyhow!(
                    "failed to install {}: {}; repair also failed: {repair_error}",
                    pack.title,
                    command_failure_detail(&output)
                )
            })?;
        }
    }

    let installed = manifest_for(&binary).await.ok_or_else(|| {
        anyhow!(
            "{} installed but its executable is not discoverable",
            pack.title
        )
    })?;
    let missing = pack
        .required_commands
        .iter()
        .filter(|command| {
            !installed
                .commands
                .iter()
                .any(|candidate| candidate == **command)
        })
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(anyhow!(
            "{} installed without required commands: {}",
            pack.title,
            missing.join(", ")
        ));
    }
    Ok(())
}

async fn canceled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
async fn terminate_process_group(process_id: u32) {
    let process_group = -(process_id as i32);
    // SAFETY: process_group is the negative id returned by the child we just
    // spawned as a fresh process group. Signals are limited to that group.
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    // SAFETY: see above. SIGKILL guarantees that a Blender child cannot survive
    // a canceled Relay tool after ignoring or delaying SIGTERM.
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
async fn terminate_process_group(_process_id: u32) {}

async fn run_plugin_process(
    mut command: Command,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<std::process::Output>> {
    configure_process_group(&mut command);
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let process_id = child
        .id()
        .ok_or_else(|| anyhow!("plugin process did not expose a process id"))?;
    tokio::select! {
        output = child.wait_with_output() => Ok(Some(output?)),
        _ = canceled(cancel) => {
            terminate_process_group(process_id).await;
            Ok(None)
        }
    }
}

fn configured_plugin_binary(name: &str) -> Option<PathBuf> {
    let env_name = format!("{}_BIN", name.replace('-', "_").to_uppercase());
    let value = std::env::var(env_name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn resolve_plugin_binary(requested: &str) -> PathBuf {
    if let Some(path) = configured_plugin_binary(requested) {
        return path;
    }
    for candidate in executable_candidates() {
        if candidate.file_name().and_then(|value| value.to_str()) == Some(requested) {
            return candidate;
        }
    }
    PathBuf::from(requested)
}

fn safe_asset_name(index: usize, requested: Option<&str>, url: Option<&str>) -> String {
    let candidate = requested
        .and_then(|value| Path::new(value).file_name().and_then(|name| name.to_str()))
        .or_else(|| {
            url.and_then(|value| value.split('?').next())
                .and_then(|value| Path::new(value).file_name().and_then(|name| name.to_str()))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("asset.bin");
    let sanitized: String = candidate
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{:03}-{}", index + 1, sanitized)
}

async fn materialize_tool_assets(request: &ToolRequest, input_dir: &Path) -> Result<Vec<PathBuf>> {
    tokio::fs::create_dir_all(input_dir).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut paths = Vec::with_capacity(request.assets.len());
    for (index, asset) in request.assets.iter().enumerate() {
        let destination = input_dir.join(safe_asset_name(
            index,
            asset.name.as_deref(),
            asset.url.as_deref(),
        ));
        if asset
            .path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(anyhow!(
                "tool input asset {} supplied a workstation path; relay inputs must use signed URLs",
                index
            ));
        }

        let url = asset
            .url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("tool input asset {} has no url or path", index))?;
        let secure_url = url.starts_with("https://");
        let local_test_url = cfg!(test)
            && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"));
        if !secure_url && !local_test_url {
            return Err(anyhow!("tool input asset {} must use HTTPS", index));
        }
        let response = client.get(url).send().await?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "tool input asset {} download failed: {}",
                index,
                response.status()
            ));
        }
        let mut file = tokio::fs::File::create(&destination).await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        paths.push(destination);
    }
    Ok(paths)
}

fn asset_index(value: &Value, label: &str, count: usize) -> Result<usize> {
    let index = value
        .as_u64()
        .ok_or_else(|| anyhow!("{label} must be a non-negative integer"))? as usize;
    if index >= count {
        return Err(anyhow!(
            "{label} index {index} is out of range for {count} assets"
        ));
    }
    Ok(index)
}

fn asset_group_directory(indices: &[usize], paths: &[PathBuf], root: &Path) -> Result<PathBuf> {
    let key = indices
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join("-");
    let directory = root.join(format!("group-{key}"));
    std::fs::create_dir_all(&directory)?;
    for index in indices {
        let source = &paths[*index];
        if source.is_dir() {
            return Err(anyhow!(
                "asset directory references cannot contain nested directories"
            ));
        }
        let name = source
            .file_name()
            .ok_or_else(|| anyhow!("tool input asset has no filename"))?;
        let destination = directory.join(name);
        if destination.exists() {
            continue;
        }
        if std::fs::hard_link(source, &destination).is_err() {
            std::fs::copy(source, &destination)?;
        }
    }
    Ok(directory)
}

fn resolve_asset_references(value: &mut Value, paths: &[PathBuf], root: &Path) -> Result<()> {
    match value {
        Value::Object(object) if object.len() == 1 && object.contains_key("$asset") => {
            let index = asset_index(
                object.get("$asset").expect("checked"),
                "$asset",
                paths.len(),
            )?;
            *value = Value::String(paths[index].to_string_lossy().to_string());
        }
        Value::Object(object) if object.len() == 1 && object.contains_key("$assetDirectory") => {
            let raw = object
                .get("$assetDirectory")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("$assetDirectory must be an array of asset indices"))?;
            let indices = raw
                .iter()
                .map(|item| asset_index(item, "$assetDirectory", paths.len()))
                .collect::<Result<Vec<_>>>()?;
            if indices.is_empty() {
                return Err(anyhow!(
                    "$assetDirectory must contain at least one asset index"
                ));
            }
            *value = Value::String(
                asset_group_directory(&indices, paths, root)?
                    .to_string_lossy()
                    .to_string(),
            );
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                resolve_asset_references(child, paths, root)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                resolve_asset_references(child, paths, root)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

async fn upload_artifact(
    upload_url_base: &str,
    artifact: &mut ToolArtifact,
    path: &Path,
) -> Result<()> {
    let file = tokio::fs::File::open(path).await?;
    let byte_count = file.metadata().await?.len();
    let url = format!(
        "{}/{}",
        upload_url_base.trim_end_matches('/'),
        encode_path_segment(&artifact.name)
    );
    let response = reqwest::Client::new()
        .post(url)
        .header("Content-Type", artifact.content_type.clone())
        .header("Content-Length", byte_count)
        .body(reqwest::Body::wrap_stream(
            tokio_util::io::ReaderStream::new(file),
        ))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "tool artifact upload failed: {}",
            response.status()
        ));
    }
    let parsed = response.json::<UploadResponse>().await?;
    artifact.url = if parsed.url.is_empty() {
        Some(parsed.media_url)
    } else {
        Some(parsed.url)
    };
    Ok(())
}

fn artifact_path(item: &Value) -> Option<PathBuf> {
    item.get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn content_type_for(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "exr" => "image/x-exr",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "json" => "application/json",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "obj" => "model/obj",
        "ply" => "model/ply",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "flo" => "application/x-middlebury-flow",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn directory_files(root: &Path) -> Vec<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn tool_artifact(
    item: &Value,
    path: &Path,
    name: String,
    directory: Option<&Path>,
) -> ToolArtifact {
    let kind = item
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("file")
        .to_string();
    let label = item
        .get("label")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content_type = item
        .get("content_type")
        .or_else(|| item.get("contentType"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| content_type_for(path));
    ToolArtifact {
        name,
        kind,
        label,
        content_type,
        url: None,
        bytes: std::fs::metadata(path).ok().map(|metadata| metadata.len()),
        sha256: item
            .get("sha256")
            .and_then(Value::as_str)
            .map(str::to_string),
        metadata: directory.map(|root| {
            serde_json::json!({
                "relative_path": path.strip_prefix(root).unwrap_or(path).to_string_lossy()
            })
        }),
    }
}

fn parse_artifacts(run_manifest: &Value) -> Vec<(ToolArtifact, PathBuf)> {
    let items = run_manifest
        .get("artifacts")
        .and_then(|artifacts| artifacts.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut parsed = Vec::new();
    for item in items {
        let Some(path) = artifact_path(&item) else {
            continue;
        };
        if path.is_file() {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "artifact.bin".to_string());
            parsed.push((tool_artifact(&item, &path, name, None), path));
            continue;
        }
        if path.is_dir() {
            let prefix = item
                .get("label")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("artifact");
            for child in directory_files(&path) {
                let relative = child
                    .strip_prefix(&path)
                    .unwrap_or(&child)
                    .to_string_lossy();
                let safe_relative: String = relative
                    .chars()
                    .map(|character| {
                        if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
                        {
                            character
                        } else {
                            '_'
                        }
                    })
                    .collect();
                let name = format!("{prefix}-{safe_relative}");
                parsed.push((tool_artifact(&item, &child, name, Some(&path)), child));
            }
        }
    }
    parsed
}

fn safe_manifest_path(value: &str, workspace: &Path) -> Option<String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return None;
    }
    if let Ok(relative) = path.strip_prefix(workspace) {
        return Some(format!("workspace://{}", relative.to_string_lossy()));
    }
    Some(format!(
        "local://{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("redacted")
    ))
}

fn sanitize_manifest_value(value: &mut Value, workspace: &Path) {
    match value {
        Value::String(text) => {
            if let Some(safe) = safe_manifest_path(text, workspace) {
                *text = safe;
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_manifest_value(item, workspace);
            }
        }
        Value::Object(object) => {
            let entries = std::mem::take(object);
            for (key, mut child) in entries {
                if key == "path"
                    && child
                        .as_str()
                        .is_some_and(|path| Path::new(path).is_absolute())
                {
                    continue;
                }
                sanitize_manifest_value(&mut child, workspace);
                let safe_key = safe_manifest_path(&key, workspace).unwrap_or(key);
                object.insert(safe_key, child);
            }
        }
        _ => {}
    }
}

fn sanitize_run_manifest(mut run_manifest: Value, workspace: &Path) -> Value {
    sanitize_manifest_value(&mut run_manifest, workspace);
    run_manifest
}

pub async fn run_tool(
    request: &ToolRequest,
    tool_id: &str,
    upload_url_base: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<ToolRunOutcome> {
    let workspace = ToolWorkspace {
        path: std::env::temp_dir()
            .join("mere-run-node")
            .join("tools")
            .join(tool_id),
    };
    let output_dir = &workspace.path;
    tokio::fs::create_dir_all(&output_dir).await?;
    let input_dir = output_dir.join("inputs");
    let materialized_assets = tokio::select! {
        assets = materialize_tool_assets(request, &input_dir) => assets?,
        _ = canceled(&mut cancel) => return Ok(ToolRunOutcome::Canceled),
    };
    let mut localized_request = request.clone();
    resolve_asset_references(
        &mut localized_request.inputs,
        &materialized_assets,
        &output_dir.join("input-groups"),
    )?;
    for (asset, path) in localized_request
        .assets
        .iter_mut()
        .zip(materialized_assets.iter())
    {
        asset.path = Some(path.to_string_lossy().to_string());
        asset.url = None;
    }
    let request_path = output_dir.join("request.json");
    tokio::fs::write(
        &request_path,
        serde_json::to_vec_pretty(&localized_request)?,
    )
    .await?;

    let run_manifest = if request.plugin == crate::native_video::PLUGIN_NAME {
        tokio::select! {
            manifest = crate::native_video::run(&localized_request, output_dir, tool_id) => manifest?,
            _ = canceled(&mut cancel) => return Ok(ToolRunOutcome::Canceled),
        }
    } else {
        let binary = resolve_plugin_binary(&request.plugin);
        let mut command = Command::new(binary);
        command
            .arg(&request.command)
            .arg("--request-json")
            .arg(&request_path)
            .arg("--output-dir")
            .arg(output_dir)
            .arg("--run-id")
            .arg(tool_id);
        let Some(output) = run_plugin_process(command, &mut cancel).await? else {
            return Ok(ToolRunOutcome::Canceled);
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(anyhow!(
                "plugin {} {} failed: {}",
                request.plugin,
                request.command,
                if stderr.is_empty() { stdout } else { stderr }
            ));
        }

        match serde_json::from_slice::<Value>(&output.stdout) {
            Ok(value) => value,
            Err(_) => {
                let bytes = tokio::fs::read(output_dir.join("run.json")).await?;
                serde_json::from_slice::<Value>(&bytes)?
            }
        }
    };
    let mut artifacts = Vec::new();
    for (mut artifact, path) in parse_artifacts(&run_manifest) {
        tokio::select! {
            result = upload_artifact(upload_url_base, &mut artifact, &path) => result?,
            _ = canceled(&mut cancel) => return Ok(ToolRunOutcome::Canceled),
        }
        artifacts.push(artifact);
    }
    if artifacts.is_empty() {
        return Err(anyhow!("plugin completed without uploadable artifacts"));
    }

    let summary = run_manifest
        .get("tool")
        .cloned()
        .map(|tool| serde_json::json!({ "tool": tool }));
    let run_manifest = sanitize_run_manifest(run_manifest, output_dir);
    Ok(ToolRunOutcome::Completed(ToolRunOutput {
        artifacts,
        run_manifest,
        summary,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ToolInputAsset;
    use base64::Engine;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "mere-run-node-plugin-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn plugin_discovery_executes_only_managed_companions() {
        let root = test_root();
        std::fs::create_dir_all(&root).expect("plugin directory");
        let plugin = root.join("mere-vfx-tools");
        let unrelated = root.join("mere-run-openwebui-api");
        let legacy_node = root.join("mere-run-node");
        let canonical_node = root.join("mere.run-node");
        let renamed_node = root.join("mere-future-node");
        for path in [
            &plugin,
            &unrelated,
            &legacy_node,
            &canonical_node,
            &renamed_node,
        ] {
            std::fs::write(path, b"test").expect("candidate");
        }

        assert_eq!(
            executable_candidates_in([root.clone()], Some(&renamed_node)),
            vec![plugin]
        );

        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn managed_pack_requires_its_exact_command_contract() {
        let plugin = PluginCapability {
            name: "mere-animatic-tools".to_string(),
            version: Some("0.1.0".to_string()),
            executable: Some("mere-animatic-tools".to_string()),
            description: None,
            commands: vec![
                "character-knockout".to_string(),
                "delivery-prep".to_string(),
            ],
            capabilities: Vec::new(),
        };
        let pack = capability_pack(&MANAGED_CAPABILITY_PACKS[0], &[plugin]);

        assert!(pack.installed);
        assert!(!pack.ready);
        assert_eq!(
            pack.missing_commands,
            vec![
                "reference-pack",
                "continuity-check",
                "shot-kit",
                "storyboard-repair",
                "edit-doctor",
                "actor-voice-kit",
                "location-plates",
                "style-lock",
                "build-set-proxy",
            ]
        );
    }

    #[test]
    fn managed_repairs_are_pinned_to_official_plugin_subdirectories() {
        assert_eq!(
            MANAGED_CAPABILITY_PACKS[0].repair_spec,
            Some(
                "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-animatic-tools"
            )
        );
        assert_eq!(
            MANAGED_CAPABILITY_PACKS[2].repair_spec,
            Some(
                "git+https://github.com/sawfwair/mere-run-plugins.git@main#subdirectory=packages/mere-vfx-tools"
            )
        );
    }

    #[test]
    fn blender_pack_is_ready_only_with_both_commands() {
        let plugin = PluginCapability {
            name: "mere-animatic-tools".to_string(),
            version: Some("0.2.0".to_string()),
            executable: Some("mere-animatic-tools".to_string()),
            description: None,
            commands: vec![
                "solve-set-lighting".to_string(),
                "render-set-plate".to_string(),
            ],
            capabilities: vec!["blender".to_string()],
        };
        let pack = capability_pack(&MANAGED_CAPABILITY_PACKS[1], &[plugin]);

        assert!(pack.installed);
        assert!(pack.ready);
        assert!(pack.missing_commands.is_empty());
    }

    #[test]
    fn vfx_pack_requires_every_animatic_vfx_command() {
        let mut commands = MANAGED_CAPABILITY_PACKS[2]
            .required_commands
            .iter()
            .map(|command| (*command).to_string())
            .collect::<Vec<_>>();
        commands.retain(|command| command != "multiview-image-to-3d");
        let plugin = PluginCapability {
            name: "mere-vfx-tools".to_string(),
            version: Some("0.1.0".to_string()),
            executable: Some("mere-vfx-tools".to_string()),
            description: None,
            commands,
            capabilities: Vec::new(),
        };
        let pack = capability_pack(&MANAGED_CAPABILITY_PACKS[2], &[plugin]);

        assert!(!pack.ready);
        assert_eq!(pack.missing_commands, vec!["multiview-image-to-3d"]);
    }

    #[test]
    fn resolves_single_and_directory_asset_references() {
        let root = test_root();
        let inputs = root.join("inputs");
        std::fs::create_dir_all(&inputs).expect("inputs");
        let first = inputs.join("001-first.png");
        let second = inputs.join("002-second.png");
        std::fs::write(&first, b"first").expect("first");
        std::fs::write(&second, b"second").expect("second");
        let mut value = json!({
            "startImage": {"$asset": 0},
            "frames": {"$assetDirectory": [0, 1]},
            "views": [{"$asset": 1}]
        });

        resolve_asset_references(
            &mut value,
            &[first.clone(), second.clone()],
            &root.join("groups"),
        )
        .expect("resolved");

        assert_eq!(value["startImage"], first.to_string_lossy().as_ref());
        assert_eq!(value["views"][0], second.to_string_lossy().as_ref());
        let group = PathBuf::from(value["frames"].as_str().expect("group path"));
        assert!(group.join("001-first.png").is_file());
        assert!(group.join("002-second.png").is_file());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_out_of_range_asset_references() {
        let mut value = json!({"image": {"$asset": 2}});
        let error = resolve_asset_references(
            &mut value,
            &[PathBuf::from("only.png")],
            Path::new("groups"),
        )
        .expect_err("out of range");
        assert!(error.to_string().contains("out of range"));
    }

    #[test]
    fn outbound_manifest_does_not_expose_workspace_paths() {
        let workspace = Path::new("/tmp/mere-run-node/tools/job");
        let manifest = json!({
            "request": {
                "inputs": {
                    "source": "/tmp/mere-run-node/tools/job/inputs/001-source.png"
                }
            },
            "artifacts": {
                "files": ["/tmp/mere-run-node/tools/job/artifacts/manifest.json"],
                "sha256": {
                    "/tmp/mere-run-node/tools/job/artifacts/manifest.json": "abc123"
                },
                "items": [{
                    "name": "manifest.json",
                    "path": "/tmp/mere-run-node/tools/job/artifacts/manifest.json"
                }]
            }
        });
        let outbound = sanitize_run_manifest(manifest, workspace);
        assert!(outbound["artifacts"]["items"][0].get("path").is_none());
        assert_eq!(
            outbound["request"]["inputs"]["source"],
            "workspace://inputs/001-source.png"
        );
        assert_eq!(
            outbound["artifacts"]["files"][0],
            "workspace://artifacts/manifest.json"
        );
        assert_eq!(
            outbound["artifacts"]["sha256"]["workspace://artifacts/manifest.json"],
            "abc123"
        );
        assert!(!outbound.to_string().contains("/tmp/mere-run-node"));
    }

    #[tokio::test]
    async fn rejects_remote_workstation_paths_and_insecure_asset_urls() {
        let root = test_root();
        let path_request = ToolRequest {
            plugin: "mere-vfx-tools".to_string(),
            command: "matte-refine".to_string(),
            inputs: json!({}),
            options: json!({}),
            assets: vec![ToolInputAsset {
                name: Some("secret.txt".to_string()),
                url: None,
                path: Some("/etc/passwd".to_string()),
                content_type: Some("text/plain".to_string()),
                metadata: None,
            }],
        };
        let error = materialize_tool_assets(&path_request, &root)
            .await
            .expect_err("workstation path");
        assert!(error.to_string().contains("must use signed URLs"));

        let insecure_request = ToolRequest {
            assets: vec![ToolInputAsset {
                name: Some("asset.png".to_string()),
                url: Some("http://example.com/asset.png".to_string()),
                path: None,
                content_type: Some("image/png".to_string()),
                metadata: None,
            }],
            ..path_request
        };
        let error = materialize_tool_assets(&insecure_request, &root)
            .await
            .expect_err("insecure url");
        assert!(error.to_string().contains("must use HTTPS"));
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn expands_directory_artifacts_and_infers_media_types() {
        let root = test_root();
        let frames = root.join("frames");
        std::fs::create_dir_all(&frames).expect("frames");
        let frame = frames.join("frame_000001.png");
        let report = root.join("report.json");
        std::fs::write(&frame, b"png").expect("frame");
        std::fs::write(&report, b"{}").expect("report");
        let manifest = json!({
            "artifacts": {"items": [
                {"name": "frames", "path": frames, "kind": "directory", "label": "pose-frames"},
                {"name": "report.json", "path": report, "kind": "json", "label": "report"}
            ]}
        });

        let artifacts = parse_artifacts(&manifest);
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts
            .iter()
            .any(|(artifact, _)| artifact.content_type == "image/png"));
        assert!(artifacts
            .iter()
            .any(|(artifact, _)| artifact.content_type == "application/json"));
        assert!(artifacts.iter().all(|(artifact, _)| {
            !artifact.metadata.as_ref().is_some_and(|metadata| {
                metadata
                    .to_string()
                    .contains(root.to_string_lossy().as_ref())
            })
        }));
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    #[ignore = "requires the locally installed mere-vfx-tools plugin"]
    async fn live_vfx_plugin_materializes_inputs_and_uploads_directory_outputs() {
        let root = test_root();
        std::fs::create_dir_all(&root).expect("root");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYEJRIAwAB8XAgICR7MUAAAAAElFTkSuQmCC")
            .expect("png");

        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let address = listener.local_addr().expect("address");
        let server = std::thread::spawn(move || {
            let mut upload_index = 0;
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("upload connection");
                let mut buffer = vec![0_u8; 8192];
                let mut request = Vec::new();
                let mut expected = None;
                loop {
                    let count = stream.read(&mut buffer).expect("read upload");
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    if expected.is_none() {
                        if let Some(header_end) =
                            request.windows(4).position(|window| window == b"\r\n\r\n")
                        {
                            let headers = String::from_utf8_lossy(&request[..header_end]);
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                                .unwrap_or(0);
                            expected = Some(header_end + 4 + length);
                        }
                    }
                    if expected.is_some_and(|length| request.len() >= length) {
                        break;
                    }
                }
                if request.starts_with(b"GET ") {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len()).expect("image headers");
                    stream.write_all(&png).expect("image body");
                } else {
                    let body =
                        format!("{{\"url\":\"http://stored.local/artifact-{upload_index}.png\"}}");
                    upload_index += 1;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).expect("response");
                }
            }
        });

        let request = ToolRequest {
            plugin: "mere-vfx-tools".to_string(),
            command: "matte-refine".to_string(),
            inputs: json!({"masks": {"$assetDirectory": [0, 1]}}),
            options: json!({"featherRadius": 0}),
            assets: vec![
                ToolInputAsset {
                    name: Some("first.png".to_string()),
                    url: Some(format!("http://{address}/input/first.png")),
                    path: None,
                    content_type: Some("image/png".to_string()),
                    metadata: None,
                },
                ToolInputAsset {
                    name: Some("second.png".to_string()),
                    url: Some(format!("http://{address}/input/second.png")),
                    path: None,
                    content_type: Some("image/png".to_string()),
                    metadata: None,
                },
            ],
        };
        let tool_id = format!(
            "live-vfx-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let output = match run_tool(
            &request,
            &tool_id,
            &format!("http://{address}/uploads"),
            cancel_rx,
        )
        .await
        .expect("live VFX run")
        {
            ToolRunOutcome::Completed(output) => output,
            ToolRunOutcome::Canceled => panic!("live VFX run was canceled"),
        };
        server.join().expect("upload server");

        assert_eq!(output.artifacts.len(), 2);
        assert!(output
            .artifacts
            .iter()
            .all(|artifact| artifact.url.is_some()));
        assert_eq!(output.run_manifest["status"], "succeeded");
        std::fs::remove_dir_all(root).expect("cleanup source");
        std::fs::remove_dir_all(
            std::env::temp_dir()
                .join("mere-run-node")
                .join("tools")
                .join(tool_id),
        )
        .expect("cleanup output");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_plugin_process_group() {
        let root = test_root();
        std::fs::create_dir_all(&root).expect("root");
        let descendant_pid_path = root.join("descendant.pid");
        let script = format!(
            "sleep 30 & echo $! > {}; wait",
            descendant_pid_path.to_string_lossy()
        );
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &script]);
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let task = tokio::spawn(async move { run_plugin_process(command, &mut cancel_rx).await });

        for _ in 0..100 {
            if descendant_pid_path.is_file() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let descendant_pid = std::fs::read_to_string(&descendant_pid_path)
            .expect("descendant pid")
            .trim()
            .parse::<i32>()
            .expect("numeric descendant pid");
        cancel_tx.send(true).expect("cancel signal");
        let output = task.await.expect("join").expect("plugin process");
        assert!(output.is_none());
        tokio::time::sleep(Duration::from_millis(100)).await;
        // SAFETY: signal zero only probes the exact child pid written by the
        // test shell; it does not deliver a signal or mutate another process.
        let exists = unsafe { libc::kill(descendant_pid, 0) } == 0;
        assert!(!exists, "plugin descendant survived cancellation");
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
