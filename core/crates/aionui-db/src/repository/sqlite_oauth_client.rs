use sqlx::SqlitePool;

use crate::error::DbError;
use crate::models::OAuthClientRow;
use crate::repository::oauth_client::{IOAuthClientRepository, UpsertOAuthClientParams};

/// SQLite-backed implementation of [`IOAuthClientRepository`].
#[derive(Clone, Debug)]
pub struct SqliteOAuthClientRepository {
    pool: SqlitePool,
}

impl SqliteOAuthClientRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl IOAuthClientRepository for SqliteOAuthClientRepository {
    async fn get_by_url(&self, user_id: &str, server_url: &str) -> Result<Option<OAuthClientRow>, DbError> {
        let row =
            sqlx::query_as::<_, OAuthClientRow>("SELECT * FROM oauth_clients WHERE user_id = ? AND server_url = ?")
                .bind(user_id)
                .bind(server_url)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row)
    }

    async fn upsert(&self, params: UpsertOAuthClientParams<'_>) -> Result<OAuthClientRow, DbError> {
        let now = aionui_common::now_ms();
        sqlx::query(
            "INSERT INTO oauth_clients \
                (user_id, server_url, issuer, client_id, client_secret, redirect_uri, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(user_id, server_url) DO UPDATE SET \
                issuer = excluded.issuer, \
                client_id = excluded.client_id, \
                client_secret = excluded.client_secret, \
                redirect_uri = excluded.redirect_uri, \
                updated_at = excluded.updated_at",
        )
        .bind(params.user_id)
        .bind(params.server_url)
        .bind(params.issuer)
        .bind(params.client_id)
        .bind(params.client_secret)
        .bind(params.redirect_uri)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_by_url(params.user_id, params.server_url)
            .await?
            .ok_or_else(|| DbError::Init("Upsert succeeded but row not found".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_database_memory;

    const USER_A: &str = "system_default_user";
    const URL: &str = "https://mcp.example.com/mcp";

    fn params(client_id: &str) -> UpsertOAuthClientParams<'_> {
        UpsertOAuthClientParams {
            user_id: USER_A,
            server_url: URL,
            issuer: "https://mcp.example.com",
            client_id,
            client_secret: None,
            redirect_uri: "http://127.0.0.1:4100/callback",
        }
    }

    #[tokio::test]
    async fn get_by_url_returns_none_when_absent() {
        let db = init_database_memory().await.unwrap();
        let repo = SqliteOAuthClientRepository::new(db.pool().clone());
        assert!(repo.get_by_url(USER_A, URL).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn upsert_inserts_then_replaces_registration() {
        let db = init_database_memory().await.unwrap();
        let repo = SqliteOAuthClientRepository::new(db.pool().clone());

        let first = repo.upsert(params("client-1")).await.unwrap();
        assert_eq!(first.client_id, "client-1");
        assert_eq!(first.issuer, "https://mcp.example.com");
        assert!(first.client_secret.is_none());

        let second = repo
            .upsert(UpsertOAuthClientParams {
                client_secret: Some("s3cret"),
                redirect_uri: "http://127.0.0.1:4200/callback",
                ..params("client-2")
            })
            .await
            .unwrap();
        assert_eq!(second.client_id, "client-2");
        assert_eq!(second.client_secret.as_deref(), Some("s3cret"));
        assert_eq!(second.redirect_uri, "http://127.0.0.1:4200/callback");
        assert_eq!(second.created_at, first.created_at);
    }

    #[tokio::test]
    async fn upsert_rejects_unknown_user() {
        let db = init_database_memory().await.unwrap();
        let repo = SqliteOAuthClientRepository::new(db.pool().clone());
        let err = repo
            .upsert(UpsertOAuthClientParams {
                user_id: "no-such-user",
                ..params("client-1")
            })
            .await
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("foreign key"), "{err}");
    }
}
