//! Bounded, coalescing media publication for hosted graph runs.
use super::*;

const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

pub(super) struct PublicationQueue {
    sender: Option<watch::Sender<Option<Value>>>,
    task: Option<tokio::task::JoinHandle<GraphUploadMetrics>>,
}

impl PublicationQueue {
    pub(super) fn start(base: String, directory: PathBuf) -> Result<Self> {
        validate_upload_url(&base)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        // One in-flight publication and one latest notification. Slow uploads
        // cannot grow a queue or block the worker's stdout reader.
        let (sender, mut receiver) = watch::channel::<Option<Value>>(None);
        let task = tokio::spawn(async move {
            let mut publisher = Publisher {
                client,
                base,
                directory,
                uploaded: BTreeMap::new(),
                previews: BTreeMap::new(),
                metrics: GraphUploadMetrics::default(),
            };
            let mut next_preview = Instant::now();
            while receiver.changed().await.is_ok() {
                let mut event = receiver.borrow_and_update().clone();
                if event
                    .as_ref()
                    .is_some_and(|event| event["type"] == "preview_ready")
                {
                    tokio::time::sleep(next_preview.saturating_duration_since(Instant::now()))
                        .await;
                    if receiver.has_changed().unwrap_or(false) {
                        event = receiver.borrow_and_update().clone();
                    }
                    next_preview = Instant::now() + Duration::from_secs(1);
                }
                if let Some(event) = event {
                    if let Err(error) = publisher.publish(&event).await {
                        eprintln!("Graph media publication deferred: {error}");
                    }
                }
            }
            publisher.metrics
        });
        Ok(Self {
            sender: Some(sender),
            task: Some(task),
        })
    }

    pub(super) fn observe(&self, event: &Value) {
        if matches!(
            event["type"].as_str(),
            Some("node_finished" | "preview_ready" | "artifact_ready")
        ) {
            self.sender
                .as_ref()
                .expect("active publication sender")
                .send_replace(Some(event.clone()));
        }
    }

    pub(super) async fn finish(mut self) -> GraphUploadMetrics {
        let sender = self.sender.take().expect("active publication sender");
        sender.send_replace(Some(serde_json::json!({"type": "publication_flush"})));
        drop(sender);
        let metrics = self
            .task
            .as_mut()
            .expect("active publication task")
            .await
            .unwrap_or_default();
        self.task = None;
        metrics
    }

    pub(super) async fn cancel(mut self) {
        let task = self.task.take().expect("active publication task");
        task.abort();
        let _ = task.await;
    }
}

impl Drop for PublicationQueue {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

// Readiness on the local filesystem is not proof of hosted availability.
// The verified publication manifest exposes the media after upload completes.
pub(super) fn pending_event(mut event: Value) -> Value {
    if matches!(
        event["type"].as_str(),
        Some("preview_ready" | "artifact_ready")
    ) {
        if let Some(record) = event.as_object_mut() {
            record.remove("artifact");
            record.insert("type".into(), "node_diagnostic".into());
            record.insert("message".into(), "Preparing media for delivery".into());
        }
    }
    event
}

struct Publisher {
    client: reqwest::Client,
    base: String,
    directory: PathBuf,
    uploaded: BTreeMap<String, GraphRunArtifact>,
    previews: BTreeMap<String, GraphRunArtifact>,
    metrics: GraphUploadMetrics,
}

impl Publisher {
    async fn publish(&mut self, event: &Value) -> Result<()> {
        let path = self.directory.join("run.json");
        if !path.is_file() {
            return Ok(());
        }
        let mut manifest: Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
        let Some(nodes) = manifest["nodes"].as_array_mut() else {
            return Ok(());
        };
        let mut visible = Vec::new();
        for node in nodes {
            let id = node["id"].as_str().unwrap_or_default().to_string();
            if node["state"] == "finished" {
                visible.extend(self.completed_node(&id, node).await?);
            } else {
                if event["node_id"].as_str() == Some(&id) && event["artifact"].is_object() {
                    let artifact = self.snapshot(&id, &event["artifact"], true).await?;
                    self.previews.insert(id.clone(), artifact);
                }
                if let Some(artifact) = self.previews.get(&id) {
                    node["artifacts"] = serde_json::json!([artifact]);
                    visible.push(artifact.clone());
                }
            }
        }
        if visible.is_empty() {
            return Ok(());
        }
        // Only verified node artifacts are published here. Final graph outputs
        // and reports retain their existing completion path.
        manifest["outputs"] = serde_json::json!([]);
        let response = self
            .client
            .put(format!("{}/publications", self.base.trim_end_matches('/')))
            .json(&serde_json::json!({"artifacts": visible, "run_manifest": manifest}))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(anyhow!("graph publication failed: {}", response.status()));
        }
        Ok(())
    }

    async fn completed_node(
        &mut self,
        id: &str,
        node: &mut Value,
    ) -> Result<Vec<GraphRunArtifact>> {
        let items = node["artifacts"].as_array().cloned().unwrap_or_default();
        let mut artifacts = Vec::new();
        for item in items {
            let name = format!("_live-{id}-{}", item["sha256"].as_str().unwrap_or_default());
            if let Some(artifact) = self
                .uploaded
                .get(&name)
                .filter(|artifact| artifact.kind == "graph.node-output")
            {
                artifacts.push(artifact.clone());
                continue;
            }
            // Completed outputs must still match the worker's recorded digest.
            verified_manifest_artifact(&self.directory, &item, None).await?;
            let artifact = self.snapshot(id, &item, false).await?;
            if item["sha256"].as_str() != Some(&artifact.sha256) {
                return Err(anyhow!("completed graph output changed during publication"));
            }
            artifacts.push(artifact);
        }
        node["artifacts"] = serde_json::to_value(&artifacts)?;
        Ok(artifacts)
    }

    async fn snapshot(
        &mut self,
        node: &str,
        item: &Value,
        preview: bool,
    ) -> Result<GraphRunArtifact> {
        let raw = item["path"]
            .as_str()
            .ok_or_else(|| anyhow!("media event is missing a path"))?;
        let relative = confined_relative_path(&self.directory, Path::new(raw)).await?;
        let source = self.directory.join(relative);
        if preview && tokio::fs::metadata(&source).await?.len() > MAX_PREVIEW_BYTES {
            return Err(anyhow!("intermediate preview exceeds 16 MiB"));
        }
        if self.uploaded.len() >= 2048 {
            return Err(anyhow!("graph publication limit reached"));
        }
        let expected_digest = if preview {
            file_identity(&source).await?.1
        } else {
            item["sha256"]
                .as_str()
                .ok_or_else(|| anyhow!("completed media is missing a digest"))?
                .to_string()
        };
        let staging = self.directory.join(".relay-publications");
        tokio::fs::create_dir_all(&staging).await?;
        let temporary = staging.join("pending");
        tokio::fs::copy(&source, &temporary).await?;
        let (size_bytes, sha256) = file_identity(&temporary).await?;
        if sha256 != expected_digest || (preview && size_bytes > MAX_PREVIEW_BYTES) {
            let _ = tokio::fs::remove_file(temporary).await;
            return Err(anyhow!("media changed during snapshot"));
        }
        let name = format!("_live-{node}-{sha256}");
        let artifact = GraphRunArtifact {
            name: name.clone(),
            kind: if preview {
                "graph.preview"
            } else {
                "graph.node-output"
            }
            .into(),
            path: format!(".relay-publications/{sha256}"),
            content_type: item["content_type"]
                .as_str()
                .unwrap_or("application/octet-stream")
                .into(),
            size_bytes,
            sha256,
        };
        if !self.uploaded.contains_key(&name) {
            let snapshot = self.directory.join(&artifact.path);
            tokio::fs::rename(&temporary, &snapshot).await?;
            let result =
                upload_artifact(&self.client, &self.base, &self.directory, &artifact).await;
            let _ = tokio::fs::remove_file(snapshot).await;
            self.metrics.add(result?);
            self.uploaded.insert(name, artifact.clone());
        } else {
            let _ = tokio::fs::remove_file(temporary).await;
            self.uploaded.insert(name, artifact.clone());
        }
        Ok(artifact)
    }
}
