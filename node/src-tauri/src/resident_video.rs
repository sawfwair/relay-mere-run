//! Reuse the installed LTX 2.5 model between compatible Relay video jobs.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::protocol::{JobKind, JobRequest};

const MODEL: &str = "video-ltx25-distilled-bf16";
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

struct Session {
    binary: PathBuf,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<String>>,
}

#[derive(Default)]
struct Pool {
    session: Mutex<Option<Session>>,
    epoch: AtomicU64,
}

static POOL: OnceLock<Arc<Pool>> = OnceLock::new();

fn pool() -> Arc<Pool> {
    POOL.get_or_init(|| Arc::new(Pool::default())).clone()
}

/// Only map controls that have the same meaning in `video generate` and
/// `video session`. The normal one-shot command handles every other request.
pub fn request(
    job: &JobRequest,
    model: &str,
    job_id: &str,
    output: &Path,
    image: Option<&Path>,
    end_image: Option<&Path>,
) -> Option<Value> {
    if job.kind != JobKind::Video
        || model != MODEL
        || job
            .negative_prompt
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
        || job.input_audio_url.is_some()
        || job
            .reference_image_urls
            .as_ref()
            .is_some_and(|refs| !refs.is_empty())
        || job.variant.as_deref() != Some("unified-av")
        || job.guidance_scale.is_some_and(|guidance| guidance != 1.0)
        || job.shift.is_some_and(|shift| shift != 1.0)
        || !job.adapter_selections.is_empty()
        || !job.keyframes.is_empty()
        || job
            .continuity
            .as_ref()
            .and_then(|value| value["mode"].as_str())
            .is_some_and(|mode| mode != "single")
        || (job.steps != 0 && job.steps != 8)
        || job.prompt.trim().is_empty()
        || job.width < 64
        || job.height < 64
        || !job.width.is_multiple_of(64)
        || !job.height.is_multiple_of(64)
        || !output.is_absolute()
        || end_image.is_some() && image.is_none()
    {
        return None;
    }
    let fps = job.fps.unwrap_or(24);
    if fps == 0 || fps > 60 {
        return None;
    }
    let frames = match (job.duration_seconds, job.num_frames) {
        (Some(duration), None) if duration.is_finite() && (1.0..=20.0).contains(&duration) => {
            let chunks = ((duration * f64::from(fps)).max(9.0) - 1.0) / 8.0;
            (chunks.round() as u32).max(1) * 8 + 1
        }
        (None, Some(frames)) if frames >= 9 && frames % 8 == 1 => frames,
        _ => return None,
    };
    let image_strength = job.input_strength.unwrap_or(1.0);
    let end_image_strength = job.end_image_strength.unwrap_or(1.0);
    if !(0.0..=1.0).contains(&image_strength) || !(0.0..=1.0).contains(&end_image_strength) {
        return None;
    }
    let mut value = json!({
        "id": job_id,
        "prompt": job.prompt,
        "output": output,
        "width": job.width,
        "height": job.height,
        "num_frames": frames,
        "fps": fps,
        "seed": job.seed.unwrap_or(10),
    });
    if let Some(image) = image {
        value["image"] = json!(image);
        value["image_strength"] = json!(image_strength);
    }
    if let Some(end_image) = end_image {
        value["end_image"] = json!(end_image);
        value["end_image_strength"] = json!(end_image_strength);
    }
    Some(value)
}

/// Returns `None` when the installed CLI has no session contract, allowing
/// the caller to use the unchanged one-shot path.
pub async fn generate(binary: &Path, request: &Value, output: &Path) -> Result<Option<()>> {
    let pool = pool();
    let mut held = pool.session.lock().await;
    if held
        .as_mut()
        .is_some_and(|session| session.binary != binary)
    {
        stop(&mut held).await;
    }
    if let Some(session) = held.as_mut() {
        if session.child.try_wait()?.is_some() {
            stop(&mut held).await;
        }
    }
    if held.is_none() {
        let help = match tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(binary)
                .args(["video", "session", "--help"])
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            Ok(output) => output?,
            Err(_) => return Ok(None),
        };
        if !help.status.success()
            || !String::from_utf8_lossy(&help.stdout).contains("--prompt-cache-capacity")
        {
            return Ok(None);
        }
        *held = Some(start(binary).await?);
    }
    let result = run(held.as_mut().expect("session was started"), request, output).await;
    if result.is_err() {
        stop(&mut held).await;
    } else {
        let epoch = pool.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let idle_pool = pool.clone();
        tokio::spawn(async move {
            tokio::time::sleep(IDLE_TIMEOUT).await;
            idle_pool.close_if_idle(epoch).await;
        });
    }
    result.map(Some)
}

pub async fn close() {
    pool().close().await;
}

impl Pool {
    async fn close_if_idle(&self, epoch: u64) {
        let mut session = self.session.lock().await;
        if self.epoch.load(Ordering::SeqCst) == epoch {
            self.epoch.fetch_add(1, Ordering::SeqCst);
            stop(&mut session).await;
        }
    }

    async fn close(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let mut session = self.session.lock().await;
        stop(&mut session).await;
    }
}

async fn start(binary: &Path) -> Result<Session> {
    let mut child = Command::new(binary)
        .args(["video", "session", "--model", MODEL, "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("LTX session stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("LTX session stdout unavailable"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("LTX session stderr unavailable"))?;
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let tail = stderr_tail.clone();
    tokio::spawn(async move {
        let mut chunk = [0_u8; 4096];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
            let mut content = tail.lock().await;
            content.push_str(&String::from_utf8_lossy(&chunk[..count]));
            if content.len() > 4096 {
                let oldest_byte = content.len() - 4096;
                let split = content
                    .char_indices()
                    .find_map(|(index, _)| (index >= oldest_byte).then_some(index))
                    .unwrap_or(0);
                content.drain(..split);
            }
        }
    });
    Ok(Session {
        binary: binary.to_path_buf(),
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr_tail,
    })
}

async fn run(session: &mut Session, request: &Value, output: &Path) -> Result<()> {
    session
        .stdin
        .write_all(serde_json::to_string(request)?.as_bytes())
        .await?;
    session.stdin.write_all(b"\n").await?;
    session.stdin.flush().await?;
    let mut line = String::new();
    if session.stdout.read_line(&mut line).await? == 0 {
        let detail = session.stderr_tail.lock().await;
        return Err(anyhow!(
            "LTX session closed without a response: {}",
            detail.trim()
        ));
    }
    let response: Value = serde_json::from_str(&line)?;
    if response["id"] != request["id"] {
        return Err(anyhow!("LTX session response id mismatch"));
    }
    if response["status"] == "error" {
        return Err(anyhow!(
            "LTX session generation failed: {}",
            response["error"].as_str().unwrap_or("unknown error")
        ));
    }
    if response["status"] != "result" || response["output"] != request["output"] {
        return Err(anyhow!("LTX session returned an unexpected result"));
    }
    let metadata = tokio::fs::metadata(output).await?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(anyhow!("LTX session output is missing or empty"));
    }
    Ok(())
}

async fn stop(slot: &mut Option<Session>) {
    let Some(mut session) = slot.take() else {
        return;
    };
    let _ = session.stdin.shutdown().await;
    drop(session.stdin);
    if tokio::time::timeout(Duration::from_secs(10), session.child.wait())
        .await
        .is_err()
    {
        let _ = session.child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft_request() -> JobRequest {
        serde_json::from_value(json!({
            "kind": "video",
            "prompt": "The ferry departs without passengers",
            "model": MODEL,
            "width": 768,
            "height": 448,
            "fps": 24,
            "duration_seconds": 5,
            "steps": 8,
            "seed": 42,
            "variant": "unified-av",
            "input_image_url": "https://example.test/ferry.png"
        }))
        .expect("draft request")
    }

    #[test]
    fn maps_five_second_image_conditioned_draft_job() {
        let job = draft_request();
        let image = Path::new("/tmp/ferry.png");
        let output = Path::new("/tmp/ferry.mp4");
        let mapped =
            request(&job, MODEL, "film-1", output, Some(image), None).expect("compatible request");
        assert_eq!(mapped["num_frames"], 121);
        assert_eq!(mapped["seed"], 42);
        assert_eq!(mapped["image"], "/tmp/ferry.png");
        assert_eq!(mapped["image_strength"], 1.0);
        assert_eq!(mapped["output"], "/tmp/ferry.mp4");
    }

    #[test]
    fn keeps_nonmatching_video_requests_on_the_direct_path() {
        let output = Path::new("/tmp/ferry.mp4");
        let mut job = draft_request();
        job.input_audio_url = Some("https://example.test/dialogue.wav".to_string());
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.input_audio_url = None;
        job.steps = 12;
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.steps = 8;
        job.reference_image_urls = Some(vec!["https://example.test/cast.png".to_string()]);
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.reference_image_urls = None;
        job.adapter_selections.push(json!({"id":"character-look"}));
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.adapter_selections.clear();
        job.variant = None;
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.variant = Some("distilled".to_string());
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.variant = Some("unified-av".to_string());
        job.guidance_scale = Some(3.0);
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.guidance_scale = Some(1.0);
        job.shift = Some(2.0);
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.shift = Some(1.0);
        job.continuity = Some(json!({"mode":"windowed"}));
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.continuity = None;
        job.keyframes.push(json!({"time_seconds":2}));
        assert!(request(&job, MODEL, "film-1", output, None, None).is_none());
        job.keyframes.clear();
        assert!(request(&job, "video-ltx25-full-bf16", "film-1", output, None, None).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reuses_a_process_then_recovers_exit_and_explicit_close() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("resident-video-test-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(&root)
            .await
            .expect("test directory");
        let binary = root.join("fake-mere-run");
        let output = root.join("output.mp4");
        let log = root.join("starts.log");
        let script = format!(
            "#!/bin/sh\nif [ \"$3\" = \"--help\" ]; then echo --prompt-cache-capacity; exit 0; fi\n\
             echo start >> '{}'\n\
             count=0\n\
             while IFS= read -r line; do\n\
             printf video > '{}'\n\
             printf '%s\\n' '{{\"status\":\"result\",\"id\":\"film-1\",\"output\":\"{}\"}}'\n\
             count=$((count + 1))\n\
             if [ \"$count\" -eq 2 ]; then exit 0; fi\n\
             done\n",
            log.display(),
            output.display(),
            output.display(),
        );
        tokio::fs::write(&binary, script)
            .await
            .expect("fake binary");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
            .expect("executable fake binary");
        let mapped = request(&draft_request(), MODEL, "film-1", &output, None, None)
            .expect("mapped request");
        assert!(generate(&binary, &mapped, &output)
            .await
            .expect("first job")
            .is_some());
        assert!(generate(&binary, &mapped, &output)
            .await
            .expect("second job")
            .is_some());
        assert_eq!(
            tokio::fs::read_to_string(&log).await.expect("start log"),
            "start\n"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(generate(&binary, &mapped, &output)
            .await
            .expect("third job")
            .is_some());
        assert_eq!(
            tokio::fs::read_to_string(&log).await.expect("start log"),
            "start\nstart\n"
        );
        close().await;
        assert!(generate(&binary, &mapped, &output)
            .await
            .expect("fourth job")
            .is_some());
        assert_eq!(
            tokio::fs::read_to_string(&log).await.expect("start log"),
            "start\nstart\nstart\n"
        );
        close().await;
        tokio::fs::remove_dir_all(&root).await.expect("cleanup");
    }

    /// Run explicitly with MERE_RUN_BINARY, LTX25_IMAGE_PATH, and
    /// LTX25_TEST_OUTPUT_DIR after installing the real checkpoint.
    #[tokio::test]
    #[ignore = "requires an installed LTX 2.5 checkpoint and Apple Silicon GPU"]
    async fn real_ltx25_video_matches_one_shot_and_reuses_process() {
        let binary = PathBuf::from(std::env::var("MERE_RUN_BINARY").expect("MERE_RUN_BINARY"));
        let image = PathBuf::from(std::env::var("LTX25_IMAGE_PATH").expect("LTX25_IMAGE_PATH"));
        let output_dir =
            PathBuf::from(std::env::var("LTX25_TEST_OUTPUT_DIR").expect("LTX25_TEST_OUTPUT_DIR"));
        tokio::fs::create_dir_all(&output_dir)
            .await
            .expect("output directory");
        let direct = output_dir.join("node-ltx25-direct.mp4");
        let cold = output_dir.join("node-ltx25-cold.mp4");
        let warm = output_dir.join("node-ltx25-warm.mp4");
        let prompt = "An empty ferry moves slowly away from the quay, one continuous shot.";
        let direct_result = Command::new(&binary)
            .args(["video", "generate", prompt, "--model", MODEL])
            .args(["--variant", "unified-av", "--duration", "1", "--fps", "24"])
            .args(["--width", "448", "--height", "768", "--seed", "42"])
            .arg("--image")
            .arg(&image)
            .args(["--image-strength", "1", "--output"])
            .arg(&direct)
            .arg("--quiet")
            .output()
            .await
            .expect("one-shot process");
        assert!(
            direct_result.status.success(),
            "one-shot failed: {}",
            String::from_utf8_lossy(&direct_result.stderr)
        );
        let job: JobRequest = serde_json::from_value(json!({
            "kind": "video", "prompt": prompt, "model": MODEL, "variant": "unified-av",
            "width": 448, "height": 768, "fps": 24, "duration_seconds": 1,
            "steps": 8, "seed": 42,
        }))
        .expect("video job");
        let cold_request =
            request(&job, MODEL, "cold", &cold, Some(&image), None).expect("resident request");
        generate(&binary, &cold_request, &cold)
            .await
            .expect("cold generation");
        assert!(
            tokio::fs::read(&direct).await.expect("direct MP4")
                == tokio::fs::read(&cold).await.expect("resident MP4"),
            "one-shot and resident MP4 bytes differ"
        );
        let first_pid = pool()
            .session
            .lock()
            .await
            .as_ref()
            .and_then(|session| session.child.id());
        let mut warm_job = job;
        warm_job.seed = Some(43);
        let warm_request = request(&warm_job, MODEL, "warm", &warm, Some(&image), None)
            .expect("warm resident request");
        generate(&binary, &warm_request, &warm)
            .await
            .expect("warm generation");
        let second_pid = pool()
            .session
            .lock()
            .await
            .as_ref()
            .and_then(|session| session.child.id());
        assert!(first_pid.is_some());
        assert_eq!(first_pid, second_pid);
        close().await;
    }
}
