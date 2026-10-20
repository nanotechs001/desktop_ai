use aionui_common::TimestampMs;
use serde::{Deserialize, Serialize};

/// Row mapping for the `oauth_clients` table.
///
/// An OAuth client registered for an MCP server through Dynamic Client
/// Registration (RFC 7591), keyed by (user, MCP server URL).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OAuthClientRow {
    pub user_id: String,
    /// MCP server URL the client was registered for.
    pub server_url: String,
    /// Issuer of the authorization server that issued the client.
    pub issuer: String,
    pub client_id: String,
    /// Present only when the authorization server issued a secret.
    pub client_secret: Option<String>,
    /// Redirect URI the client was registered with.
    pub redirect_uri: String,
    pub created_at: TimestampMs,
    pub updated_at: TimestampMs,
}
