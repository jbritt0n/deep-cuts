//! API-07: quota-aware client. Honours Retry-After, backs off exponentially,
//! refreshes tokens once on 401, and on QUOTA_EXCEEDED pauses enrichment until
//! midnight. Blocking (used inside spawn_blocking / scheduler threads) so the
//! UI thread is never involved.

use super::auth::{self, Tokens};
use super::endpoints as ep;
use crate::db::Db;
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

pub struct SpotifyClient {
    http: reqwest::blocking::Client,
    tokens: Mutex<Option<Tokens>>,
    client_id: String,
    /// Epoch seconds until which non-essential calls (enrichment) are paused.
    pub paused_until: Mutex<u64>,
}

#[derive(Debug)]
pub enum ApiError {
    Quota,          // QUOTA_EXCEEDED — stop for the day
    Unauthorized,   // refresh failed / not connected
    /// Phase 9b: a non-retryable HTTP status with Spotify's error body, so callers can branch on
    /// specific cases (404 NO_ACTIVE_DEVICE for the queue, 403 missing scope) instead of parsing text.
    Http { status: u16, body: String },
    Other(anyhow::Error),
}
impl From<anyhow::Error> for ApiError { fn from(e: anyhow::Error) -> Self { ApiError::Other(e) } }
impl From<reqwest::Error> for ApiError { fn from(e: reqwest::Error) -> Self { ApiError::Other(e.into()) } }
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Quota => write!(f, "Spotify quota exceeded for today"),
            ApiError::Unauthorized => write!(f, "Spotify is not connected"),
            ApiError::Http { status, body } => write!(f, "Spotify {status}: {}", body.chars().take(200).collect::<String>()),
            ApiError::Other(e) => write!(f, "{e:#}"),
        }
    }
}

impl SpotifyClient {
    pub fn new() -> Result<Self> {
        let client_id = secrets::get(secrets::SPOTIFY_CLIENT_ID)?.unwrap_or_default();
        Ok(Self {
            http: reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).user_agent("DeepCuts/3.0").build()?,
            tokens: Mutex::new(auth::load_tokens().unwrap_or(None)),
            client_id,
            paused_until: Mutex::new(0),
        })
    }

    pub fn is_connected(&self) -> bool { self.tokens.lock().map(|t| t.is_some()).unwrap_or(false) }
    /// Whether the stored consent includes `scope` (Spotify returns the granted scopes space-separated).
    pub fn has_scope(&self, scope: &str) -> bool {
        self.tokens.lock().ok().and_then(|g| g.as_ref().map(|t| t.scope.split_whitespace().any(|s| s == scope))).unwrap_or(false)
    }
    pub fn client_id(&self) -> String { self.client_id.clone() }
    pub fn set_tokens(&self, t: Option<Tokens>) { if let Ok(mut g) = self.tokens.lock() { *g = t; } }
    pub fn is_paused(&self) -> bool { *self.paused_until.lock().unwrap_or_else(|p| p.into_inner()) > auth::now_secs() }

    fn access_token(&self) -> Result<String, ApiError> {
        let mut g = self.tokens.lock().unwrap_or_else(|p| p.into_inner());
        let t = g.as_ref().ok_or(ApiError::Unauthorized)?.clone();
        if t.is_expired() {
            let nt = auth::refresh(&self.client_id, &t).map_err(|_| ApiError::Unauthorized)?;
            *g = Some(nt.clone());
            return Ok(nt.access_token);
        }
        Ok(t.access_token)
    }

    fn pause_until_midnight(&self) {
        let now = auth::now_secs();
        let midnight = (now / 86400 + 1) * 86400;
        if let Ok(mut p) = self.paused_until.lock() { *p = midnight; }
    }

    /// GET with backoff. `essential` calls (poll, writes) ignore the enrichment pause.
    pub fn get(&self, db: &Db, url: &str, essential: bool) -> Result<Value, ApiError> {
        if !essential && self.is_paused() { return Err(ApiError::Quota); }
        self.request(db, reqwest::Method::GET, url, None)
    }

    pub fn post(&self, db: &Db, url: &str, body: Value) -> Result<Value, ApiError> {
        self.request(db, reqwest::Method::POST, url, Some(body))
    }

    fn request(&self, db: &Db, method: reqwest::Method, url: &str, body: Option<Value>) -> Result<Value, ApiError> {
        let mut delay = 2u64;
        let mut refreshed = false;
        for attempt in 0..5 {
            let token = self.access_token()?;
            let mut req = self.http.request(method.clone(), url).bearer_auth(&token);
            if let Some(b) = &body { req = req.json(b); }
            let resp = req.send()?;
            let status = resp.status();
            let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
            let text = resp.text().unwrap_or_default();
            let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('spotify', ?, ?)",
                &[json!(url.split('?').next().unwrap_or(url).replace(ep::API_BASE, "")), json!(status.as_u16())]);
            match status.as_u16() {
                200..=299 => return Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).context("Spotify returned non-JSON")? }),
                401 if !refreshed => {
                    let t = self.tokens.lock().unwrap_or_else(|p| p.into_inner()).clone().ok_or(ApiError::Unauthorized)?;
                    let nt = auth::refresh(&self.client_id, &t).map_err(|_| ApiError::Unauthorized)?;
                    self.set_tokens(Some(nt));
                    refreshed = true;
                }
                401 => return Err(ApiError::Unauthorized),
                429 => {
                    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    if v[ep::f::ERROR][ep::f::REASON].as_str() == Some(ep::f::QUOTA_EXCEEDED) {
                        self.pause_until_midnight();
                        db.log_activity("spotify", "warn", "Spotify daily quota exceeded — enrichment paused until midnight", None);
                        return Err(ApiError::Quota);
                    }
                    let wait = retry_after.unwrap_or(delay).min(120);
                    log::warn!("spotify 429 on {url}: waiting {wait}s (attempt {attempt})");
                    std::thread::sleep(Duration::from_secs(wait));
                    delay = (delay * 2).min(120);
                }
                500..=599 => { std::thread::sleep(Duration::from_secs(delay)); delay = (delay * 2).min(60); }
                code => return Err(ApiError::Http { status: code, body: text }),
            }
        }
        Err(anyhow!("Spotify kept rate-limiting {url}; gave up for now").into())
    }

    /// Calls made in the last hour (for the adaptive enrichment budget).
    pub fn calls_last_hour(&self, db: &Db) -> usize {
        db.scalar_i64("SELECT COUNT(*) FROM api_calls WHERE service = 'spotify' AND called_at >= now() - INTERVAL 1 HOUR").unwrap_or(0) as usize
    }
}
