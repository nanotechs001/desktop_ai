use crate::error::DbError;
use crate::models::OAuthClientRow;

/// Storage for OAuth clients registered with MCP authorization servers.
///
/// Object-safe via `async_trait` to support `Arc<dyn IOAuthClientRepository>`.
#[async_trait::async_trait]
pub trait IOAuthClientRepository: Send + Sync {
    /// Gets the registered client for a server URL, or `None` if not found.
    async fn get_by_url(&self, user_id: &str, server_url: &str) -> Result<Option<OAuthClientRow>, DbError>;

    /// Inserts or replaces the registered client for a server URL.
    async fn upsert(&self, params: UpsertOAuthClientParams<'_>) -> Result<OAuthClientRow, DbError>;
}

/// Parameters for inserting or replacing a registered OAuth client.
#[derive(Debug)]
pub struct UpsertOAuthClientParams<'a> {
    pub user_id: &'a str,
    pub server_url: &'a str,
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    pub redirect_uri: &'a str,
}
