use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::graph_custody::{self, ExecutionPolicy};
use crate::mererun;
use crate::protocol::{
    GraphBundleFile, GraphExecutionMetrics, GraphRunArtifact, GraphWorkerCapabilities,
};

const ARTIFACT_CHUNK_SIZE: u64 = 8 * 1024 * 1024;
const ARTIFACT_UPLOAD_ATTEMPTS: usize = 3;
const DEFAULT_MAX_GRAPH_BUNDLE_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const MINIMUM_FREE_DISK_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ADVERTISED_ASSET_DIGESTS: usize = 4_096;

struct GraphWorkspaceCleanup(PathBuf);

impl Drop for GraphWorkspaceCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug, Deserialize)]
struct ArtifactUploadStatus {
    sha256: String,
    size_bytes: u64,
    part_count: u64,
    parts: Vec<ArtifactUploadPart>,
    complete: bool,
}

#[derive(Debug, Deserialize)]
struct ArtifactUploadPart {
    index: u64,
    size_bytes: u64,
    sha256: String,
}

pub struct GraphRunOutput {
    pub run_manifest: Value,
    pub artifacts: Vec<GraphRunArtifact>,
    pub metrics: GraphExecutionMetrics,
}

#[derive(Debug, Default)]
struct GraphUploadMetrics {
    bytes_uploaded: u64,
    parts_uploaded: u64,
    bytes_reused: u64,
    parts_reused: u64,
}

impl GraphUploadMetrics {
    fn add(&mut self, other: Self) {
        self.bytes_uploaded += other.bytes_uploaded;
        self.parts_uploaded += other.parts_uploaded;
        self.bytes_reused += other.bytes_reused;
        self.parts_reused += other.parts_reused;
    }
}

pub async fn probe() -> Option<GraphWorkerCapabilities> {
    let binary = mererun::resolve_mere_run_binary().await;
    let output = Command::new(&binary)
        .args(["graph", "worker", "probe", "--json"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut capabilities =
        serde_json::from_slice::<GraphWorkerCapabilities>(&output.stdout).ok()?;
    capabilities.catalog = match Command::new(&binary)
        .args(["graph", "catalog", "--json"])
        .output()
        .await
    {
        Ok(catalog) if catalog.status.success() => serde_json::from_slice(&catalog.stdout).ok(),
        _ => None,
    };
    capabilities.cached_asset_digests = cached_asset_digests().await;
    capabilities.data_policies = vec![graph_custody::POLICY.to_string()];
    Some(capabilities)
}

pub async fn execute(
    job_id: &str,
    bundle_files: &[GraphBundleFile],
    upload_url_base: &str,
    events: mpsc::UnboundedSender<Value>,
    cancel: watch::Receiver<bool>,
    policy: ExecutionPolicy,
) -> Result<GraphRunOutput> {
    let binary = mererun::resolve_mere_run_binary().await;
    execute_with_runtime(
        job_id,
        bundle_files,
        upload_url_base,
        events,
        cancel,
        &policy,
        GraphRuntime {
            binary: &binary,
            cache_root: &asset_cache_root(),
            private_root: &graph_custody::private_root(),
        },
    )
    .await
}

struct GraphRuntime<'a> {
    binary: &'a Path,
    cache_root: &'a Path,
    private_root: &'a Path,
}

async fn execute_with_runtime(
    job_id: &str,
    bundle_files: &[GraphBundleFile],
    upload_url_base: &str,
    events: mpsc::UnboundedSender<Value>,
    mut cancel: watch::Receiver<bool>,
    policy: &ExecutionPolicy,
    runtime: GraphRuntime<'_>,
) -> Result<GraphRunOutput> {
    policy.validate()?;
    policy.validate_delivery(bundle_files)?;
    let binary = runtime.binary;
    let cache_root = runtime.cache_root;
    let total_started = Instant::now();
    let graph_root = std::env::temp_dir().join("mere-run-node").join("graphs");
    let (bundle_directory, run_directory) = if policy.is_private() {
        graph_custody::prepare_private_layout(runtime.private_root, job_id).await?
    } else {
        prepare_job_layout(&graph_root, job_id).await?
    };
    let _workspace_cleanup = (!policy.is_private()).then(|| {
        GraphWorkspaceCleanup(
            bundle_directory
                .parent()
                .expect("prepared graph workspace has a root")
                .to_path_buf(),
        )
    });
    validate_bundle_capacity(bundle_files, &bundle_directory)?;

    let client = relay_client()?;
    let download_started = Instant::now();
    let bundle_bytes_downloaded =
        download_bundle(&client, bundle_files, &bundle_directory, cache_root).await?;
    let download_ms = elapsed_milliseconds(download_started);
    let job_manifest = policy.verify_bundle(&bundle_directory).await?;
    policy.acknowledge(&client, upload_url_base).await?;

    let execution_started = Instant::now();
    let mut child = Command::new(binary)
        // External graph providers that delegate native inference must invoke
        // the same selected runtime as the worker, not an older `mere.run`
        // wrapper that happens to appear first on PATH.
        .env("MERE_RUN_EXECUTABLE", binary)
        .args(["graph", "worker", "execute", "--bundle"])
        .arg(&bundle_directory)
        .arg("--run-dir")
        .arg(&run_directory)
        .arg("--json-stream")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("failed to start mere.run graph worker")?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("graph worker stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("graph worker stderr was not captured"))?;
    let mut lines = BufReader::new(stdout).lines();
    let stderr_reader = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut text = String::new();
        reader.read_to_string(&mut text).await.map(|_| text)
    });

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break; };
                if line.trim().is_empty() { continue; }
                let event = serde_json::from_str::<Value>(&line)
                    .with_context(|| format!("graph worker emitted invalid JSON: {line}"))?;
                let public_event = if policy.is_private() { graph_custody::event(event) } else { event };
                events.send(public_event).map_err(|_| anyhow!("graph event receiver closed"))?;
            }
            _ = wait_for_cancel(&mut cancel) => {
                request_worker_cancel(binary, &run_directory).await;
                let _ = child.start_kill();
                let _ = child.wait().await;
                if let Ok(Ok(stderr)) = stderr_reader.await {
                    persist_private_stderr(policy, &run_directory, &stderr).await?;
                }
                return Err(anyhow!("graph job cancelled"));
            }
        }
    }

    let status = child.wait().await?;
    let stderr = stderr_reader
        .await
        .map_err(|error| anyhow!("graph stderr task failed: {error}"))??;
    persist_private_stderr(policy, &run_directory, &stderr).await?;
    if !status.success() {
        let diagnostic = stderr.trim();
        return Err(anyhow!(
            "mere.run graph worker failed with status {}{}",
            status,
            if diagnostic.is_empty() {
                String::new()
            } else {
                format!(": {diagnostic}")
            }
        ));
    }
    let execution_ms = elapsed_milliseconds(execution_started);

    let manifest_path = run_directory.join("run.json");
    let mut run_manifest = serde_json::from_slice::<Value>(
        &tokio::fs::read(&manifest_path)
            .await
            .context("graph worker completed without run.json")?,
    )?;
    let (artifacts, private_reports) = if policy.is_private() {
        let reports =
            collect_private_artifacts(&run_directory, &job_manifest, &run_manifest).await?;
        run_manifest = graph_custody::run_manifest(&job_manifest, &run_manifest)?;
        reports
    } else {
        normalize_manifest_paths(&run_directory, &mut run_manifest).await?;
        (
            collect_artifacts(&run_directory, &run_manifest).await?,
            BTreeMap::new(),
        )
    };
    let upload_started = Instant::now();
    let mut upload_metrics = GraphUploadMetrics::default();
    let mut uploaded_digests = BTreeSet::new();
    for artifact in &artifacts {
        if uploaded_digests.insert(artifact.sha256.clone()) {
            if let Some(bytes) = private_reports.get(&artifact.sha256) {
                upload_artifact_bytes(&client, upload_url_base, artifact, bytes.clone(), None)
                    .await?;
                upload_metrics.bytes_uploaded += bytes.len() as u64;
                upload_metrics.parts_uploaded += 1;
            } else {
                upload_metrics.add(
                    upload_artifact(&client, upload_url_base, &run_directory, artifact).await?,
                );
            }
        }
    }
    upload_run_manifest(&client, upload_url_base, &run_manifest).await?;
    let upload_ms = elapsed_milliseconds(upload_started);
    Ok(GraphRunOutput {
        run_manifest,
        artifacts,
        metrics: GraphExecutionMetrics {
            bundle_bytes_downloaded,
            download_ms,
            execution_ms,
            upload_ms,
            total_ms: elapsed_milliseconds(total_started),
            artifact_bytes_uploaded: upload_metrics.bytes_uploaded,
            artifact_parts_uploaded: upload_metrics.parts_uploaded,
            artifact_bytes_reused: upload_metrics.bytes_reused,
            artifact_parts_reused: upload_metrics.parts_reused,
        },
    })
}

async fn persist_private_stderr(
    policy: &ExecutionPolicy,
    run_directory: &Path,
    stderr: &str,
) -> Result<()> {
    if policy.is_private() {
        tokio::fs::create_dir_all(run_directory).await?;
        tokio::fs::write(run_directory.join("worker.stderr.log"), stderr).await?;
    }
    Ok(())
}

fn asset_cache_root() -> PathBuf {
    if let Some(configured) = std::env::var_os("MERERUN_NODE_GRAPH_CACHE") {
        return PathBuf::from(configured).join("assets").join("sha256");
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            return home
                .join("Library")
                .join("Caches")
                .join("mere.run-node")
                .join("graph-assets-v1")
                .join("sha256");
        }
        return home
            .join(".cache")
            .join("mere.run-node")
            .join("graph-assets-v1")
            .join("sha256");
    }
    std::env::temp_dir()
        .join("mere.run-node")
        .join("graph-assets-v1")
        .join("sha256")
}

async fn cached_asset_digests() -> Vec<String> {
    let root = asset_cache_root();
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return Vec::new();
    };
    let mut digests = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let digest = entry.file_name().to_string_lossy().to_string();
        if validate_sha256(&digest).is_ok()
            && entry
                .file_type()
                .await
                .is_ok_and(|file_type| file_type.is_file())
        {
            digests.push(digest);
            if digests.len() >= MAX_ADVERTISED_ASSET_DIGESTS {
                break;
            }
        }
    }
    digests.sort();
    digests
}

fn elapsed_milliseconds(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn validate_bundle_capacity(files: &[GraphBundleFile], directory: &Path) -> Result<()> {
    let bundle_bytes = files.iter().try_fold(0_u64, |total, file| {
        total
            .checked_add(file.size_bytes)
            .ok_or_else(|| anyhow!("graph bundle size overflow"))
    })?;
    let configured_limit = std::env::var("MERERUN_NODE_MAX_GRAPH_BUNDLE_BYTES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_GRAPH_BUNDLE_BYTES);
    if bundle_bytes > configured_limit {
        return Err(anyhow!(
            "graph bundle requires {bundle_bytes} bytes, above the node limit of {configured_limit} bytes"
        ));
    }
    let available = fs2::available_space(directory)?;
    if bundle_bytes.saturating_add(MINIMUM_FREE_DISK_RESERVE_BYTES) > available {
        return Err(anyhow!(
            "graph bundle requires {bundle_bytes} bytes but the node has only {available} bytes available"
        ));
    }
    Ok(())
}

async fn prepare_job_layout(root: &Path, job_id: &str) -> Result<(PathBuf, PathBuf)> {
    validate_job_id(job_id)?;
    let root = root.join(job_id);
    if root.exists() {
        tokio::fs::remove_dir_all(&root).await?;
    }
    let bundle_directory = root.join("bundle");
    let run_directory = root.join("run");
    tokio::fs::create_dir_all(&bundle_directory).await?;
    Ok((bundle_directory, run_directory))
}

async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

async fn request_worker_cancel(binary: &Path, run_directory: &Path) {
    let _ = Command::new(binary)
        .args(["graph", "worker", "cancel", "--run-dir"])
        .arg(run_directory)
        .arg("--json")
        .output()
        .await;
}

fn relay_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

async fn download_bundle(
    client: &reqwest::Client,
    files: &[GraphBundleFile],
    root: &Path,
    cache_root: &Path,
) -> Result<u64> {
    let mut paths = BTreeSet::new();
    tokio::fs::create_dir_all(cache_root).await?;
    let mut bytes_downloaded = 0_u64;
    for file in files {
        let relative = validate_bundle_path(&file.path, &file.sha256)?;
        if !paths.insert(file.path.clone()) {
            return Err(anyhow!("duplicate graph bundle path: {}", file.path));
        }
        validate_relay_url(&file.url)?;
        let destination = root.join(relative);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if file.path.starts_with("assets/sha256/") {
            let cached = cache_root.join(&file.sha256);
            if !verified_file(&cached, file.size_bytes, &file.sha256).await {
                if cached.exists() {
                    tokio::fs::remove_file(&cached).await?;
                }
                bytes_downloaded += download_verified_file(client, file, &cached).await?;
            }
            link_or_copy(&cached, &destination).await?;
        } else {
            bytes_downloaded += download_verified_file(client, file, &destination).await?;
        }
    }
    for required in ["job.json", "graph.json", "inputs.json", "assets.json"] {
        if !paths.contains(required) {
            return Err(anyhow!("graph bundle is missing {required}"));
        }
    }
    Ok(bytes_downloaded)
}

async fn verified_file(path: &Path, size_bytes: u64, sha256: &str) -> bool {
    file_identity(path)
        .await
        .is_ok_and(|identity| identity == (size_bytes, sha256.to_string()))
}

async fn download_verified_file(
    client: &reqwest::Client,
    file: &GraphBundleFile,
    destination: &Path,
) -> Result<u64> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = destination.with_extension(format!(
        "download-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let response = client.get(&file.url).send().await?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "graph bundle download failed for {}: {}",
            file.path,
            response.status()
        ));
    }
    let mut output = tokio::fs::File::create(&temporary).await?;
    let mut digest = Sha256::new();
    let mut byte_count = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        byte_count += chunk.len() as u64;
        digest.update(&chunk);
        output.write_all(&chunk).await?;
    }
    output.flush().await?;
    let actual_digest = format_digest(digest.finalize().as_slice());
    if byte_count != file.size_bytes || actual_digest != file.sha256 {
        tokio::fs::remove_file(&temporary).await.ok();
        return Err(anyhow!(
            "graph bundle verification failed for {}",
            file.path
        ));
    }
    if destination.exists() {
        tokio::fs::remove_file(destination).await?;
    }
    tokio::fs::rename(&temporary, destination).await?;
    Ok(byte_count)
}

async fn link_or_copy(source: &Path, destination: &Path) -> Result<()> {
    if tokio::fs::hard_link(source, destination).await.is_err() {
        tokio::fs::copy(source, destination).await?;
    }
    Ok(())
}

fn validate_job_id(job_id: &str) -> Result<()> {
    let valid = !job_id.is_empty()
        && job_id.len() <= 128
        && job_id
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'));
    if !valid {
        return Err(anyhow!("invalid graph job id"));
    }
    Ok(())
}

fn validate_bundle_path(path: &str, digest: &str) -> Result<PathBuf> {
    validate_sha256(digest)?;
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(anyhow!("invalid graph bundle path: {path}"));
    }
    let root_manifest = matches!(
        path,
        "job.json" | "graph.json" | "inputs.json" | "assets.json"
    );
    let asset = path
        .strip_prefix("assets/sha256/")
        .is_some_and(|name| name == digest);
    if !root_manifest && !asset {
        return Err(anyhow!("unsupported graph bundle path: {path}"));
    }
    Ok(relative.to_path_buf())
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(anyhow!("invalid SHA-256 digest"));
    }
    Ok(())
}

fn validate_relay_url(url: &str) -> Result<()> {
    let secure = url.starts_with("https://");
    let local_test = cfg!(test)
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"));
    if !secure && !local_test {
        return Err(anyhow!("graph bundle URL must use HTTPS"));
    }
    Ok(())
}

async fn normalize_manifest_paths(run_directory: &Path, manifest: &mut Value) -> Result<()> {
    if let Some(outputs) = manifest.get_mut("outputs").and_then(Value::as_array_mut) {
        for artifact in outputs {
            normalize_artifact_path(run_directory, artifact).await?;
        }
    }
    if let Some(nodes) = manifest.get_mut("nodes").and_then(Value::as_array_mut) {
        for node in nodes {
            if let Some(artifacts) = node.get_mut("artifacts").and_then(Value::as_array_mut) {
                for artifact in artifacts {
                    normalize_artifact_path(run_directory, artifact).await?;
                }
            }
        }
    }
    Ok(())
}

async fn normalize_artifact_path(run_directory: &Path, artifact: &mut Value) -> Result<()> {
    let raw = artifact
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("graph artifact is missing its path"))?;
    let relative = confined_relative_path(run_directory, Path::new(raw)).await?;
    artifact["path"] = Value::String(relative);
    Ok(())
}

async fn confined_relative_path(run_directory: &Path, path: &Path) -> Result<String> {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        run_directory.join(path)
    };
    let root = tokio::fs::canonicalize(run_directory).await?;
    let canonical = tokio::fs::canonicalize(&candidate).await?;
    let relative = canonical
        .strip_prefix(&root)
        .map_err(|_| anyhow!("graph artifact escapes the run directory"))?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(anyhow!("graph artifact path is invalid"));
    }
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

async fn collect_artifacts(
    run_directory: &Path,
    manifest: &Value,
) -> Result<Vec<GraphRunArtifact>> {
    let mut artifacts = Vec::new();
    if let Some(outputs) = manifest.get("outputs").and_then(Value::as_array) {
        for output in outputs {
            artifacts.push(verified_manifest_artifact(run_directory, output, None).await?);
        }
    }
    if let Some(nodes) = manifest.get("nodes").and_then(Value::as_array) {
        for node in nodes {
            let node_id = node.get("id").and_then(Value::as_str).unwrap_or("unknown");
            if let Some(items) = node.get("artifacts").and_then(Value::as_array) {
                for item in items {
                    let original_name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("artifact");
                    let name = format!("_node-{node_id}-{original_name}");
                    artifacts
                        .push(verified_manifest_artifact(run_directory, item, Some(name)).await?);
                }
            }
        }
    }
    for (name, path, kind, content_type) in [
        (
            "_report-events",
            "events.jsonl",
            "graph.report",
            "application/x-ndjson",
        ),
        (
            "_report-actions",
            "actions.json",
            "graph.report",
            "application/json",
        ),
        (
            "_manifest-graph",
            "graph.json",
            "graph.manifest",
            "application/json",
        ),
        (
            "_manifest-inputs",
            "inputs.json",
            "graph.manifest",
            "application/json",
        ),
        (
            "_manifest-job",
            "job.json",
            "graph.manifest",
            "application/json",
        ),
        (
            "_manifest-assets",
            "assets.json",
            "graph.manifest",
            "application/json",
        ),
    ] {
        let candidate = run_directory.join(path);
        if candidate.is_file() {
            let (size_bytes, sha256) = file_identity(&candidate).await?;
            artifacts.push(GraphRunArtifact {
                name: name.to_string(),
                kind: kind.to_string(),
                path: path.to_string(),
                content_type: content_type.to_string(),
                size_bytes,
                sha256,
            });
        }
    }
    let mut names = BTreeSet::new();
    if artifacts
        .iter()
        .any(|artifact| !names.insert(artifact.name.clone()))
    {
        return Err(anyhow!("graph run produced duplicate artifact names"));
    }
    Ok(artifacts)
}

type PrivateArtifacts = (Vec<GraphRunArtifact>, BTreeMap<String, Vec<u8>>);

async fn collect_private_artifacts(
    run_directory: &Path,
    job: &Value,
    manifest: &Value,
) -> Result<PrivateArtifacts> {
    let outputs = manifest["outputs"]
        .as_array()
        .ok_or_else(|| anyhow!("missing report outputs"))?;
    let declarations = job["outputs"]
        .as_array()
        .ok_or_else(|| anyhow!("missing declared reports"))?;
    let mut artifacts = Vec::new();
    let mut names = BTreeSet::new();
    let mut reports = BTreeMap::new();
    for output in outputs {
        let mut artifact = verified_manifest_artifact(run_directory, output, None).await?;
        if !declarations
            .iter()
            .any(|declared| declared["name"].as_str() == Some(&artifact.name))
            || !names.insert(artifact.name.clone())
        {
            return Err(anyhow!("unexpected or duplicate private report output"));
        }
        let media_type_evidence = private_output_media_type_evidence(manifest, &artifact);
        artifact = recover_private_output_content_type(
            run_directory.to_path_buf(),
            artifact,
            media_type_evidence,
        )
        .await?;
        validate_private_artifact(&artifact)?;
        let bytes = tokio::fs::read(run_directory.join(&artifact.path)).await?;
        if !graph_custody::report_bytes(&bytes)
            || format_digest(Sha256::digest(&bytes).as_slice()) != artifact.sha256
        {
            return Err(anyhow!(
                "private report content is not sanitized or changed during verification"
            ));
        }
        reports.insert(artifact.sha256.clone(), bytes);
        artifact.path = format!("outputs/{}.json", artifact.name);
        artifacts.push(artifact);
    }
    if artifacts.len() != declarations.len() {
        return Err(anyhow!("missing declared private report"));
    }
    Ok((artifacts, reports))
}

fn private_output_media_type_evidence(manifest: &Value, output: &GraphRunArtifact) -> Vec<Value> {
    manifest["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| node["artifacts"].as_array())
        .flatten()
        .filter(|candidate| {
            candidate["name"].as_str() == Some(&output.name)
                && candidate["sha256"].as_str() == Some(&output.sha256)
                && candidate["size_bytes"].as_u64() == Some(output.size_bytes)
        })
        .cloned()
        .collect()
}

async fn recover_private_output_content_type(
    run_directory: PathBuf,
    mut output: GraphRunArtifact,
    media_type_evidence: Vec<Value>,
) -> Result<GraphRunArtifact> {
    if output.kind != "graph.output" || output.content_type != "application/octet-stream" {
        return Ok(output);
    }

    let mut content_types = BTreeSet::new();
    for candidate in media_type_evidence {
        let verified = verified_manifest_artifact(&run_directory, &candidate, None).await?;
        if matches!(
            verified.content_type.as_str(),
            "application/vnd.mere.identity-receipt+json"
                | "application/vnd.mere.sanitized-report+json"
        ) {
            content_types.insert(verified.content_type);
        }
    }

    if content_types.len() == 1 {
        output.content_type = content_types
            .pop_first()
            .expect("one verified content type should exist");
    }
    Ok(output)
}

fn validate_private_artifact(artifact: &GraphRunArtifact) -> Result<()> {
    if !matches!(artifact.name.as_str(), "receipt" | "report")
        || artifact.kind != "graph.output"
        || !matches!(
            artifact.content_type.as_str(),
            "application/vnd.mere.identity-receipt+json"
                | "application/vnd.mere.sanitized-report+json"
        )
        || artifact.size_bytes == 0
        || artifact.size_bytes > graph_custody::MAX_REPORT_BYTES as u64
    {
        return Err(anyhow!(
            "local custody permits only bounded declared receipt/report JSON"
        ));
    }
    Ok(())
}

async fn verified_manifest_artifact(
    run_directory: &Path,
    value: &Value,
    name_override: Option<String>,
) -> Result<GraphRunArtifact> {
    let path = required_string(value, "path")?;
    let destination = run_directory.join(&path);
    let relative = confined_relative_path(run_directory, &destination).await?;
    let (size_bytes, sha256) = file_identity(&destination).await?;
    let declared_size = value
        .get("size_bytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("graph artifact is missing size_bytes"))?;
    let declared_sha = required_string(value, "sha256")?;
    if declared_size != size_bytes || declared_sha != sha256 {
        return Err(anyhow!("graph artifact verification failed for {path}"));
    }
    Ok(GraphRunArtifact {
        name: name_override.unwrap_or(required_string(value, "name")?),
        kind: required_string(value, "kind")?,
        path: relative,
        content_type: required_string(value, "content_type")?,
        size_bytes,
        sha256,
    })
}

fn required_string(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("graph artifact is missing {key}"))
}

async fn file_identity(path: &Path) -> Result<(u64, String)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut byte_count = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        byte_count += count as u64;
        digest.update(&buffer[..count]);
    }
    Ok((byte_count, format_digest(digest.finalize().as_slice())))
}

async fn upload_artifact(
    client: &reqwest::Client,
    upload_url_base: &str,
    run_directory: &Path,
    artifact: &GraphRunArtifact,
) -> Result<GraphUploadMetrics> {
    validate_upload_url(upload_url_base)?;
    let path = run_directory.join(&artifact.path);
    let upload_status = artifact_upload_status(client, upload_url_base, artifact).await?;
    if upload_status.as_ref().is_some_and(|status| status.complete) {
        return Ok(GraphUploadMetrics {
            bytes_reused: artifact.size_bytes,
            parts_reused: upload_status
                .as_ref()
                .map_or(1, |status| status.parts.len().max(1) as u64),
            ..GraphUploadMetrics::default()
        });
    }
    if artifact.size_bytes <= ARTIFACT_CHUNK_SIZE {
        let bytes = tokio::fs::read(path).await?;
        upload_artifact_bytes(client, upload_url_base, artifact, bytes, None).await?;
        return Ok(GraphUploadMetrics {
            bytes_uploaded: artifact.size_bytes,
            parts_uploaded: 1,
            ..GraphUploadMetrics::default()
        });
    }

    let part_sizes = artifact_part_sizes(artifact.size_bytes, ARTIFACT_CHUNK_SIZE);
    let part_count = part_sizes.len() as u64;
    if upload_status
        .as_ref()
        .is_some_and(|status| status.part_count != part_count)
    {
        return Err(anyhow!(
            "relay has an incompatible multipart contract for {}",
            artifact.name
        ));
    }
    let uploaded_parts = upload_status
        .map(|status| {
            status
                .parts
                .into_iter()
                .map(|part| (part.index, (part.size_bytes, part.sha256)))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut file = tokio::fs::File::open(path).await?;
    let mut metrics = GraphUploadMetrics::default();
    for (part_index, part_size) in part_sizes.into_iter().enumerate() {
        let mut bytes = vec![0_u8; part_size as usize];
        file.read_exact(&mut bytes).await?;
        let part_sha256 = format_digest(Sha256::digest(&bytes).as_slice());
        if uploaded_parts
            .get(&(part_index as u64))
            .is_some_and(|(stored_size, stored_sha256)| {
                *stored_size == part_size && stored_sha256 == &part_sha256
            })
        {
            metrics.bytes_reused += part_size;
            metrics.parts_reused += 1;
            continue;
        }
        upload_artifact_bytes(
            client,
            upload_url_base,
            artifact,
            bytes,
            Some((part_index as u64, part_count, part_sha256)),
        )
        .await?;
        metrics.bytes_uploaded += part_size;
        metrics.parts_uploaded += 1;
    }
    Ok(metrics)
}

async fn artifact_upload_status(
    client: &reqwest::Client,
    upload_url_base: &str,
    artifact: &GraphRunArtifact,
) -> Result<Option<ArtifactUploadStatus>> {
    let url = format!(
        "{}/artifact-uploads/{}",
        upload_url_base.trim_end_matches('/'),
        artifact.sha256
    );
    let response = client.get(url).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(anyhow!(
            "graph artifact upload status failed for {}: {}",
            artifact.name,
            response.status()
        ));
    }
    let status = response.json::<ArtifactUploadStatus>().await?;
    if status.sha256 != artifact.sha256 || status.size_bytes != artifact.size_bytes {
        return Err(anyhow!(
            "relay returned mismatched upload status for {}",
            artifact.name
        ));
    }
    Ok(Some(status))
}

fn artifact_part_sizes(size_bytes: u64, chunk_size: u64) -> Vec<u64> {
    let part_count = size_bytes.div_ceil(chunk_size);
    (0..part_count)
        .map(|index| (size_bytes - index * chunk_size).min(chunk_size))
        .collect()
}

async fn upload_artifact_bytes(
    client: &reqwest::Client,
    upload_url_base: &str,
    artifact: &GraphRunArtifact,
    bytes: Vec<u8>,
    part: Option<(u64, u64, String)>,
) -> Result<()> {
    let url = format!(
        "{}/artifacts/{}",
        upload_url_base.trim_end_matches('/'),
        encode_path_segment(&artifact.name)
    );
    let mut final_error = None;
    for attempt in 0..ARTIFACT_UPLOAD_ATTEMPTS {
        let mut request = client
            .put(&url)
            .header("Content-Type", &artifact.content_type)
            .header("Content-Length", bytes.len())
            .header("X-Artifact-Size", artifact.size_bytes)
            .header("X-Artifact-Sha256", &artifact.sha256)
            .header("X-Artifact-Path", &artifact.path)
            .header("X-Artifact-Kind", &artifact.kind);
        if let Some((part_index, part_count, part_sha256)) = &part {
            request = request
                .header("X-Artifact-Part-Index", part_index.to_string())
                .header("X-Artifact-Part-Count", part_count.to_string())
                .header("X-Artifact-Part-Size", bytes.len())
                .header("X-Artifact-Part-Sha256", part_sha256);
        }
        match request.body(bytes.clone()).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                final_error = Some(format!("HTTP {}", response.status()));
                if !response.status().is_server_error() && response.status().as_u16() != 429 {
                    break;
                }
            }
            Err(error) => final_error = Some(error.to_string()),
        }
        if attempt + 1 < ARTIFACT_UPLOAD_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
        }
    }
    Err(anyhow!(
        "graph artifact upload failed for {}: {}",
        artifact.name,
        final_error.unwrap_or_else(|| "unknown upload error".to_string())
    ))
}

async fn upload_run_manifest(
    client: &reqwest::Client,
    upload_url_base: &str,
    manifest: &Value,
) -> Result<()> {
    validate_upload_url(upload_url_base)?;
    let response = client
        .put(format!(
            "{}/run-manifest",
            upload_url_base.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(manifest)?)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "graph run manifest upload failed: {}",
            response.status()
        ));
    }
    Ok(())
}

fn validate_upload_url(url: &str) -> Result<()> {
    validate_relay_url(url)
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

fn format_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::oneshot;

    #[derive(Debug)]
    struct RecordedRequest {
        method: String,
        path: String,
        body: Vec<u8>,
    }

    struct TestRelay {
        base_url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        shutdown: Option<oneshot::Sender<()>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl TestRelay {
        async fn stop(mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            let _ = self.task.await;
        }
    }

    fn unique_test_root(name: &str) -> PathBuf {
        static NEXT_ROOT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "mere-run-node-{name}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should follow epoch")
                .as_nanos(),
            NEXT_ROOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    async fn start_test_relay(documents: BTreeMap<String, Vec<u8>>) -> TestRelay {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test relay should bind");
        let base_url = format!(
            "http://{}",
            listener
                .local_addr()
                .expect("test relay should have an address")
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured_requests = Arc::clone(&requests);
        let (shutdown, mut shutdown_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_receiver => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        handle_test_relay_request(stream, &documents, &captured_requests).await;
                    }
                }
            }
        });
        TestRelay {
            base_url,
            requests,
            shutdown: Some(shutdown),
            task,
        }
    }

    async fn handle_test_relay_request(
        mut stream: TcpStream,
        documents: &BTreeMap<String, Vec<u8>>,
        requests: &Arc<Mutex<Vec<RecordedRequest>>>,
    ) {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let (header_end, content_length) = loop {
            let count = stream.read(&mut buffer).await.expect("request should read");
            if count == 0 {
                return;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(header_end) = find_header_end(&bytes) {
                let header = String::from_utf8_lossy(&bytes[..header_end]);
                let content_length = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or_default();
                break (header_end, content_length);
            }
        };
        while bytes.len() < header_end + 4 + content_length {
            let count = stream
                .read(&mut buffer)
                .await
                .expect("request body should read");
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        let header = String::from_utf8_lossy(&bytes[..header_end]);
        let mut request_parts = header
            .lines()
            .next()
            .expect("request line should exist")
            .split_whitespace();
        let method = request_parts
            .next()
            .expect("method should exist")
            .to_string();
        let path = request_parts.next().expect("path should exist").to_string();
        let body_start = header_end + 4;
        let body_end = (body_start + content_length).min(bytes.len());
        let body = bytes[body_start..body_end].to_vec();
        requests
            .lock()
            .expect("request log should lock")
            .push(RecordedRequest {
                method: method.clone(),
                path: path.clone(),
                body: body.clone(),
            });

        let (status, content_type, response_body) = if method == "GET" {
            if let Some(name) = path.strip_prefix("/bundle/") {
                documents
                    .get(name)
                    .map(|body| (200, "application/json", body.clone()))
                    .unwrap_or_else(|| (404, "application/json", br#"{}"#.to_vec()))
            } else {
                (404, "application/json", br#"{}"#.to_vec())
            }
        } else if method == "PUT"
            && (path.starts_with("/upload/artifacts/") || path == "/upload/run-manifest")
        {
            (200, "application/json", br#"{}"#.to_vec())
        } else if method == "POST" && path == "/upload/bundle-ack" {
            let request: Value =
                serde_json::from_slice(&body).expect("acknowledgement should be JSON");
            (200, "application/json", serde_json::to_vec(&serde_json::json!({"acknowledged":true,"request_sha256":request["request_sha256"]})).unwrap())
        } else {
            (404, "application/json", br#"{}"#.to_vec())
        };
        let reason = if status == 200 { "OK" } else { "Not Found" };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response_body.len()
        );
        stream
            .write_all(response.as_bytes())
            .await
            .expect("response headers should write");
        stream
            .write_all(&response_body)
            .await
            .expect("response body should write");
    }

    fn find_header_end(bytes: &[u8]) -> Option<usize> {
        bytes.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn bundle_files(base_url: &str) -> (Vec<GraphBundleFile>, BTreeMap<String, Vec<u8>>) {
        let documents = ["assets.json", "graph.json", "inputs.json", "job.json"]
            .into_iter()
            .map(|name| (name.to_string(), br#"{}"#.to_vec()))
            .collect::<BTreeMap<_, _>>();
        let files = documents
            .iter()
            .map(|(name, bytes)| GraphBundleFile {
                path: name.clone(),
                url: format!("{base_url}/bundle/{name}"),
                sha256: format_digest(Sha256::digest(bytes).as_slice()),
                size_bytes: bytes.len() as u64,
            })
            .collect();
        (files, documents)
    }

    #[cfg(unix)]
    async fn write_fake_worker(root: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = root.join("mere.run");
        tokio::fs::write(&path, script)
            .await
            .expect("fake worker should write");
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .expect("fake worker metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .expect("fake worker should become executable");
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graph_simulator_executes_worker_and_uploads_verified_results() {
        let root = unique_test_root("graph-simulator-success");
        tokio::fs::create_dir_all(&root)
            .await
            .expect("simulator root should exist");
        let artifact_bytes = b"simulated-output";
        let artifact_sha256 = format_digest(Sha256::digest(artifact_bytes).as_slice());
        let script = format!(
            r#"#!/bin/sh
if [ "$MERE_RUN_EXECUTABLE" != "$0" ]; then
  printf '%s\n' 'worker did not export its selected runtime' >&2
  exit 91
fi
run_dir=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--run-dir" ]; then
    shift
    run_dir="$1"
  fi
  shift
done
mkdir -p "$run_dir/outputs"
printf '%s' 'simulated-output' > "$run_dir/outputs/image.txt"
cat > "$run_dir/run.json" <<'JSON'
{{"contract_version":"mere.run/graph-run.v1","job_id":"job-simulator","graph_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"finished","outputs":[{{"name":"image","kind":"graph.output","path":"outputs/image.txt","content_type":"text/plain","size_bytes":16,"sha256":"{artifact_sha256}"}}],"nodes":[]}}
JSON
printf '%s\n' '{{"sequence":0,"created_at":"2026-07-18T00:00:00Z","type":"run_started","state":"running"}}'
"#
        );
        let worker = write_fake_worker(&root, &script).await;
        let cache = root.join("cache");
        let (_, documents) = bundle_files("http://unused");
        let relay = start_test_relay(documents).await;
        let (files, _) = bundle_files(&relay.base_url);
        let (event_sender, mut event_receiver) = mpsc::unbounded_channel();
        let (_cancel_sender, cancel_receiver) = watch::channel(false);

        let output = execute_with_runtime(
            "job-simulator",
            &files,
            &format!("{}/upload", relay.base_url),
            event_sender,
            cancel_receiver,
            &ExecutionPolicy::default(),
            GraphRuntime {
                binary: &worker,
                cache_root: &cache,
                private_root: &root.join("private"),
            },
        )
        .await
        .expect("simulated graph execution should finish");

        assert_eq!(output.artifacts.len(), 1);
        assert_eq!(output.artifacts[0].sha256, artifact_sha256);
        assert_eq!(output.metrics.bundle_bytes_downloaded, 8);
        assert_eq!(
            output.metrics.artifact_bytes_uploaded,
            artifact_bytes.len() as u64
        );
        assert_eq!(output.metrics.artifact_parts_uploaded, 1);
        assert_eq!(
            event_receiver
                .recv()
                .await
                .expect("worker event should be forwarded")["type"],
            "run_started"
        );

        let requests = Arc::clone(&relay.requests);
        relay.stop().await;
        {
            let requests = requests.lock().expect("request log should lock");
            assert!(requests.iter().any(|request| {
                request.method == "PUT"
                    && request.path == "/upload/artifacts/image"
                    && request.body == artifact_bytes
            }));
            assert!(requests.iter().any(|request| {
                request.method == "PUT"
                    && request.path == "/upload/run-manifest"
                    && String::from_utf8_lossy(&request.body).contains("job-simulator")
            }));
        }
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graph_simulator_private_uploads_only_reports_and_keeps_raw_files_local() {
        let (root, relay, result, events) = simulate_private_graph(false, false).await;
        let output = result.expect("private execution should finish");
        assert_eq!(output.artifacts.len(), 1);
        assert_eq!(output.artifacts[0].path, "outputs/receipt.json");
        assert_eq!(
            output.artifacts[0].content_type,
            "application/vnd.mere.identity-receipt+json"
        );
        assert_eq!(output.run_manifest.as_object().unwrap().len(), 4);
        assert!(!output
            .run_manifest
            .to_string()
            .contains("PRIVATE-CUSTODY-MARKER"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["state"], "running");
        assert!(!events[0].to_string().contains("PRIVATE-CUSTODY-MARKER"));

        let requests = Arc::clone(&relay.requests);
        relay.stop().await;
        {
            let requests = requests.lock().unwrap();
            let ack = requests
                .iter()
                .position(|request| request.path == "/upload/bundle-ack")
                .unwrap();
            assert_eq!(
                ack, 4,
                "all four documents must be verified before acknowledgement"
            );
            let uploads: Vec<_> = requests
                .iter()
                .filter(|request| request.method == "PUT")
                .collect();
            assert_eq!(
                uploads.len(),
                2,
                "no manifests, raw logs, or intermediate artifacts may be uploaded"
            );
            assert_eq!(uploads[0].path, "/upload/artifacts/receipt");
            assert_eq!(uploads[1].path, "/upload/run-manifest");
            assert_eq!(
                format_digest(Sha256::digest(&uploads[0].body).as_slice()),
                output.artifacts[0].sha256
            );
            for request in requests.iter() {
                assert!(!String::from_utf8_lossy(&request.body).contains("PRIVATE-CUSTODY-MARKER"));
            }
        }
        assert_private_files_retained(&root).await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn private_output_media_type_recovery_rejects_ambiguous_evidence() {
        let root = unique_test_root("private-output-media-type");
        tokio::fs::create_dir_all(root.join("outputs"))
            .await
            .unwrap();
        let bytes = br#"{"schema":"example.receipt.v1","state":"complete"}"#;
        tokio::fs::write(root.join("outputs/receipt.json"), bytes)
            .await
            .unwrap();
        let sha256 = format_digest(Sha256::digest(bytes).as_slice());
        let artifact = |content_type: &str| {
            serde_json::json!({
                "name": "receipt",
                "kind": "example.receipt",
                "path": "outputs/receipt.json",
                "content_type": content_type,
                "size_bytes": bytes.len(),
                "sha256": sha256.clone(),
            })
        };
        let manifest = serde_json::json!({
            "nodes": [{"artifacts": [
                artifact("application/vnd.mere.identity-receipt+json"),
                artifact("application/vnd.mere.sanitized-report+json")
            ]}]
        });
        let mut output = GraphRunArtifact {
            name: "receipt".into(),
            kind: "graph.output".into(),
            path: "outputs/receipt.json".into(),
            content_type: "application/octet-stream".into(),
            size_bytes: bytes.len() as u64,
            sha256,
        };

        let evidence = private_output_media_type_evidence(&manifest, &output);
        output = recover_private_output_content_type(root.clone(), output, evidence)
            .await
            .unwrap();
        assert_eq!(output.content_type, "application/octet-stream");
        assert!(validate_private_artifact(&output).is_err());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graph_simulator_private_rejects_unsafe_report_before_any_upload() {
        let (root, relay, result, events) = simulate_private_graph(true, false).await;
        assert!(result
            .err()
            .expect("unsafe report must fail")
            .to_string()
            .contains("not sanitized"));
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("PRIVATE-CUSTODY-MARKER"));
        let requests = Arc::clone(&relay.requests);
        relay.stop().await;
        assert!(!requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.method == "PUT"));
        assert_private_files_retained(&root).await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graph_simulator_private_cancellation_retains_logs_without_uploads() {
        let (root, relay, result, _) = simulate_private_graph(false, true).await;
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("graph job cancelled"));
        let requests = Arc::clone(&relay.requests);
        relay.stop().await;
        assert!(!requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.method == "PUT"));
        assert_private_files_retained(&root).await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(unix)]
    async fn assert_private_files_retained(root: &Path) {
        let mut attempts = tokio::fs::read_dir(root.join("private/job-private"))
            .await
            .unwrap();
        let attempt = attempts.next_entry().await.unwrap().unwrap().path();
        assert!(attempt.join("bundle/inputs.json").is_file());
        for relative in [
            "run/inputs.json",
            "run/actions.json",
            "run/events.jsonl",
            "run/worker.stderr.log",
        ] {
            let content = tokio::fs::read_to_string(attempt.join(relative))
                .await
                .unwrap();
            assert!(content.contains("PRIVATE-CUSTODY-MARKER"));
        }
    }

    #[cfg(unix)]
    async fn simulate_private_graph(
        unsafe_report: bool,
        cancel_after_start: bool,
    ) -> (PathBuf, TestRelay, Result<GraphRunOutput>, Vec<Value>) {
        let root = unique_test_root("private-graph");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let mut report = serde_json::json!({"schema":"example.receipt.v1", "state":"complete", "counts":{"accepted":2}});
        if unsafe_report {
            report["message"] = "PRIVATE-CUSTODY-MARKER".into();
        }
        let receipt = serde_json::to_vec(&report).unwrap();
        let receipt_sha256 = format_digest(Sha256::digest(&receipt).as_slice());
        let manifest = serde_json::json!({"contract_version":"mere.run/graph-run.v1", "job_id":"job-private",
            "graph_fingerprint":"a".repeat(64), "state":"finished", "raw_prompt":"PRIVATE-CUSTODY-MARKER",
            "outputs":[{"name":"receipt", "kind":"graph.output", "path":"outputs/receipt.json",
              "content_type":"application/octet-stream", "size_bytes":receipt.len(),
              "sha256":receipt_sha256}],
            "nodes":[{"id":"private", "artifacts":[{"name":"receipt", "kind":"example.receipt",
              "path":"outputs/receipt.json", "content_type":"application/vnd.mere.identity-receipt+json",
              "size_bytes":receipt.len(), "sha256":receipt_sha256},
              {"path":"/private/PRIVATE-CUSTODY-MARKER"}]}]});
        let script = format!(
            r#"#!/bin/sh
set -eu
if [ "$3" = "cancel" ]; then exit 0; fi
run_dir=""
bundle=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --run-dir) shift; run_dir="$1" ;;
    --bundle) shift; bundle="$1" ;;
  esac
  shift
done
if [ -e "$run_dir" ]; then exit 72; fi
mkdir -p "$run_dir/outputs"
cp "$bundle/inputs.json" "$run_dir/inputs.json"
printf '%s' '{report}' > "$run_dir/outputs/receipt.json"
printf '%s' '{manifest}' > "$run_dir/run.json"
printf '%s' 'PRIVATE-CUSTODY-MARKER' > "$run_dir/actions.json"
printf '%s' 'PRIVATE-CUSTODY-MARKER' > "$run_dir/events.jsonl"
printf '%s\n' 'PRIVATE-CUSTODY-MARKER' >&2
printf '%s\n' '{{"sequence":0,"state":"running","type":"progress","node_id":"execute","message":"PRIVATE-CUSTODY-MARKER","path":"/private/PRIVATE-CUSTODY-MARKER"}}'
if [ "{cancel_after_start}" = "true" ]; then while :; do sleep 1; done; fi
"#
        );
        let worker = write_fake_worker(&root, &script).await;
        let job = serde_json::json!({"job_id":"job-private", "data_policy":graph_custody::POLICY,
            "graph_fingerprint":"a".repeat(64), "outputs":[{"name":"receipt"}]});
        let documents: BTreeMap<_, _> = [
            ("job.json", job),
            ("graph.json", serde_json::json!({})),
            (
                "inputs.json",
                serde_json::json!({"prompt":"PRIVATE-CUSTODY-MARKER"}),
            ),
            ("assets.json", serde_json::json!({"groups":[]})),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), serde_json::to_vec(&value).unwrap()))
        .collect();
        let relay = start_test_relay(documents.clone()).await;
        let files: Vec<_> = documents
            .iter()
            .map(|(name, bytes)| GraphBundleFile {
                path: name.clone(),
                url: format!("{}/bundle/{name}", relay.base_url),
                size_bytes: bytes.len() as u64,
                sha256: format_digest(Sha256::digest(bytes).as_slice()),
            })
            .collect();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let (cancel_sender, cancellation) = watch::channel(false);
        let upload_base = format!("{}/upload", relay.base_url);
        let cache_root = root.join("cache");
        let private_root = root.join("private");
        let policy = ExecutionPolicy {
            data_policy: Some(graph_custody::POLICY.into()),
            request_sha256: Some("b".repeat(64)),
        };
        let execution = execute_with_runtime(
            "job-private",
            &files,
            &upload_base,
            sender,
            cancellation,
            &policy,
            GraphRuntime {
                binary: &worker,
                cache_root: &cache_root,
                private_root: &private_root,
            },
        );
        let receive = async move {
            let mut events = Vec::new();
            while let Some(event) = receiver.recv().await {
                events.push(event);
                if cancel_after_start {
                    cancel_sender.send(true).unwrap();
                }
            }
            events
        };
        let (result, events) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(execution, receive)
        })
        .await
        .unwrap();
        (root, relay, result, events)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graph_simulator_cancels_worker_and_cleans_up() {
        let root = unique_test_root("graph-simulator-cancel");
        tokio::fs::create_dir_all(&root)
            .await
            .expect("simulator root should exist");
        let script = r#"#!/bin/sh
if [ "$3" = "cancel" ]; then
  exit 0
fi
printf '%s\n' '{"sequence":0,"created_at":"2026-07-18T00:00:00Z","type":"run_started","state":"running"}'
while :; do
  sleep 1
done
"#;
        let worker = write_fake_worker(&root, script).await;
        let cache = root.join("cache");
        let (_, documents) = bundle_files("http://unused");
        let relay = start_test_relay(documents).await;
        let (files, _) = bundle_files(&relay.base_url);
        let upload_url_base = format!("{}/upload", relay.base_url);
        let (event_sender, mut event_receiver) = mpsc::unbounded_channel();
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        let execution = tokio::spawn(async move {
            execute_with_runtime(
                "job-cancelled",
                &files,
                &upload_url_base,
                event_sender,
                cancel_receiver,
                &ExecutionPolicy::default(),
                GraphRuntime {
                    binary: &worker,
                    cache_root: &cache,
                    private_root: &cache.join("private"),
                },
            )
            .await
        });

        let event = tokio::time::timeout(Duration::from_secs(5), event_receiver.recv())
            .await
            .expect("worker should start before timeout")
            .expect("worker should emit a start event");
        assert_eq!(event["type"], "run_started");
        cancel_sender
            .send(true)
            .expect("cancellation should reach worker");
        let result = tokio::time::timeout(Duration::from_secs(5), execution)
            .await
            .expect("worker should cancel before timeout")
            .expect("execution task should join");
        let error = match result {
            Ok(_) => panic!("cancelled worker should fail execution"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("graph job cancelled"));

        relay.stop().await;
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[tokio::test]
    async fn job_layout_leaves_run_directory_for_worker() {
        let root = std::env::temp_dir().join(format!(
            "mere-run-node-graph-layout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should follow epoch")
                .as_nanos()
        ));

        let (bundle_directory, run_directory) = prepare_job_layout(&root, "job-123")
            .await
            .expect("job layout should be created");

        assert!(bundle_directory.is_dir());
        assert!(!run_directory.exists());
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[test]
    fn bundle_paths_are_strict_and_content_addressed() {
        let digest = "a".repeat(64);
        assert!(validate_bundle_path("job.json", &digest).is_ok());
        assert!(validate_bundle_path(&format!("assets/sha256/{digest}"), &digest).is_ok());
        assert!(validate_bundle_path("../job.json", &digest).is_err());
        assert!(validate_bundle_path("assets/sha256/wrong", &digest).is_err());
        assert!(validate_bundle_path("extra.json", &digest).is_err());
    }

    #[test]
    fn relay_urls_require_https_outside_tests() {
        assert!(validate_relay_url("https://relay.example.test/file").is_ok());
        assert!(validate_relay_url("file:///tmp/job.json").is_err());
    }

    #[test]
    fn path_segment_encoding_does_not_preserve_slashes() {
        assert_eq!(encode_path_segment("node/image 1"), "node%2Fimage%201");
    }

    #[test]
    fn large_artifacts_are_split_into_stable_parts() {
        assert_eq!(artifact_part_sizes(17, 8), vec![8, 8, 1]);
        assert_eq!(artifact_part_sizes(16, 8), vec![8, 8]);
        assert!(artifact_part_sizes(0, 8).is_empty());
    }

    #[test]
    fn canonical_lora_graph_fixture_decodes() {
        let graph = serde_json::from_str::<Value>(include_str!(
            "../../../test/fixtures/graph-v1/lora-sample.workflow.json"
        ))
        .expect("canonical graph fixture should decode");
        assert_eq!(graph["schema_version"], 1);
        assert_eq!(graph["kind"], "mere.run/workflow-graph");
        assert_eq!(graph["nodes"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn canonical_parallel_graph_fixture_decodes() {
        let graph = serde_json::from_str::<Value>(include_str!(
            "../../../test/fixtures/graph-v1/parallel-image-video.workflow.json"
        ))
        .expect("canonical parallel graph fixture should decode");
        assert_eq!(graph["schema_version"], 1);
        assert_eq!(graph["kind"], "mere.run/workflow-graph");
        assert_eq!(graph["execution"]["max_parallel_nodes"], 2);
        assert_eq!(graph["nodes"].as_array().map(Vec::len), Some(3));
    }
}
