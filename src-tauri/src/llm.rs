//! Phase 4 seam (spec §9.1, deferred). Compiled only with `--features llm`.
//! One interface, two providers (Ollama, OpenAI-compatible). JSON-mode
//! everywhere (LLM-02). The LLM never receives tokens or keys (NFR-04).

use serde_json::Value;

pub struct CompletionOpts {
    pub json_schema: Option<Value>,
    pub temperature: f32,
    pub max_tokens: u32,
}

pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn complete(&self, messages: &[(String, String)], opts: &CompletionOpts) -> anyhow::Result<Value>;
}

pub enum Role { Reasoning, Writing }
