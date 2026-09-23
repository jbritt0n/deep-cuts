//! OS keyring wrapper (NFR-04). Every token / API key goes through here; nothing
//! sensitive is ever written to the database or a plaintext file.

use anyhow::{Context, Result};

const SERVICE: &str = "deep-cuts";

pub fn set(key: &str, value: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, key)?.set_password(value).with_context(|| format!("storing {key} in the OS keyring"))
}

pub fn get(key: &str) -> Result<Option<String>> {
    match keyring::Entry::new(SERVICE, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {key} from the OS keyring")),
    }
}

pub fn delete(key: &str) -> Result<()> {
    match keyring::Entry::new(SERVICE, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub const SPOTIFY_TOKENS: &str = "spotify_tokens";
pub const SPOTIFY_CLIENT_ID: &str = "spotify_client_id";
pub const LASTFM_KEY: &str = "lastfm_api_key";
pub const LASTFM_USER: &str = "lastfm_username";
pub const STATSFM_KEY: &str = "statsfm_api_key";
pub const FREQBLOG_KEY: &str = "freqblog_api_key";   // Phase 9g
