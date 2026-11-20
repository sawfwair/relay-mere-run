//! Version 1 preserves exact steps and offers a bounded, mandatory CLI preflight.
//! It does not claim VRAM admission or implement retries after OOM.
use super::GenerationProcessGuard;
use crate::protocol::JobRequest;
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

pub(super) fn validate(req: &JobRequest) -> Result<()> {
    if req
        .video_controls_version
        .is_some_and(|version| version != 1)
    {
        return Err(anyhow!(
            "UNSUPPORTED_VIDEO_CONTROLS: upgrade Node for this request"
        ));
    }
    if req.memory_policy.is_some() {
        return Err(anyhow!(
            "UNSUPPORTED_MEMORY_POLICY: this runtime does not provide memory admission"
        ));
    }
    if req.max_oom_retries.is_some_and(|retries| retries != 0) {
        return Err(anyhow!(
            "UNSUPPORTED_OOM_RETRIES: this Node supports zero retries only"
        ));
    }
    if req.steps > 1000 || (req.video_controls_version == Some(1) && req.steps == 0) {
        return Err(anyhow!(
            "INVALID_VIDEO_STEPS: steps must be between 1 and 1000"
        ));
    }
    Ok(())
}

pub(super) fn one_shot(req: &JobRequest) -> bool {
    req.video_controls_version.is_some()
        || req.preflight_required.is_some()
        || req.max_oom_retries.is_some()
}

pub(super) async fn preflight(binary: &Path, args: &[OsString]) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(120), run_preflight(binary, args))
        .await
        .map_err(|_| anyhow!("VIDEO_PREFLIGHT_TIMEOUT: generation was not started"))?
}

async fn run_preflight(binary: &Path, args: &[OsString]) -> Result<()> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .args(["--preflight", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn()?;
    let mut guard = GenerationProcessGuard {
        process_id: child
            .id()
            .ok_or_else(|| anyhow!("preflight pid unavailable"))?,
        stdout_drain: tokio::spawn(async {}),
        armed: true,
    };
    const LIMIT: u64 = 1024 * 1024;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("preflight stdout unavailable"))?;
    let mut bytes = Vec::new();
    stdout.take(LIMIT + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > LIMIT {
        return Err(anyhow!(
            "VIDEO_PREFLIGHT_INVALID: report exceeds limit; generation was not started"
        ));
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(anyhow!(
            "VIDEO_PREFLIGHT_BLOCKED: generation was not started"
        ));
    }
    // Keep the guard armed until the report is accepted; canceled futures kill
    // the entire group, including grandchildren holding a pipe open.
    validate_report(&bytes)?;
    guard.armed = false;
    Ok(())
}

fn validate_report(bytes: &[u8]) -> Result<()> {
    let report: Value = serde_json::from_slice(bytes)
        .map_err(|_| anyhow!("VIDEO_PREFLIGHT_INVALID: expected a structured report"))?;
    let empty_warnings = report
        .get("warnings")
        .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty));
    let diagnostics_clear = report["diagnostics"].as_array().is_some_and(|diagnostics| {
        diagnostics.iter().all(|diagnostic| {
            diagnostic["severity"] == "note" || diagnostic["severity"] == "estimate"
        })
    });
    if report["schema_version"] != 1
        || report["command"] != serde_json::json!(["video", "generate"])
        || report["mode"] != "preflight"
        || report["status"] != "ok"
        || !empty_warnings
        || !diagnostics_clear
    {
        return Err(anyhow!(
            "VIDEO_PREFLIGHT_BLOCKED: resolve preflight warnings or blockers before generation"
        ));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        dir: PathBuf,
        binary: PathBuf,
    }
    impl Fixture {
        fn new(body: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mere-preflight-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let binary = dir.join("runtime");
            std::fs::write(&binary, format!("#!/bin/sh\ncd \"$(dirname \"$0\")\"\nprintf '%s\\n' \"$@\" >> calls\necho --end >> calls\n{body}\n")).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self { dir, binary }
        }
        async fn generate(&self) -> Result<PathBuf> {
            let req = serde_json::from_value(serde_json::json!({
                "kind":"video","model":"video-ltx25-distilled-bf16","variant":"unified-av",
                "prompt":"test","width":512,"height":320,"fps":24,"duration_seconds":2,
                "steps":8,"video_controls_version":1,"preflight_required":true,"max_oom_retries":0
            }))
            .unwrap();
            super::super::generate_video_with_binary(&req, &self.dir, "job", &self.binary).await
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    const PREFLIGHT: &str = r#"
for arg in "$@"; do
  if [ "$arg" = '--preflight' ]; then
    echo '{"schema_version":1,"command":["video","generate"],"mode":"preflight","status":"ok","diagnostics":[]}'
    exit 0
  fi
done
"#;

    #[tokio::test]
    async fn preflight_matches_generation_arguments_and_never_uses_resident_session() {
        let fixture = Fixture::new(&format!("{PREFLIGHT}\ntouch job.mp4"));
        fixture.generate().await.unwrap();
        let calls = std::fs::read_to_string(fixture.dir.join("calls")).unwrap();
        let commands: Vec<_> = calls
            .split("--end\n")
            .filter(|line| !line.is_empty())
            .collect();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0], format!("{}--preflight\n--json\n", commands[1]));
        assert!(commands[1].contains("--steps\n8\n"));
        assert!(!calls.contains("session"));
    }

    #[tokio::test]
    async fn oom_does_not_retry_generation() {
        let fixture = Fixture::new(&format!(
            "{PREFLIGHT}\necho 'CUDA out of memory' >&2\nexit 1"
        ));
        assert!(fixture.generate().await.is_err());
        let calls = std::fs::read_to_string(fixture.dir.join("calls")).unwrap();
        assert_eq!(
            calls.matches("--end").count(),
            2,
            "only preflight and one inference attempt"
        );
        assert!(!fixture.dir.join("job.mp4").exists());
    }

    #[tokio::test]
    async fn malformed_or_unsuccessful_preflight_never_runs_generation() {
        for report in [
            "not json",
            "{}",
            r#"{"schema_version":1,"command":["image","generate"],"mode":"preflight","status":"ok","diagnostics":[]}"#,
        ] {
            let fixture = Fixture::new(&format!("echo '{report}'"));
            assert!(fixture.generate().await.is_err());
            let calls = std::fs::read_to_string(fixture.dir.join("calls")).unwrap();
            assert_eq!(calls.matches("--end").count(), 1);
        }
    }

    #[tokio::test]
    async fn canceled_preflight_kills_descendants_and_never_runs_generation() {
        let fixture = Fixture::new(
            r#"escaped="$PWD/escaped"; (sleep 0.5; touch "$escaped") & touch started; wait"#,
        );
        let dir = fixture.dir.clone();
        let task = tokio::spawn(async move {
            let result = fixture.generate().await;
            (fixture, result)
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !dir.join("started").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        // Fixture drop removes its directory. Recreate it so a surviving child
        // cannot hide behind a missing output directory.
        std::fs::create_dir_all(&dir).unwrap();
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(!dir.join("escaped").exists());
        assert!(!dir.join("job.mp4").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn warnings_and_inconsistent_diagnostics_fail_closed() {
        let mut report = serde_json::json!({"schema_version":1,"command":["video","generate"],"mode":"preflight","status":"ok","diagnostics":[]});
        assert!(validate_report(&serde_json::to_vec(&report).unwrap()).is_ok());
        report["warnings"] = serde_json::json!(["steps ignored"]);
        assert!(validate_report(&serde_json::to_vec(&report).unwrap()).is_err());
        report.as_object_mut().unwrap().remove("warnings");
        report["diagnostics"] = serde_json::json!([{"severity":"blocker"}]);
        assert!(validate_report(&serde_json::to_vec(&report).unwrap()).is_err());
    }
}
