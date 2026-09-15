//! Phase 9e — local LLM provider: Ollama over HTTP on the owner's machine (spec §9.1, LLM-02 JSON mode).
//! The model only ever sees what the frontend sends it — a schema summary, the question, and the rows of a
//! read-only query — never tokens or keys (NFR-04). SQL the model writes comes back through the normal `query`
//! command, so `Db::assert_read_only` gates it like any other query. The base URL is a setting
//! (`ollama_url`, default http://127.0.0.1:11434) so a Docker deployment can point at a host-side Ollama.

use crate::db::Db;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_URL: &str = "http://127.0.0.1:11434";

pub fn base_url(db: &Db) -> String {
    db.query("SELECT value FROM app_meta WHERE key = 'ollama_url'", &[]).ok()
        .and_then(|r| r.first().and_then(|m| m.get("value")).and_then(|v| v.as_str()).map(|s| s.trim().trim_end_matches('/').to_string()))
        .filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string())
}

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

/// One non-streaming chat completion. `json_mode` asks Ollama for a JSON-only reply (format: "json").
pub fn chat(db: &Db, model: &str, messages: &[ChatMsg], json_mode: bool, temperature: f32) -> Result<String> {
    let url = base_url(db);
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(240)).build()?;
    let mut body = json!({ "model": model, "messages": messages, "stream": false, "options": { "temperature": temperature, "num_ctx": 8192 } });
    if json_mode { body["format"] = json!("json"); }
    let started = std::time::Instant::now();
    let resp = http.post(format!("{url}/api/chat")).json(&body).send()?;
    let code = resp.status().as_u16();
    let text = resp.text()?;
    if !(200..300).contains(&code) { return Err(anyhow!("Ollama {code}: {}", text.chars().take(300).collect::<String>())); }
    let v: Value = serde_json::from_str(&text).map_err(|e| anyhow!("Ollama returned non-JSON: {e}"))?;
    let content = v["message"]["content"].as_str().unwrap_or("").to_string();
    let _ = db.exec("INSERT INTO api_calls (service, endpoint, status) VALUES ('ollama', ?, ?)", &[json!(format!("chat:{model}")), json!(code as i64)]);
    log::info!("ollama {model}: {} chars in {} ms", content.len(), started.elapsed().as_millis());
    Ok(content)
}
