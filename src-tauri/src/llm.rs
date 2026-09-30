//! Phase 9e — local LLM provider: Ollama over HTTP on the owner's machine (spec §9.1, LLM-02 JSON mode).
//! The model only ever sees what the frontend sends it — a schema summary, the question, and the rows of a
//! read-only query — never tokens or keys (NFR-04). SQL the model writes comes back through the normal `query`
//! command, so `Db::assert_read_only` gates it like any other query. The base URL is a setting
//! (`ollama_url`, default http://127.0.0.1:11434) so a Docker deployment can point at a host-side Ollama.
//!
//! Phase 10d — one controller for every local-model call (owner: "the model times out at 240 s; my old PC is
//! slower than that"). Everything that used to be hard-coded is a setting read on each call (Settings → Local model):
//!   * `llm_timeout_s`     — how long one reply may take (default 900 s, 60 s … 2 h). A timeout is reported as
//!                           `slow_model`, with the fix in the message, not as a network failure.
//!   * `llm_num_ctx`       — context window (default 4096). Smaller is faster and lighter on old hardware.
//!   * `llm_keep_alive_min`— how long Ollama keeps the model loaded after a call (default 30; -1 = forever). Reloading
//!                           a model is often the slowest part of a call on a spinning disk.
//!   * `llm_num_thread`    — CPU threads (0 = Ollama decides).
//!   * `llm_num_predict`   — longest reply in tokens (default 700; -1 = no cap).
//!   * `llm_structured`    — send a JSON schema (Ollama ≥ 0.5) so small models can only answer from fixed choices.
//! Every call is logged to `llm_calls` (purpose, time, tokens) so the owner can see how long jobs really take.
//! Foreground calls (Ask, Roast, Liner Notes) mark themselves busy; background lyric tagging waits for them, so a
//! page request never queues behind a batch on a single slow CPU.

use crate::db::Db;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

pub const DEFAULT_URL: &str = "http://127.0.0.1:11434";

fn meta(db: &Db, key: &str) -> Option<String> {
    db.query("SELECT value FROM app_meta WHERE key = ?", &[json!(key)]).ok()
        .and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str()).map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
}
fn meta_i64(db: &Db, key: &str, def: i64, lo: i64, hi: i64) -> i64 {
    meta(db, key).and_then(|v| v.parse::<f64>().ok()).map(|v| (v.round() as i64).clamp(lo, hi)).unwrap_or(def)
}

pub fn base_url(db: &Db) -> String {
    meta(db, "ollama_url").map(|s| s.trim_end_matches('/').to_string()).unwrap_or_else(|| DEFAULT_URL.to_string())
}

/// Phase 10d: the knobs, read fresh on every call so a Settings change applies to the next request.
#[derive(Debug, Clone, Serialize)]
pub struct LlmConfig { pub timeout_s: u64, pub num_ctx: i64, pub keep_alive_min: i64, pub num_thread: i64, pub num_predict: i64, pub structured: bool }
impl LlmConfig {
    pub fn load(db: &Db) -> Self {
        LlmConfig {
            timeout_s: meta_i64(db, "llm_timeout_s", 900, 60, 7200) as u64,
            num_ctx: meta_i64(db, "llm_num_ctx", 4096, 1024, 32768),
            keep_alive_min: meta_i64(db, "llm_keep_alive_min", 30, -1, 1440),
            num_thread: meta_i64(db, "llm_num_thread", 0, 0, 64),
            num_predict: meta_i64(db, "llm_num_predict", 700, -1, 8192),
            structured: meta(db, "llm_structured").map(|v| v != "false").unwrap_or(true),
        }
    }
}

// ---- foreground / background coordination
static FOREGROUND: AtomicUsize = AtomicUsize::new(0);
/// Held for the length of a page-initiated call. Background jobs check `foreground_busy()` between songs.
pub struct Foreground;
impl Foreground { pub fn enter() -> Self { FOREGROUND.fetch_add(1, Ordering::SeqCst); Foreground } }
impl Drop for Foreground { fn drop(&mut self) { FOREGROUND.fetch_sub(1, Ordering::SeqCst); } }
pub fn foreground_busy() -> bool { FOREGROUND.load(Ordering::SeqCst) > 0 }

#[derive(Debug, Serialize)]
pub struct LlmStatus { pub reachable: bool, pub url: String, pub models: Vec<String>, pub error: Option<String> }

pub fn status(db: &Db) -> LlmStatus {
    let url = base_url(db);
    let http = match reqwest::blocking::Client::builder().timeout(Duration::from_secs(4)).build() { Ok(c) => c, Err(e) => return LlmStatus { reachable: false, url, models: vec![], error: Some(e.to_string()) } };
    match http.get(format!("{url}/api/tags")).send().and_then(|r| r.error_for_status()).and_then(|r| r.json::<Value>()) {
        Ok(v) => {
            let models = v["models"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str().map(str::to_string)).collect()).unwrap_or_default();
            LlmStatus { reachable: true, url, models, error: None }
        }
        Err(e) => LlmStatus { reachable: false, url, models: vec![], error: Some(format!("{e}")) },
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMsg { pub role: String, pub content: String }

/// How the reply should be shaped.
pub enum Format { Text, Json, Schema(Value) }

#[derive(Debug, Clone, Serialize)]
pub struct ChatReply { pub content: String, pub ms: u64, pub load_ms: u64, pub prompt_tokens: i64, pub eval_tokens: i64, pub tokens_per_s: f64, pub model: String }

fn log_call(db: &Db, model: &str, purpose: &str, ms: u64, load_ms: u64, pt: i64, et: i64, error: Option<&str>) {
    let _ = db.exec("INSERT INTO llm_calls (model, purpose, ms, load_ms, prompt_tokens, eval_tokens, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[json!(model), json!(purpose), json!(ms as i64), json!(load_ms as i64), json!(pt), json!(et), json!(error.is_none()), json!(error.map(|e| e.chars().take(300).collect::<String>()))]);
    let _ = db.exec("DELETE FROM llm_calls WHERE called_at < now() - INTERVAL 45 DAY", &[]);
}

/// Phase 10d: one non-streaming completion with the owner's settings applied. `purpose` labels the call log.
pub fn chat_ex(db: &Db, model: &str, messages: &[ChatMsg], format: &Format, temperature: f32, purpose: &str, num_predict: Option<i64>) -> Result<ChatReply> {
    let cfg = LlmConfig::load(db);
    let url = base_url(db);
    let http = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(cfg.timeout_s)).build()?;
    let mut options = json!({ "temperature": temperature, "num_ctx": cfg.num_ctx });
    let np = num_predict.unwrap_or(cfg.num_predict);
    if np != 0 { options["num_predict"] = json!(np); }
    if cfg.num_thread > 0 { options["num_thread"] = json!(cfg.num_thread); }
    let keep_alive = if cfg.keep_alive_min < 0 { json!(-1) } else { json!(format!("{}m", cfg.keep_alive_min)) };
    let mut body = json!({ "model": model, "messages": messages, "stream": false, "options": options, "keep_alive": keep_alive });
    match format { Format::Text => {}, Format::Json => { body["format"] = json!("json"); }, Format::Schema(s) => { body["format"] = s.clone(); } }
    let started = std::time::Instant::now();
    let slow = |e: &reqwest::Error| -> anyhow::Error {
        if e.is_timeout() { anyhow!("slow_model: the local model took longer than {} s to answer — raise the timeout in Settings → Local model, lower the context window, or try again (Ollama keeps working on it and the next try is often faster once the model is loaded)", cfg.timeout_s) }
        else if e.is_connect() { anyhow!("could not reach Ollama at {url} ({e}) — start it with `ollama serve` or fix the URL in Settings → Local model") }
        else { anyhow!("error sending request to Ollama: {e}") }
    };
    let result: Result<ChatReply> = (|| -> Result<ChatReply> {
        let resp = http.post(format!("{url}/api/chat")).json(&body).send().map_err(|e| slow(&e))?;
        let code = resp.status().as_u16();
        let text = resp.text().map_err(|e| slow(&e))?;
        let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('ollama', ?, ?)", &[json!(format!("chat:{model}")), json!(code as i64)]);
        if !(200..300).contains(&code) { return Err(anyhow!("Ollama {code}: {}", text.chars().take(300).collect::<String>())); }
        let v: Value = serde_json::from_str(&text).map_err(|e| anyhow!("Ollama returned non-JSON: {e}"))?;
        let ns = |k: &str| v[k].as_u64().unwrap_or(0);
        let et = v["eval_count"].as_i64().unwrap_or(0);
        let eval_s = ns("eval_duration") as f64 / 1e9;
        Ok(ChatReply {
            content: v["message"]["content"].as_str().unwrap_or("").to_string(),
            ms: started.elapsed().as_millis() as u64, load_ms: ns("load_duration") / 1_000_000,
            prompt_tokens: v["prompt_eval_count"].as_i64().unwrap_or(0), eval_tokens: et,
            tokens_per_s: if eval_s > 0.0 { ((et as f64 / eval_s) * 10.0).round() / 10.0 } else { 0.0 },
            model: model.to_string(),
        })
    })();
    match &result {
        Ok(r) => { log_call(db, model, purpose, r.ms, r.load_ms, r.prompt_tokens, r.eval_tokens, None); log::info!("ollama {model} [{purpose}]: {} chars in {} ms", r.content.len(), r.ms); }
        Err(e) => log_call(db, model, purpose, started.elapsed().as_millis() as u64, 0, 0, 0, Some(&e.to_string())),
    }
    result
}

/// Schema replies need Ollama ≥ 0.5; older servers reject an object `format`. Try the schema, fall back to plain JSON mode.
pub fn chat_structured(db: &Db, model: &str, messages: &[ChatMsg], schema: Value, temperature: f32, purpose: &str, num_predict: Option<i64>) -> Result<ChatReply> {
    if !LlmConfig::load(db).structured { return chat_ex(db, model, messages, &Format::Json, temperature, purpose, num_predict); }
    match chat_ex(db, model, messages, &Format::Schema(schema), temperature, purpose, num_predict) {
        Err(e) if { let m = e.to_string().to_lowercase(); m.contains("ollama 400") || m.contains("ollama 500") && m.contains("format") } => {
            log::warn!("ollama rejected a JSON schema ({e}); retrying in plain JSON mode");
            chat_ex(db, model, messages, &Format::Json, temperature, purpose, num_predict)
        }
        other => other,
    }
}

/// The original entry point (Ask, Roast, Liner Notes, Playlist from words go through `llm_chat`).
pub fn chat(db: &Db, model: &str, messages: &[ChatMsg], json_mode: bool, temperature: f32) -> Result<String> {
    chat_ex(db, model, messages, if json_mode { &Format::Json } else { &Format::Text }, temperature, "chat", None).map(|r| r.content)
}

/// The model the owner picked, else the first one Ollama has.
pub fn chosen_model(db: &Db) -> Option<String> { meta(db, "ollama_model") }

/// Settings → Local model → "Test": a tiny prompt, timed, so the owner can see load time and tokens/s on their machine.
pub fn test(db: &Db, model: &str) -> Result<ChatReply> {
    let msgs = vec![ChatMsg { role: "user".into(), content: "Reply with exactly one word: ready".into() }];
    chat_ex(db, model, &msgs, &Format::Text, 0.0, "test", Some(8))
}

#[cfg(test)]
mod tests {
    #[test] fn timeout_message_is_classified_slow() {
        assert_eq!(crate::commands::error_code("slow_model: the local model took longer than 900 s"), "slow_model");
    }
}
