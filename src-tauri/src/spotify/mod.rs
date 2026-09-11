//! Spotify Web API — 2026 development-mode rules (spec §11). Every endpoint
//! path and response field lives in `endpoints.rs` (API-09) so a Spotify
//! change is a one-file edit. `auth.rs` is PKCE + loopback; `client.rs` is the
//! quota-aware HTTP layer; `sync.rs` is the poller, liked-songs sync and lazy
//! enrichment.

pub mod auth;
pub mod client;
pub mod endpoints;
pub mod sync;
