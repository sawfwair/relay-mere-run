//! mere.world device-authorization grant (RFC 8628).
//!
//! The node signs in like merekit-console: request a device + user code, send
//! the operator to `mere.world/device` to approve it, then poll the token
//! endpoint until a brokered access token comes back. That token is what the
//! relay validates via its OIDC userinfo check — no pasted credentials, and any
//! number of devices can be approved under the same mere.world account.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BROKER_ORIGIN: &str = "https://mere.world";
const CLIENT_ID: &str = "mererun-node";
const SCOPE: &str = "openid profile email offline_access";
pub(crate) const CONNECTED_REFRESH_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const EXPIRY_SKEW_SECONDS: u64 = 60;
const BROKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// What the UI needs to prompt the operator: show `user_code`, open the link.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceAuthStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    #[serde(default = "default_interval")]
    interval: u64,
    #[serde(default = "default_expires")]
    expires_in: u64,
}
fn default_interval() -> u64 {
    5
}
fn default_expires() -> u64 {
    600
}

/// The brokered token set, persisted so the node stays signed in across restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub obtained_at_epoch_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn jwt_exp_epoch_seconds(access_token: &str) -> Option<u64> {
    let payload = access_token.split('.').nth(1)?;
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let value = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
    value.get("exp").and_then(|exp| exp.as_u64())
}

fn token_expires_at_epoch_seconds(tokens: &TokenSet) -> Option<u64> {
    jwt_exp_epoch_seconds(&tokens.access_token).or_else(|| {
        let obtained_at = tokens.obtained_at_epoch_seconds?;
        let expires_in = tokens.expires_in?;
        Some(obtained_at.saturating_add(expires_in))
    })
}

fn token_is_fresh(tokens: &TokenSet) -> bool {
    token_expires_at_epoch_seconds(tokens)
        .map(|expires_at| expires_at > now_epoch_seconds().saturating_add(EXPIRY_SKEW_SECONDS))
        .unwrap_or(true)
}

fn broker_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(BROKER_REQUEST_TIMEOUT)
        .build()?)
}

pub fn requires_sign_in(tokens: &TokenSet) -> bool {
    !token_is_fresh(tokens)
        && tokens
            .refresh_token
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
}

/// Begin the grant: ask the broker for a device + user code.
pub async fn start() -> Result<DeviceAuthStart> {
    let client = broker_client()?;
    // JSON, not form-encoded: the broker (SvelteKit) rejects cross-site form
    // POSTs, but accepts JSON bodies on its OAuth wrappers.
    let resp = client
        .post(format!("{BROKER_ORIGIN}/oauth/device_authorization"))
        .json(&serde_json::json!({ "client_id": CLIENT_ID, "scope": SCOPE }))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow!("device_authorization failed ({status}): {body}"));
    }
    let parsed: DeviceCodeResponse = serde_json::from_str(&body)
        .map_err(|e| anyhow!("unexpected device_authorization response: {e}: {body}"))?;
    Ok(DeviceAuthStart {
        device_code: parsed.device_code,
        user_code: parsed.user_code,
        verification_uri: parsed.verification_uri,
        verification_uri_complete: parsed.verification_uri_complete,
        interval: parsed.interval,
        expires_in: parsed.expires_in,
    })
}

/// Poll the token endpoint until the operator approves, declines, or it expires.
pub async fn poll(device_code: &str, interval: u64, expires_in: u64) -> Result<TokenSet> {
    let client = broker_client()?;
    let mut wait = interval.max(1);
    let deadline = Instant::now() + Duration::from_secs(expires_in.max(1));
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("device code expired before it was approved"));
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let resp = client
            .post(format!("{BROKER_ORIGIN}/oauth/token"))
            .json(&serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
            }))
            .send()
            .await?;
        let status = resp.status();
        let parsed: TokenResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("unexpected token response: {e}"))?;
        if let Some(access_token) = parsed.access_token {
            return Ok(TokenSet {
                access_token,
                refresh_token: parsed.refresh_token,
                token_type: parsed.token_type,
                expires_in: parsed.expires_in,
                obtained_at_epoch_seconds: Some(now_epoch_seconds()),
            });
        }
        match parsed.error.as_deref() {
            // The operator hasn't approved yet — keep waiting at the given pace.
            Some("authorization_pending") => {}
            // The broker is asking us to back off.
            Some("slow_down") => wait += 5,
            Some(other) => {
                return Err(anyhow!(
                    "device authorization failed: {other} {}",
                    parsed.error_description.unwrap_or_default()
                ))
            }
            None => {
                return Err(anyhow!(
                    "token endpoint returned {status} with neither a token nor an error"
                ))
            }
        }
    }
}

async fn refresh(tokens: &TokenSet) -> Result<TokenSet> {
    let refresh_token = tokens
        .refresh_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow!("saved session has no refresh token"))?;

    let client = broker_client()?;
    let resp = client
        .post(format!("{BROKER_ORIGIN}/oauth/token"))
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await?;
    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| anyhow!("unexpected refresh response ({status}): {e}: {body}"))?;

    if let Some(access_token) = parsed.access_token {
        return Ok(TokenSet {
            access_token,
            refresh_token: parsed
                .refresh_token
                .or_else(|| tokens.refresh_token.clone()),
            token_type: parsed.token_type.or_else(|| tokens.token_type.clone()),
            expires_in: parsed.expires_in.or(tokens.expires_in),
            obtained_at_epoch_seconds: Some(now_epoch_seconds()),
        });
    }

    Err(anyhow!(
        "refresh failed ({status}): {} {}",
        parsed
            .error
            .unwrap_or_else(|| "missing_access_token".to_string()),
        parsed.error_description.unwrap_or_default()
    ))
}

// --- persistence -----------------------------------------------------------

/// Load the saved token set from `path`, if any.
pub fn load(path: &Path) -> Option<TokenSet> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Load the saved token and refresh it when possible. If the saved session is
/// expired and cannot be refreshed, clear it so the UI can present sign-in.
pub async fn load_fresh(path: &Path) -> Result<TokenSet> {
    let tokens =
        load(path).ok_or_else(|| anyhow!("auth_required: sign in with mere.world first"))?;
    if token_is_fresh(&tokens) {
        return Ok(tokens);
    }

    match refresh(&tokens).await {
        Ok(fresh) => {
            save(path, &fresh)?;
            Ok(fresh)
        }
        Err(error) => resolve_refresh_failure(path, &tokens, &error.to_string()),
    }
}

/// Decide what a failed refresh means for the saved session. A terminal grant
/// error usually means the session is dead — but not always: the broker's
/// refresh tokens are single-use, so two processes sharing `path` can race,
/// and the loser sees `invalid_grant` for a token its sibling just rotated
/// and saved. Only clear the file if it still holds the exact token set we
/// failed with; if it changed under us, trust the sibling's rewrite instead
/// of destroying it.
fn resolve_refresh_failure(path: &Path, attempted: &TokenSet, reason: &str) -> Result<TokenSet> {
    let terminal = reason.contains("no refresh token")
        || reason.contains("invalid_grant")
        || reason.contains("unauthorized")
        || reason.contains("(400")
        || reason.contains("(401")
        || reason.contains("(403");
    if !terminal {
        return Err(anyhow!("auth_refresh_failed: {reason}"));
    }

    match load(path) {
        Some(current)
            if current.access_token != attempted.access_token
                || current.refresh_token != attempted.refresh_token =>
        {
            if token_is_fresh(&current) {
                Ok(current)
            } else {
                Err(anyhow!(
                    "auth_refresh_failed: saved session was rotated by another process; retry"
                ))
            }
        }
        _ => {
            clear(path);
            Err(anyhow!(
                "auth_required: saved session expired; sign in with mere.world again"
            ))
        }
    }
}

/// Persist `tokens` to `path` (creating parent dirs).
pub fn save(path: &Path, tokens: &TokenSet) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary = path.with_extension(format!("tmp-{}-{suffix}", std::process::id()));
    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(tokens)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Forget the saved token (sign out).
pub fn clear(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_nodes_request_offline_access() {
        assert!(SCOPE
            .split_whitespace()
            .any(|scope| scope == "offline_access"));
    }

    #[test]
    fn connected_refresh_check_runs_inside_expiry_skew() {
        assert!(
            CONNECTED_REFRESH_CHECK_INTERVAL.as_secs() <= EXPIRY_SKEW_SECONDS,
            "a connected node must check often enough to refresh before expiry"
        );
        assert!(
            BROKER_REQUEST_TIMEOUT < CONNECTED_REFRESH_CHECK_INTERVAL,
            "a stalled broker request must finish before the next refresh check"
        );
    }

    fn fake_jwt(exp: u64) -> String {
        let header = general_purpose::URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let payload =
            general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
        format!("{header}.{payload}.signature")
    }

    #[test]
    fn reads_jwt_expiry_from_access_token() {
        let token = fake_jwt(1_700_000_000);
        assert_eq!(jwt_exp_epoch_seconds(&token), Some(1_700_000_000));
    }

    #[test]
    fn freshness_uses_jwt_expiry_with_skew() {
        let now = now_epoch_seconds();
        let fresh = TokenSet {
            access_token: fake_jwt(now + 120),
            refresh_token: None,
            token_type: Some("Bearer".to_string()),
            expires_in: Some(900),
            obtained_at_epoch_seconds: Some(now.saturating_sub(10)),
        };
        let nearly_expired = TokenSet {
            access_token: fake_jwt(now + 10),
            refresh_token: None,
            token_type: Some("Bearer".to_string()),
            expires_in: Some(900),
            obtained_at_epoch_seconds: Some(now.saturating_sub(10)),
        };

        assert!(token_is_fresh(&fresh));
        assert!(!token_is_fresh(&nearly_expired));
    }

    fn token_set(access: &str, refresh: Option<&str>, exp: u64) -> TokenSet {
        TokenSet {
            access_token: access.to_string(),
            refresh_token: refresh.map(str::to_string),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(900),
            obtained_at_epoch_seconds: Some(exp.saturating_sub(900)),
        }
    }

    fn temp_auth_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!(
                "mere-run-node-deviceauth-{label}-{}",
                std::process::id()
            ))
            .join("auth.json")
    }

    #[test]
    fn refresh_failure_clears_unchanged_session_and_requires_sign_in() {
        let path = temp_auth_path("unchanged");
        let attempted = token_set(&fake_jwt(now_epoch_seconds()), Some("odrt_old"), 0);
        save(&path, &attempted).unwrap();

        let result =
            resolve_refresh_failure(&path, &attempted, "refresh failed (400): invalid_grant");
        assert!(result
            .unwrap_err()
            .to_string()
            .starts_with("auth_required:"));
        assert!(!path.exists(), "dead session must be cleared");
    }

    #[test]
    fn refresh_failure_keeps_session_rotated_by_another_process() {
        let path = temp_auth_path("rotated");
        let attempted = token_set(&fake_jwt(now_epoch_seconds()), Some("odrt_old"), 0);
        let rotated = token_set(
            &fake_jwt(now_epoch_seconds() + 900),
            Some("odrt_new"),
            now_epoch_seconds() + 900,
        );
        save(&path, &rotated).unwrap();

        let result =
            resolve_refresh_failure(&path, &attempted, "refresh failed (400): invalid_grant");
        let fresh = result.expect("rotated session must be returned");
        assert_eq!(fresh.refresh_token.as_deref(), Some("odrt_new"));
        assert!(path.exists(), "rotated session must be preserved");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn refresh_failure_preserves_stale_rotated_session_for_retry() {
        let path = temp_auth_path("rotated-stale");
        let attempted = token_set(&fake_jwt(now_epoch_seconds()), Some("odrt_old"), 0);
        let rotated_stale = token_set(&fake_jwt(now_epoch_seconds()), Some("odrt_new"), 0);
        save(&path, &rotated_stale).unwrap();

        let result =
            resolve_refresh_failure(&path, &attempted, "refresh failed (400): invalid_grant");
        let error = result.unwrap_err().to_string();
        assert!(error.starts_with("auth_refresh_failed:"), "{error}");
        assert!(path.exists(), "rotated session must be preserved for retry");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn transient_refresh_failure_preserves_session() {
        let path = temp_auth_path("transient");
        let attempted = token_set(&fake_jwt(now_epoch_seconds()), Some("odrt_old"), 0);
        save(&path, &attempted).unwrap();

        let result =
            resolve_refresh_failure(&path, &attempted, "refresh failed (503): server_error");
        let error = result.unwrap_err().to_string();
        assert!(error.starts_with("auth_refresh_failed:"), "{error}");
        assert!(path.exists(), "session must survive transient failures");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[cfg(unix)]
    #[test]
    fn saved_session_is_owner_readable_only() {
        use std::os::unix::fs::PermissionsExt;

        let path = temp_auth_path("permissions");
        let tokens = token_set("access", Some("refresh"), now_epoch_seconds() + 900);
        save(&path, &tokens).unwrap();

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn freshness_falls_back_to_obtained_at_and_expires_in() {
        let now = now_epoch_seconds();
        let fresh = TokenSet {
            access_token: "opaque-token".to_string(),
            refresh_token: None,
            token_type: Some("Bearer".to_string()),
            expires_in: Some(900),
            obtained_at_epoch_seconds: Some(now),
        };
        let expired = TokenSet {
            access_token: "opaque-token".to_string(),
            refresh_token: None,
            token_type: Some("Bearer".to_string()),
            expires_in: Some(30),
            obtained_at_epoch_seconds: Some(now.saturating_sub(120)),
        };

        assert!(token_is_fresh(&fresh));
        assert!(!token_is_fresh(&expired));
    }
}
