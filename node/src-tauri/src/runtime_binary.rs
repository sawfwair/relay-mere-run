use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tokio::process::Command;

const STATUS_TIMEOUT: Duration = Duration::from_secs(12);
const VERSION_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeContract {
    StatusJson,
    Legacy,
    Unavailable,
}

impl RuntimeContract {
    fn rank(self) -> u8 {
        match self {
            Self::StatusJson => 2,
            Self::Legacy => 1,
            Self::Unavailable => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBinaryCandidate {
    pub path: String,
    pub source: String,
    pub version: Option<String>,
    pub contract: RuntimeContract,
    pub features: Vec<String>,
    pub selected: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBinaryResolution {
    pub selected_path: Option<String>,
    pub selected_version: Option<String>,
    pub pinned: bool,
    pub conflict: bool,
    pub selection_reason: String,
    pub candidates: Vec<RuntimeBinaryCandidate>,
}

#[derive(Debug, Clone)]
struct CandidatePath {
    path: PathBuf,
    source: &'static str,
    pinned: bool,
}

fn resolution_cache() -> &'static RwLock<Option<RuntimeBinaryResolution>> {
    static CACHE: OnceLock<RwLock<Option<RuntimeBinaryResolution>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

fn configured_binary() -> Option<PathBuf> {
    let value = std::env::var("MERERUN_BIN").ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

fn add_candidate(
    candidates: &mut Vec<CandidatePath>,
    identities: &mut HashSet<PathBuf>,
    path: PathBuf,
    source: &'static str,
    pinned: bool,
) {
    if !pinned && !path.is_file() {
        return;
    }
    let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    if identities.insert(identity) {
        candidates.push(CandidatePath {
            path,
            source,
            pinned,
        });
    }
}

fn known_candidate_paths() -> Vec<CandidatePath> {
    let mut candidates = Vec::new();
    let mut identities = HashSet::new();

    if let Some(path) = configured_binary() {
        add_candidate(
            &mut candidates,
            &mut identities,
            path,
            "MERERUN_BIN pin",
            true,
        );
    }

    #[cfg(target_os = "macos")]
    {
        add_candidate(
            &mut candidates,
            &mut identities,
            PathBuf::from("/Applications/MereRun.app/Contents/Helpers/mere.run"),
            "MereRun app",
            false,
        );
        if let Some(home) = std::env::var_os("HOME") {
            add_candidate(
                &mut candidates,
                &mut identities,
                PathBuf::from(home).join("Applications/MereRun.app/Contents/Helpers/mere.run"),
                "MereRun app",
                false,
            );
        }
    }

    for path in [
        PathBuf::from("/usr/local/bin/mere.run"),
        PathBuf::from("/opt/homebrew/bin/mere.run"),
        PathBuf::from("/usr/bin/mere.run"),
    ] {
        add_candidate(
            &mut candidates,
            &mut identities,
            path,
            "system install",
            false,
        );
    }

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for path in [home.join(".local/bin/mere.run"), home.join("bin/mere.run")] {
            add_candidate(
                &mut candidates,
                &mut identities,
                path,
                "user install",
                false,
            );
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            add_candidate(
                &mut candidates,
                &mut identities,
                directory.join("mere.run"),
                "PATH",
                false,
            );
        }
    }

    candidates
}

async fn command_output(
    path: &Path,
    args: &[&str],
    timeout: Duration,
) -> Option<std::process::Output> {
    let mut command = Command::new(path);
    command.args(args).kill_on_drop(true);
    tokio::time::timeout(timeout, command.output())
        .await
        .ok()?
        .ok()
}

fn version_text(output: &std::process::Output) -> Option<String> {
    if !output.status.success() {
        return None;
    }
    let first_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .trim_start_matches("mere.run")
        .trim_start_matches('v')
        .trim()
        .to_string();
    (!first_line.is_empty()).then_some(first_line)
}

fn status_features(stdout: &[u8]) -> Option<Vec<String>> {
    let status = serde_json::from_slice::<serde_json::Value>(stdout).ok()?;
    status.get("installedModels")?.as_array()?;
    let mut features = vec!["status-json".to_string()];
    let capabilities = status
        .get("capabilities")
        .and_then(serde_json::Value::as_object);
    let protocols = capabilities
        .and_then(|value| value.get("asrStreamingProtocols"))
        .and_then(serde_json::Value::as_array);
    let formats = capabilities
        .and_then(|value| value.get("asrStreamingInputFormats"))
        .and_then(serde_json::Value::as_array);
    let live_asr = protocols
        .is_some_and(|values| values.iter().any(|value| value.as_u64() == Some(1)))
        && formats.is_some_and(|values| {
            values
                .iter()
                .any(|value| value.as_str() == Some("pcm-s16le/16000/mono"))
        });
    if live_asr {
        features.push("live-asr-v1".to_string());
    }
    if live_asr {
        if let Some(backends) = capabilities
            .and_then(|value| value.get("asrStreamingBackends"))
            .and_then(serde_json::Value::as_array)
        {
            for backend in backends.iter().filter_map(serde_json::Value::as_str) {
                features.push(format!("live-asr-{backend}"));
            }
        }
    }
    Some(features)
}

fn recognizes_legacy_model_list(stdout: &[u8]) -> bool {
    String::from_utf8_lossy(stdout).lines().any(|line| {
        let line = line.trim();
        line.starts_with("ID") && line.contains("Category") && line.contains("Status")
    })
}

async fn probe_candidate(candidate: CandidatePath) -> RuntimeBinaryCandidate {
    let version = command_output(&candidate.path, &["--version"], VERSION_TIMEOUT)
        .await
        .as_ref()
        .and_then(version_text);
    let status = command_output(&candidate.path, &["status", "--json"], STATUS_TIMEOUT).await;
    if let Some(features) = status
        .as_ref()
        .filter(|output| output.status.success())
        .and_then(|output| status_features(&output.stdout))
    {
        return RuntimeBinaryCandidate {
            path: candidate.path.to_string_lossy().into_owned(),
            source: candidate.source.to_string(),
            version,
            contract: RuntimeContract::StatusJson,
            features,
            selected: false,
            reason: None,
        };
    }

    let legacy = command_output(&candidate.path, &["model", "list"], STATUS_TIMEOUT).await;
    if legacy.as_ref().is_some_and(|output| {
        output.status.success() && recognizes_legacy_model_list(&output.stdout)
    }) {
        return RuntimeBinaryCandidate {
            path: candidate.path.to_string_lossy().into_owned(),
            source: candidate.source.to_string(),
            version,
            contract: RuntimeContract::Legacy,
            features: vec!["legacy-model-list".to_string()],
            selected: false,
            reason: Some(
                "This build does not provide the status JSON contract; newer Node features may be unavailable."
                    .to_string(),
            ),
        };
    }

    let reason = if candidate.pinned && !candidate.path.is_file() {
        "The pinned path does not exist."
    } else {
        "The binary did not satisfy the current or legacy runtime contract."
    };
    RuntimeBinaryCandidate {
        path: candidate.path.to_string_lossy().into_owned(),
        source: candidate.source.to_string(),
        version,
        contract: RuntimeContract::Unavailable,
        features: Vec::new(),
        selected: false,
        reason: Some(reason.to_string()),
    }
}

fn parsed_version(candidate: &RuntimeBinaryCandidate) -> Option<Version> {
    candidate
        .version
        .as_deref()
        .and_then(|value| Version::parse(value.trim_start_matches('v')).ok())
}

fn source_rank(source: &str) -> u8 {
    match source {
        "MERERUN_BIN pin" => 4,
        "MereRun app" => 3,
        "user install" => 2,
        "system install" => 1,
        _ => 0,
    }
}

fn automatic_selection(candidates: &[RuntimeBinaryCandidate]) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.contract
                .rank()
                .cmp(&right.contract.rank())
                .then_with(|| parsed_version(left).cmp(&parsed_version(right)))
                .then_with(|| source_rank(&left.source).cmp(&source_rank(&right.source)))
        })
        .map(|(index, _)| index)
}

fn has_conflicting_candidates(candidates: &[RuntimeBinaryCandidate]) -> bool {
    candidates
        .iter()
        .map(|candidate| {
            (
                candidate.version.as_deref(),
                candidate.contract,
                candidate.features.as_slice(),
            )
        })
        .collect::<HashSet<_>>()
        .len()
        > 1
}

fn finish_resolution(
    mut candidates: Vec<RuntimeBinaryCandidate>,
    pinned: bool,
) -> RuntimeBinaryResolution {
    let selected_index = if pinned {
        candidates
            .iter()
            .position(|candidate| candidate.source == "MERERUN_BIN pin")
    } else {
        automatic_selection(&candidates)
    };
    if let Some(index) = selected_index {
        candidates[index].selected = true;
    }
    let selected = selected_index.and_then(|index| candidates.get(index));
    let conflict = has_conflicting_candidates(&candidates);
    let selection_reason = match selected {
        Some(candidate) if pinned => format!(
            "Using the explicit MERERUN_BIN pin at {}. Automatic selection is disabled.",
            candidate.path
        ),
        Some(candidate) if candidate.contract == RuntimeContract::StatusJson => format!(
            "Selected the newest runtime that satisfies the current status contract: {}.",
            candidate.path
        ),
        Some(candidate) => format!(
            "No current-contract runtime was found; using the best legacy candidate at {}.",
            candidate.path
        ),
        None => "No mere.run binary was found in a trusted install location.".to_string(),
    };
    RuntimeBinaryResolution {
        selected_path: selected.map(|candidate| candidate.path.clone()),
        selected_version: selected.and_then(|candidate| candidate.version.clone()),
        pinned,
        conflict,
        selection_reason,
        candidates,
    }
}

async fn discover_resolution() -> RuntimeBinaryResolution {
    let paths = known_candidate_paths();
    let pinned = paths.iter().any(|candidate| candidate.pinned);
    let mut candidates = Vec::with_capacity(paths.len());
    for candidate in paths {
        candidates.push(probe_candidate(candidate).await);
    }
    finish_resolution(candidates, pinned)
}

pub async fn resolution(refresh: bool) -> RuntimeBinaryResolution {
    if !refresh {
        if let Some(cached) = resolution_cache()
            .read()
            .expect("runtime resolution cache poisoned")
            .clone()
        {
            return cached;
        }
    }
    let discovered = discover_resolution().await;
    *resolution_cache()
        .write()
        .expect("runtime resolution cache poisoned") = Some(discovered.clone());
    discovered
}

pub async fn selected_binary() -> PathBuf {
    resolution(false)
        .await
        .selected_path
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("mere.run"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn runtime_script(root: &Path, name: &str, body: &str, source: &'static str) -> CandidatePath {
        use std::os::unix::fs::PermissionsExt;

        let path = root.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write runtime fixture");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("make runtime fixture executable");
        CandidatePath {
            path,
            source,
            pinned: false,
        }
    }

    fn candidate(
        path: &str,
        version: Option<&str>,
        contract: RuntimeContract,
        source: &str,
    ) -> RuntimeBinaryCandidate {
        RuntimeBinaryCandidate {
            path: path.to_string(),
            source: source.to_string(),
            version: version.map(str::to_string),
            contract,
            features: Vec::new(),
            selected: false,
            reason: None,
        }
    }

    #[test]
    fn automatic_selection_prefers_newest_current_contract_runtime() {
        let resolution = finish_resolution(
            vec![
                candidate("/old", None, RuntimeContract::Legacy, "system install"),
                candidate(
                    "/current-23",
                    Some("0.23.0"),
                    RuntimeContract::StatusJson,
                    "user install",
                ),
                candidate(
                    "/current-33",
                    Some("0.33.0"),
                    RuntimeContract::StatusJson,
                    "MereRun app",
                ),
            ],
            false,
        );

        assert_eq!(resolution.selected_path.as_deref(), Some("/current-33"));
        assert!(resolution.conflict);
        assert!(resolution.candidates[2].selected);
    }

    #[test]
    fn explicit_pin_is_never_overridden() {
        let resolution = finish_resolution(
            vec![
                candidate("/pinned", None, RuntimeContract::Legacy, "MERERUN_BIN pin"),
                candidate(
                    "/current",
                    Some("0.33.0"),
                    RuntimeContract::StatusJson,
                    "MereRun app",
                ),
            ],
            true,
        );

        assert_eq!(resolution.selected_path.as_deref(), Some("/pinned"));
        assert!(resolution.pinned);
        assert!(resolution
            .selection_reason
            .contains("Automatic selection is disabled"));
    }

    #[test]
    fn current_contract_outranks_a_newer_legacy_version() {
        let resolution = finish_resolution(
            vec![
                candidate(
                    "/legacy",
                    Some("99.0.0"),
                    RuntimeContract::Legacy,
                    "system install",
                ),
                candidate(
                    "/current",
                    Some("0.33.0"),
                    RuntimeContract::StatusJson,
                    "MereRun app",
                ),
            ],
            false,
        );

        assert_eq!(resolution.selected_path.as_deref(), Some("/current"));
    }

    #[test]
    fn equivalent_install_wrappers_are_not_reported_as_conflicts() {
        let resolution = finish_resolution(
            vec![
                candidate(
                    "/app",
                    Some("0.33.0"),
                    RuntimeContract::StatusJson,
                    "MereRun app",
                ),
                candidate(
                    "/usr/local/bin/mere.run",
                    Some("0.33.0"),
                    RuntimeContract::StatusJson,
                    "system install",
                ),
            ],
            false,
        );

        assert_eq!(resolution.selected_path.as_deref(), Some("/app"));
        assert!(!resolution.conflict);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probes_and_resolves_the_book_local_conflict() {
        let root = std::env::temp_dir().join(format!(
            "mere-run-runtime-resolution-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create fixture directory");
        let legacy = runtime_script(
            &root,
            "legacy",
            r#"if [ "$1" = "model" ] && [ "$2" = "list" ]; then
  printf 'ID Category Status Size\nspeech-asr-parakeet speech-asr installed 2.51GB\n'
  exit 0
fi
exit 2"#,
            "system install",
        );
        let older = runtime_script(
            &root,
            "older",
            r#"if [ "$1" = "--version" ]; then echo '0.23.0'; exit 0; fi
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  printf '%s\n' '{"installedModels":[{"id":"speech-asr-parakeet"}],"capabilities":{"asrStreamingProtocols":[1],"asrStreamingInputFormats":["pcm-s16le/16000/mono"]}}'
  exit 0
fi
exit 2"#,
            "user install",
        );
        let current = runtime_script(
            &root,
            "current",
            r#"if [ "$1" = "--version" ]; then echo '0.33.0'; exit 0; fi
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  printf '%s\n' '{"installedModels":[{"id":"speech-asr-parakeet"}],"capabilities":{"asrStreamingProtocols":[1],"asrStreamingInputFormats":["pcm-s16le/16000/mono"],"asrStreamingBackends":["parakeet","qwen"]}}'
  exit 0
fi
exit 2"#,
            "MereRun app",
        );

        let legacy_path = legacy.path.to_string_lossy().into_owned();
        let current_path = current.path.to_string_lossy().into_owned();
        let candidates = vec![
            probe_candidate(legacy).await,
            probe_candidate(older).await,
            probe_candidate(current).await,
        ];
        let resolution = finish_resolution(candidates, false);

        assert_eq!(
            resolution.selected_path.as_deref(),
            Some(current_path.as_str())
        );
        assert!(resolution.conflict);
        let selected = resolution
            .candidates
            .iter()
            .find(|candidate| candidate.selected)
            .expect("selected runtime");
        assert_eq!(selected.version.as_deref(), Some("0.33.0"));
        assert!(selected
            .features
            .iter()
            .any(|feature| feature == "live-asr-parakeet"));
        assert_eq!(
            resolution
                .candidates
                .iter()
                .find(|candidate| candidate.path == legacy_path)
                .map(|candidate| candidate.contract),
            Some(RuntimeContract::Legacy)
        );
        std::fs::remove_dir_all(root).expect("remove fixture directory");
    }
}
