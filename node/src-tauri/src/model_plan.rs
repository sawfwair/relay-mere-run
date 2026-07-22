use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::mererun;
use crate::protocol::ModelPlanApplyResult;

#[derive(Debug, Clone)]
pub struct ModelPlanProgress {
    pub model_id: Option<String>,
    pub phase: String,
    pub message: Option<String>,
}

fn valid_model_id(model_id: &str) -> bool {
    !model_id.is_empty()
        && model_id.len() <= 128
        && model_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && model_id
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn send_progress(
    events: &mpsc::UnboundedSender<ModelPlanProgress>,
    model_id: Option<&str>,
    phase: &str,
    message: Option<String>,
) {
    let _ = events.send(ModelPlanProgress {
        model_id: model_id.map(str::to_string),
        phase: phase.to_string(),
        message,
    });
}

fn diagnostic(stdout: &[u8], stderr: &[u8], fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr.chars().take(2_000).collect();
    }
    let parsed = serde_json::from_slice::<Value>(stdout).ok();
    if let Some(summary) = parsed
        .as_ref()
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
    {
        return summary.chars().take(2_000).collect();
    }
    fallback.to_string()
}

fn preflight_installed(stdout: &[u8], model_id: &str) -> bool {
    serde_json::from_slice::<Value>(stdout)
        .ok()
        .and_then(|value| value.get("result")?.get("models")?.as_array().cloned())
        .is_some_and(|models| {
            models.iter().any(|model| {
                model.get("id").and_then(Value::as_str) == Some(model_id)
                    && model.get("installed").and_then(Value::as_bool) == Some(true)
            })
        })
}

async fn run_pull(
    model_id: &str,
    accept_model_licenses: bool,
    cancel: &mut watch::Receiver<bool>,
) -> Result<std::process::Output> {
    let binary = mererun::resolve_mere_run_binary().await;
    let mut command = Command::new(binary);
    command
        .args(["model", "pull", model_id, "--quiet"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if accept_model_licenses {
        command.arg("--accept-model-license");
    }
    let child = command
        .spawn()
        .context("failed to start mere.run model pull")?;
    tokio::select! {
        output = child.wait_with_output() => Ok(output?),
        _ = wait_for_cancel(cancel) => Err(anyhow!("model plan cancelled")),
    }
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

pub async fn execute(
    model_ids: &[String],
    accept_model_licenses: bool,
    events: mpsc::UnboundedSender<ModelPlanProgress>,
    mut cancel: watch::Receiver<bool>,
) -> Vec<ModelPlanApplyResult> {
    let binary = mererun::resolve_mere_run_binary().await;
    let mut results = Vec::new();
    for model_id in model_ids {
        if *cancel.borrow() {
            results.extend(
                model_ids[results.len()..]
                    .iter()
                    .map(|pending| ModelPlanApplyResult {
                        model_id: pending.clone(),
                        state: "cancelled".to_string(),
                        error: Some("Model plan cancelled".to_string()),
                    }),
            );
            break;
        }
        if !valid_model_id(model_id) {
            results.push(ModelPlanApplyResult {
                model_id: model_id.clone(),
                state: "failed".to_string(),
                error: Some("Invalid model id".to_string()),
            });
            continue;
        }

        send_progress(&events, Some(model_id), "preflighting", None);
        let preflight = Command::new(&binary)
            .args(["model", "pull", model_id, "--preflight", "--json"])
            .output()
            .await;
        let preflight = match preflight {
            Ok(output) if output.status.success() => output,
            Ok(output) => {
                let error = diagnostic(
                    &output.stdout,
                    &output.stderr,
                    "Model pull preflight failed",
                );
                send_progress(&events, Some(model_id), "failed", Some(error.clone()));
                results.push(ModelPlanApplyResult {
                    model_id: model_id.clone(),
                    state: "failed".to_string(),
                    error: Some(error),
                });
                continue;
            }
            Err(error) => {
                let error = format!("Model pull preflight could not start: {error}");
                send_progress(&events, Some(model_id), "failed", Some(error.clone()));
                results.push(ModelPlanApplyResult {
                    model_id: model_id.clone(),
                    state: "failed".to_string(),
                    error: Some(error),
                });
                continue;
            }
        };
        if preflight_installed(&preflight.stdout, model_id) {
            send_progress(&events, Some(model_id), "already_installed", None);
            results.push(ModelPlanApplyResult {
                model_id: model_id.clone(),
                state: "already_installed".to_string(),
                error: None,
            });
            continue;
        }

        send_progress(&events, Some(model_id), "pulling", None);
        match run_pull(model_id, accept_model_licenses, &mut cancel).await {
            Ok(output) if output.status.success() => {
                send_progress(&events, Some(model_id), "installed", None);
                results.push(ModelPlanApplyResult {
                    model_id: model_id.clone(),
                    state: "installed".to_string(),
                    error: None,
                });
            }
            Ok(output) => {
                let error = diagnostic(&output.stdout, &output.stderr, "Model pull failed");
                send_progress(&events, Some(model_id), "failed", Some(error.clone()));
                results.push(ModelPlanApplyResult {
                    model_id: model_id.clone(),
                    state: "failed".to_string(),
                    error: Some(error),
                });
            }
            Err(error) if *cancel.borrow() => {
                send_progress(&events, Some(model_id), "cancelled", None);
                results.push(ModelPlanApplyResult {
                    model_id: model_id.clone(),
                    state: "cancelled".to_string(),
                    error: Some(error.to_string()),
                });
            }
            Err(error) => {
                send_progress(&events, Some(model_id), "failed", Some(error.to_string()));
                results.push(ModelPlanApplyResult {
                    model_id: model_id.clone(),
                    state: "failed".to_string(),
                    error: Some(error.to_string()),
                });
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids_are_strict_cli_values() {
        assert!(valid_model_id("video-ltx23-a2vid-mlx"));
        assert!(valid_model_id("provider_model.v2"));
        assert!(!valid_model_id("--all"));
        assert!(!valid_model_id("model/name"));
        assert!(!valid_model_id("Model"));
    }

    #[test]
    fn detects_installed_models_in_preflight_envelope() {
        let body = br#"{"result":{"models":[{"id":"image-klein-nano","installed":true}]}}"#;
        assert!(preflight_installed(body, "image-klein-nano"));
        assert!(!preflight_installed(body, "image-krea2-raw"));
    }
}
