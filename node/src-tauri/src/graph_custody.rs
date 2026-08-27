//! Opt-in local custody around the unmodified graph runtime. Only bounded,
//! aggregate JSON crosses the upload boundary; private runtime files stay local.
use crate::protocol::GraphBundleFile;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const POLICY: &str = "local-custody.v1";
pub const MAX_REPORT_BYTES: usize = 256_000;

#[derive(Default)]
pub struct ExecutionPolicy {
    pub data_policy: Option<String>,
    pub request_sha256: Option<String>,
}

impl ExecutionPolicy {
    pub fn is_private(&self) -> bool {
        self.data_policy.is_some()
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(policy) = &self.data_policy {
            if policy != POLICY || !self.request_sha256.as_deref().is_some_and(is_sha256) {
                return Err(anyhow!("unsupported graph data policy or request digest"));
            }
        }
        Ok(())
    }

    pub fn validate_delivery(&self, files: &[GraphBundleFile]) -> Result<()> {
        if !self.is_private() {
            return Ok(());
        }
        let mut total = 0_u64;
        let mut names = std::collections::BTreeSet::new();
        for file in files {
            total = total
                .checked_add(file.size_bytes)
                .ok_or_else(|| anyhow!("private bundle size overflow"))?;
            if !matches!(
                file.path.as_str(),
                "job.json" | "graph.json" | "inputs.json" | "assets.json"
            ) || !names.insert(&file.path)
            {
                return Err(anyhow!(
                    "private delivery permits only exact graph documents"
                ));
            }
        }
        if names.len() != 4 || total > MAX_REPORT_BYTES as u64 {
            return Err(anyhow!(
                "private bundle exceeds its bounded document contract"
            ));
        }
        Ok(())
    }

    pub async fn verify_bundle(&self, directory: &Path) -> Result<Value> {
        let job: Value =
            serde_json::from_slice(&tokio::fs::read(directory.join("job.json")).await?)?;
        if job.get("data_policy").and_then(Value::as_str) != self.data_policy.as_deref() {
            return Err(anyhow!(
                "graph bundle data policy differs from its delivery envelope"
            ));
        }
        if self.is_private() {
            let outputs = job
                .get("outputs")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("missing declared outputs"))?;
            if outputs.is_empty()
                || outputs
                    .iter()
                    .any(|output| !matches!(output["name"].as_str(), Some("receipt" | "report")))
            {
                return Err(anyhow!(
                    "local custody requires declared receipt/report outputs"
                ));
            }
            let assets: Value =
                serde_json::from_slice(&tokio::fs::read(directory.join("assets.json")).await?)?;
            if !assets["groups"].as_array().is_some_and(Vec::is_empty) {
                return Err(anyhow!("local custody forbids portable assets"));
            }
        }
        Ok(job)
    }

    pub async fn acknowledge(&self, client: &reqwest::Client, upload_base: &str) -> Result<()> {
        if !self.is_private() {
            return Ok(());
        }
        for _ in 0..3 {
            let result = client
                .post(format!("{}/bundle-ack", upload_base.trim_end_matches('/')))
                .json(&json!({"request_sha256": self.request_sha256}))
                .send()
                .await;
            if let Ok(response) = result {
                if response.status().is_success() {
                    if let Ok(value) = response.json::<Value>().await {
                        if value["acknowledged"] == true
                            && value["request_sha256"].as_str() == self.request_sha256.as_deref()
                        {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Err(anyhow!("verified bundle acknowledgement failed"))
    }
}

pub fn private_root() -> PathBuf {
    if let Some(path) = std::env::var_os("MERERUN_NODE_PRIVATE_GRAPH_ROOT") {
        return PathBuf::from(path);
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        base.join("Library/Application Support/MereRun/private-graph-runs")
    } else {
        base.join(".local/share/mere-run-node/private-graph-runs")
    }
}

pub async fn prepare_private_layout(root: &Path, job_id: &str) -> Result<(PathBuf, PathBuf)> {
    if !root.is_absolute() || root.parent().is_none() {
        return Err(anyhow!(
            "private graph root must be a dedicated absolute directory"
        ));
    }
    if job_id.is_empty()
        || job_id.len() > 160
        || !job_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(anyhow!("invalid private graph job id"));
    }
    let attempt = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        std::process::id()
    );
    let directory = root.join(job_id).join(attempt);
    let parent = root.join(job_id);
    if tokio::fs::symlink_metadata(&parent)
        .await
        .is_ok_and(|entry| entry.file_type().is_symlink())
    {
        return Err(anyhow!("private job directory cannot be a symlink"));
    }
    tokio::fs::create_dir_all(&parent).await?;
    // Never reuse an existing attempt, even if a clock-derived name collides.
    tokio::fs::create_dir(&directory).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).await?;
        tokio::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let bundle = directory.join("bundle");
    let run = directory.join("run");
    tokio::fs::create_dir_all(&bundle).await?;
    Ok((bundle, run))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 96
        && key.as_bytes()[0].is_ascii_lowercase()
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn sensitive_key(key: &str) -> bool {
    key.split('_').any(|part| {
        matches!(
            part,
            "raw"
                | "prompt"
                | "response"
                | "secret"
                | "credential"
                | "token"
                | "checkpoint"
                | "weight"
                | "weights"
                | "log"
                | "logs"
                | "content"
                | "text"
                | "messages"
                | "inputs"
                | "arguments"
                | "path"
        )
    })
}

fn safe_string(value: &str, key: &str) -> bool {
    if key.ends_with("_sha256") || matches!(key, "sha256" | "source_digests") {
        return is_sha256(value);
    }
    if key.ends_with("_ref") || key == "ref" {
        let Some((scheme, rest)) = value.split_once("://") else {
            return false;
        };
        let Some((kind, digest)) = rest.split_once('/') else {
            return false;
        };
        return scheme.ends_with("-local")
            && scheme
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
            && scheme
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b))
            && !kind.is_empty()
            && kind.bytes().all(|b| b.is_ascii_lowercase())
            && is_sha256(digest);
    }
    let suffix = key.rsplit('_').next().unwrap_or_default();
    matches!(
        suffix,
        "id" | "kind"
            | "version"
            | "model"
            | "arm"
            | "metric"
            | "provider"
            | "framework"
            | "runtime"
            | "privacy"
            | "state"
            | "schema"
    ) && identifier(value)
}

fn safe_value(value: &Value, key: &str, depth: usize) -> bool {
    if depth > 16 || !safe_key(key) {
        return false;
    }
    if matches!(
        key,
        "base_neutral" | "base_prompt" | "adapter_neutral" | "adapter_prompt"
    ) {
        return value.as_object().is_some_and(|metrics| {
            metrics.len() <= 256
                && metrics
                    .iter()
                    .all(|(name, metric)| safe_key(name) && metric.is_number())
        });
    }
    if sensitive_key(key) {
        return value.is_number();
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => safe_string(value, key),
        Value::Array(values) => {
            values.len() <= 256 && values.iter().all(|value| safe_value(value, key, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= 256
                && values
                    .iter()
                    .all(|(key, value)| safe_value(value, key, depth + 1))
        }
    }
}

pub fn report_bytes(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.len() > MAX_REPORT_BYTES {
        return false;
    }
    serde_json::from_slice::<Value>(bytes)
        .is_ok_and(|value| value.is_object() && safe_value(&value, "report", 0))
}

pub fn event(value: Value) -> Value {
    let mut output = json!({
        "sequence": value["sequence"].as_u64().unwrap_or_default(),
        "created_at": chrono::Utc::now().to_rfc3339(), "type": "progress", "state": "running"
    });
    if let Some(node) = value["node_id"].as_str().filter(|node| identifier(node)) {
        output["node_id"] = node.into();
    }
    output
}

pub fn run_manifest(job: &Value, value: &Value) -> Result<Value> {
    if value["contract_version"] != "mere.run/graph-run.v1"
        || value["job_id"] != job["job_id"]
        || value["graph_fingerprint"] != job["graph_fingerprint"]
        || value["state"] != "finished"
    {
        return Err(anyhow!(
            "private graph result does not match the immutable bundle"
        ));
    }
    Ok(
        json!({"contract_version":"mere.run/graph-run.v1", "job_id":job["job_id"],
        "graph_fingerprint":job["graph_fingerprint"], "state":"finished"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_report_grammar_matches_worker() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/local-custody-reports.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                report_bytes(&serde_json::to_vec(&case["report"]).unwrap()),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        assert!(!report_bytes(&vec![b' '; MAX_REPORT_BYTES + 1]));
        assert!(!report_bytes(&[0xff, 0xfe]));
    }

    #[test]
    fn private_delivery_rejects_extra_missing_and_oversized_documents() {
        let policy = ExecutionPolicy {
            data_policy: Some(POLICY.into()),
            request_sha256: Some("a".repeat(64)),
        };
        let mut files: Vec<_> = ["job.json", "graph.json", "inputs.json", "assets.json"]
            .into_iter()
            .map(|path| GraphBundleFile {
                path: path.into(),
                sha256: "a".repeat(64),
                size_bytes: 2,
                url: "https://relay.example.test/bundle".into(),
            })
            .collect();
        assert!(policy.validate_delivery(&files).is_ok());
        files[0].size_bytes = MAX_REPORT_BYTES as u64;
        assert!(policy.validate_delivery(&files).is_err());
        files[0].size_bytes = 2;
        files[0].path = "assets/sha256/private".into();
        assert!(policy.validate_delivery(&files).is_err());
        files[0].path = "graph.json".into();
        assert!(policy.validate_delivery(&files).is_err());
        files.pop();
        assert!(policy.validate_delivery(&files).is_err());
    }

    #[tokio::test]
    async fn private_layout_rejects_traversal_and_preserves_previous_attempts() {
        let root = std::env::temp_dir().join(format!(
            "custody-layout-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        assert!(prepare_private_layout(&root, "../escape").await.is_err());
        assert!(prepare_private_layout(Path::new("relative"), "job-one")
            .await
            .is_err());
        let (first, run) = prepare_private_layout(&root, "job-one").await.unwrap();
        assert!(first.is_dir());
        assert!(
            !run.exists(),
            "the runtime must create its own fresh run directory"
        );
        tokio::fs::write(first.join("inputs.json"), b"private")
            .await
            .unwrap();
        let (second, _) = prepare_private_layout(&root, "job-one").await.unwrap();
        assert_ne!(first, second);
        assert_eq!(
            tokio::fs::read(first.join("inputs.json")).await.unwrap(),
            b"private"
        );
        #[cfg(unix)]
        {
            use std::os::unix::{fs::symlink, fs::PermissionsExt};
            assert_eq!(
                tokio::fs::metadata(&root)
                    .await
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            symlink(root.join("job-one"), root.join("linked-job")).unwrap();
            assert!(prepare_private_layout(&root, "linked-job").await.is_err());
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
