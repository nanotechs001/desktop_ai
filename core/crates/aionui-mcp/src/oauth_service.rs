use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use aionui_api_types::{OAuthLoginResponse, OAuthStatusResponse};
use aionui_common::{TimestampMs, now_ms};
use aionui_db::models::OAuthClientRow;
use aionui_db::{IOAuthClientRepository, IOAuthTokenRepository, UpsertOAuthClientParams, UpsertOAuthTokenParams};
use oauth2::basic::{BasicClient, BasicErrorResponse};
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, HttpRequest, HttpResponse, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, RefreshToken, RequestTokenError, Scope, TokenResponse, TokenUrl,
};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::error::McpError;
use crate::oauth_callback::{CallbackCode, bind_callback_listener, serve_one_callback, short_reason};
use crate::oauth_discovery::{MAX_RESPONSE_BYTES, OAuthDiscovery, discover, oauth_http_client, read_capped};
use crate::oauth_registration::register_client;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// How long the callback server waits for the browser redirect. Users may
/// have to sign in to the provider first, so this is generous.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How long the browser's callback request waits for the token exchange
/// before it gets a "still finishing" page.
const OUTCOME_TIMEOUT: Duration = Duration::from_secs(30);

/// Client ID used when the authorization server offers no registration
/// endpoint (public client, no secret).
const DEFAULT_CLIENT_ID: &str = "aionui";

/// Token expiry safety margin (refresh 5 minutes before expiration).
const EXPIRY_MARGIN_MS: i64 = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pending login state
// ---------------------------------------------------------------------------

/// State held while waiting for the OAuth callback redirect.
///
/// Stores endpoint URLs rather than the typed `BasicClient` to avoid
/// complex generic type parameters from the `oauth2` crate.
///
/// Keyed by `(user_id, oauth_state)`, so a redirect is only accepted with a
/// state this service issued.
struct PendingLogin {
    pkce_verifier: PkceCodeVerifier,
    auth_url: String,
    token_url: String,
    redirect_url: String,
    client: ClientCredentials,
    resource: String,
}

/// A running callback server and the oauth_state it was started for.
type CallbackWait = (String, JoinHandle<()>);

/// OAuth client identity used against one authorization server.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClientCredentials {
    client_id: String,
    client_secret: Option<String>,
}

impl ClientCredentials {
    fn default_client() -> Self {
        Self {
            client_id: DEFAULT_CLIENT_ID.to_string(),
            client_secret: None,
        }
    }

    fn from_row(row: &OAuthClientRow) -> Self {
        Self {
            client_id: row.client_id.clone(),
            client_secret: row.client_secret.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// McpOAuthService
// ---------------------------------------------------------------------------

/// Service for MCP server OAuth 2.0 PKCE authentication.
///
/// Manages the full lifecycle: discovery → client registration → authorize →
/// callback → token exchange → storage → refresh → logout.
#[derive(Clone)]
pub struct McpOAuthService {
    token_repo: Arc<dyn IOAuthTokenRepository>,
    client_repo: Arc<dyn IOAuthClientRepository>,
    /// Mutex protecting pending login state by (user_id, oauth_state).
    pending: Arc<Mutex<HashMap<(String, String), PendingLogin>>>,
    /// The running callback server per user, tagged with its oauth_state.
    waits: Arc<Mutex<HashMap<String, CallbackWait>>>,
    callback_timeout: Duration,
    outcome_timeout: Duration,
}

impl McpOAuthService {
    pub fn new(token_repo: Arc<dyn IOAuthTokenRepository>, client_repo: Arc<dyn IOAuthClientRepository>) -> Self {
        Self {
            token_repo,
            client_repo,
            pending: Arc::new(Mutex::new(HashMap::new())),
            waits: Arc::new(Mutex::new(HashMap::new())),
            callback_timeout: CALLBACK_TIMEOUT,
            outcome_timeout: OUTCOME_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_timeouts(self, callback_timeout: Duration, outcome_timeout: Duration) -> Self {
        Self {
            callback_timeout,
            outcome_timeout,
            ..self
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Check whether the given server URL has a valid (non-expired) OAuth token.
    pub async fn check_oauth_status(&self, user_id: &str, server_url: &str) -> Result<OAuthStatusResponse, McpError> {
        let authenticated = self.has_valid_token(user_id, server_url).await?;
        Ok(OAuthStatusResponse { authenticated })
    }

    /// Start the OAuth PKCE login flow for the given MCP server URL.
    ///
    /// 1. Discover the authorization server and register a client
    /// 2. Generate PKCE challenge
    /// 3. Start local callback server
    /// 4. Build authorization URL and open it in the system browser
    /// 5. Wait for the redirect with the authorization code
    /// 6. Exchange code for tokens and persist them
    pub async fn login(&self, user_id: &str, server_url: &str) -> Result<OAuthLoginResponse, McpError> {
        let (authorize_url, listener, state) = match self.prepare_login_flow(user_id, server_url).await {
            Ok(prepared) => prepared,
            Err(e) => {
                warn!(server_url, error = %e, "OAuth login could not start");
                return Err(e);
            }
        };

        // Open browser.
        debug!(url = %authorize_url, "Opening browser for OAuth authorization");
        if let Err(e) = open::that(&authorize_url) {
            warn!("Failed to open browser: {e}");
        }

        Ok(self.complete_login(user_id, server_url, &state, listener).await)
    }

    /// Logout from the given MCP server URL (delete stored token).
    ///
    /// Idempotent: returns Ok even if no token was stored.
    pub async fn logout(&self, user_id: &str, server_url: &str) -> Result<(), McpError> {
        match self.token_repo.delete(user_id, server_url).await {
            Ok(()) => {
                debug!(server_url, "OAuth token deleted");
                Ok(())
            }
            Err(aionui_db::DbError::NotFound(_)) => {
                debug!(server_url, "No OAuth token to delete (idempotent)");
                Ok(())
            }
            Err(e) => Err(McpError::Database(e)),
        }
    }

    /// Return the list of server URLs that have stored OAuth tokens.
    pub async fn get_authenticated_servers(&self, user_id: &str) -> Result<Vec<String>, McpError> {
        let urls = self.token_repo.list_authenticated_urls(user_id).await?;
        Ok(urls)
    }

    /// Get a valid access token for the given server URL.
    ///
    /// If the stored token is expired and a refresh token is available,
    /// automatically refreshes before returning.
    /// Returns `None` if no token is stored for this URL.
    pub async fn get_token(&self, user_id: &str, server_url: &str) -> Result<Option<String>, McpError> {
        let row = match self.token_repo.get_by_url(user_id, server_url).await? {
            Some(row) => row,
            None => return Ok(None),
        };

        // Check if token is expired (with safety margin).
        if let Some(expires_at) = row.expires_at {
            let now = now_ms();
            if now >= expires_at - EXPIRY_MARGIN_MS
                && let Some(ref refresh_token) = row.refresh_token
            {
                match self.refresh_token(user_id, server_url, refresh_token).await {
                    Ok(new_token) => return Ok(Some(new_token)),
                    Err(e) => {
                        warn!(
                            server_url,
                            error = %e,
                            "Token refresh failed, returning expired token"
                        );
                    }
                }
            }
        }

        Ok(Some(row.access_token))
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Discover endpoints, register or reuse a client, generate PKCE, bind the
    /// callback server, store pending state, and return the authorization URL,
    /// listener and oauth_state. Cancels the user's older pending sign-in first.
    async fn prepare_login_flow(
        &self,
        user_id: &str,
        server_url: &str,
    ) -> Result<(String, TcpListener, String), McpError> {
        let http = oauth_http_client()?;
        let discovery = discover(&http, server_url).await?;
        let stored = self.client_repo.get_by_url(user_id, server_url).await?;

        let auth_url = AuthUrl::new(discovery.metadata.authorization_endpoint.clone())
            .map_err(|e| McpError::OAuth(format!("Invalid auth URL: {e}")))?;
        let token_url = TokenUrl::new(discovery.metadata.token_endpoint.clone())
            .map_err(|e| McpError::OAuth(format!("Invalid token URL: {e}")))?;

        // Close an older callback server first so its port can be reused.
        if self.stop_wait(user_id, None, true).await {
            info!(server_url, "Cancelled an older pending OAuth sign-in");
        }
        let listener = bind_callback_listener(stored.as_ref().and_then(registered_callback_port)).await?;
        let callback_port = listener
            .local_addr()
            .map_err(|e| McpError::OAuth(format!("Failed to get callback port: {e}")))?
            .port();

        let redirect_url_str = format!("http://127.0.0.1:{callback_port}/callback");
        let redirect = RedirectUrl::new(redirect_url_str.clone())
            .map_err(|e| McpError::OAuth(format!("Invalid redirect URL: {e}")))?;

        let credentials = self
            .resolve_client(&http, user_id, server_url, &discovery, stored, &redirect_url_str)
            .await?;

        let client = BasicClient::new(ClientId::new(credentials.client_id.clone()))
            .set_auth_uri(auth_url)
            .set_token_uri(token_url)
            .set_redirect_uri(redirect);

        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();

        let (authorize_url, csrf_token) = client
            .authorize_url(CsrfToken::new_random)
            .set_pkce_challenge(pkce_challenge)
            .add_scopes(discovery.scopes.iter().cloned().map(Scope::new))
            .add_extra_param("resource", discovery.resource.clone())
            .url();

        let state = csrf_token.secret().clone();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(
                (user_id.to_string(), state.clone()),
                PendingLogin {
                    pkce_verifier,
                    auth_url: discovery.metadata.authorization_endpoint,
                    token_url: discovery.metadata.token_endpoint,
                    redirect_url: redirect_url_str,
                    client: credentials,
                    resource: discovery.resource,
                },
            );
        }

        Ok((authorize_url.to_string(), listener, state))
    }

    /// Pick the client identity for this login. With a registration endpoint,
    /// reuse the stored client when it was registered with the same issuer and
    /// redirect URI, otherwise register a new one (servers may match redirect
    /// URIs exactly, including the port). Without one, use the default ID.
    async fn resolve_client(
        &self,
        http: &reqwest::Client,
        user_id: &str,
        server_url: &str,
        discovery: &OAuthDiscovery,
        stored: Option<OAuthClientRow>,
        redirect_uri: &str,
    ) -> Result<ClientCredentials, McpError> {
        let Some(endpoint) = discovery.metadata.registration_endpoint.as_deref() else {
            info!(server_url, issuer = %discovery.issuer, "No registration endpoint; using the default OAuth client id");
            return Ok(ClientCredentials::default_client());
        };

        if let Some(row) = stored.as_ref()
            && row.issuer == discovery.issuer
            && row.redirect_uri == redirect_uri
        {
            debug!(server_url, "Reusing registered OAuth client");
            return Ok(ClientCredentials::from_row(row));
        }

        let registered = register_client(http, endpoint, redirect_uri).await?;
        self.client_repo
            .upsert(UpsertOAuthClientParams {
                user_id,
                server_url,
                issuer: &discovery.issuer,
                client_id: &registered.client_id,
                client_secret: registered.client_secret.as_deref(),
                redirect_uri,
            })
            .await?;
        info!(
            server_url,
            issuer = %discovery.issuer,
            replaced_previous = stored.is_some(),
            "Registered OAuth client with authorization server"
        );
        Ok(ClientCredentials {
            client_id: registered.client_id,
            client_secret: registered.client_secret,
        })
    }

    /// Check if a valid (non-expired) token exists for the URL.
    async fn has_valid_token(&self, user_id: &str, server_url: &str) -> Result<bool, McpError> {
        let row = match self.token_repo.get_by_url(user_id, server_url).await? {
            Some(row) => row,
            None => return Ok(false),
        };

        if let Some(expires_at) = row.expires_at
            && now_ms() >= expires_at
        {
            return Ok(false);
        }

        Ok(true)
    }

    /// Wait for the browser redirect on `listener`, exchange the code, and
    /// answer the browser only once the token is stored (or the exchange
    /// failed). A timeout or cancellation closes the listener.
    async fn complete_login(
        &self,
        user_id: &str,
        server_url: &str,
        state: &str,
        listener: TcpListener,
    ) -> OAuthLoginResponse {
        let (code_tx, code_rx) = oneshot::channel();
        let task = tokio::spawn(serve_one_callback(
            listener,
            server_host(server_url),
            self.outcome_timeout,
            code_tx,
        ));
        let replaced = self
            .waits
            .lock()
            .await
            .insert(user_id.to_string(), (state.to_string(), task));
        if let Some((_, older)) = replaced {
            older.abort();
        }

        let callback = match tokio::time::timeout(self.callback_timeout, code_rx).await {
            Ok(Ok(Ok(callback))) => callback,
            other => {
                let error = match other {
                    Ok(Ok(Err(e))) => e,
                    Ok(Err(_)) => McpError::OAuth("Sign-in was cancelled because a newer sign-in started".to_string()),
                    _ => McpError::OAuth(format!(
                        "OAuth callback timed out — no redirect received within {}",
                        describe_duration(self.callback_timeout)
                    )),
                };
                warn!(server_url, error = %error, "OAuth callback failed");
                self.stop_wait(user_id, Some(state), true).await;
                self.remove_pending(user_id, state).await;
                return login_failure(&error);
            }
        };

        let CallbackCode {
            code,
            state: callback_state,
            outcome,
        } = callback;
        let result = self
            .exchange_code(user_id, server_url, code.clone(), callback_state)
            .await;
        let browser_outcome = match &result {
            Ok(()) => Ok(()),
            Err(e) => Err(short_reason(e).replace(&code, "[redacted]")),
        };
        let _ = outcome.send(browser_outcome);
        // Let the callback server write its page before returning.
        self.stop_wait(user_id, Some(state), false).await;

        match result {
            Ok(()) => {
                info!(server_url, "OAuth login completed");
                OAuthLoginResponse {
                    success: true,
                    error: None,
                }
            }
            Err(e) => {
                warn!(server_url, error = %e, "OAuth token exchange failed");
                self.remove_pending(user_id, state).await;
                login_failure(&e)
            }
        }
    }

    /// Take the user's callback server out of the registry (only when it was
    /// started for `state`, if given), abort it when `abort` is set, and wait
    /// until it is gone. Returns whether one was found.
    async fn stop_wait(&self, user_id: &str, state: Option<&str>, abort: bool) -> bool {
        let task = {
            let mut waits = self.waits.lock().await;
            let matches = waits
                .get(user_id)
                .is_some_and(|(wait_state, _)| state.is_none_or(|s| s == wait_state));
            if !matches {
                return false;
            }
            waits.remove(user_id).map(|(_, task)| task)
        };
        if let Some(task) = task {
            if abort {
                task.abort();
            }
            let _ = task.await;
        }
        true
    }

    /// Exchange the authorization code for tokens and persist them.
    async fn exchange_code(
        &self,
        user_id: &str,
        server_url: &str,
        code: String,
        state: String,
    ) -> Result<(), McpError> {
        let pending = {
            let mut guard = self.pending.lock().await;
            guard
                .remove(&(user_id.to_string(), state))
                .ok_or_else(|| McpError::OAuth("No pending login state".to_string()))?
        };

        let auth_url = AuthUrl::new(pending.auth_url).map_err(|e| McpError::OAuth(format!("Invalid auth URL: {e}")))?;
        let token_url =
            TokenUrl::new(pending.token_url).map_err(|e| McpError::OAuth(format!("Invalid token URL: {e}")))?;
        let redirect = RedirectUrl::new(pending.redirect_url)
            .map_err(|e| McpError::OAuth(format!("Invalid redirect URL: {e}")))?;

        let client = BasicClient::new(ClientId::new(pending.client.client_id))
            .set_auth_uri(auth_url)
            .set_token_uri(token_url)
            .set_redirect_uri(redirect);
        let client = match pending.client.client_secret {
            Some(secret) => client.set_client_secret(ClientSecret::new(secret)),
            None => client,
        };

        let http = oauth_http_client()?;
        let send = |request: HttpRequest| send_capped(http.clone(), request);

        let token_result = client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(pending.pkce_verifier)
            .add_extra_param("resource", pending.resource)
            .request_async(&send)
            .await
            .map_err(|e| McpError::OAuth(format!("Token exchange failed: {}", describe_token_error(&e))))?;

        self.persist_token(user_id, server_url, &token_result).await?;
        debug!(server_url, "OAuth tokens stored successfully");
        Ok(())
    }

    /// Refresh an expired access token using the refresh token and the client
    /// the login used (the registered one, when there is one).
    async fn refresh_token(
        &self,
        user_id: &str,
        server_url: &str,
        refresh_token_value: &str,
    ) -> Result<String, McpError> {
        let http = oauth_http_client()?;
        let discovery = discover(&http, server_url).await?;
        let token_url = TokenUrl::new(discovery.metadata.token_endpoint.clone())
            .map_err(|e| McpError::OAuth(format!("Invalid token URL: {e}")))?;

        let credentials = match self.client_repo.get_by_url(user_id, server_url).await? {
            Some(row) if row.issuer == discovery.issuer => ClientCredentials::from_row(&row),
            _ => ClientCredentials::default_client(),
        };

        let client = BasicClient::new(ClientId::new(credentials.client_id)).set_token_uri(token_url);
        let client = match credentials.client_secret {
            Some(secret) => client.set_client_secret(ClientSecret::new(secret)),
            None => client,
        };
        let send = |request: HttpRequest| send_capped(http.clone(), request);

        let refresh_token = RefreshToken::new(refresh_token_value.to_string());
        let token_result = client
            .exchange_refresh_token(&refresh_token)
            .add_extra_param("resource", discovery.resource)
            .request_async(&send)
            .await
            .map_err(|e| McpError::OAuth(format!("Token refresh failed: {}", describe_token_error(&e))))?;

        let new_access_token = token_result.access_token().secret().clone();

        let expires_at: Option<TimestampMs> = token_result.expires_in().map(|d| now_ms() + d.as_millis() as i64);

        // Prefer new refresh_token if provided, otherwise keep the old one.
        let new_refresh = token_result
            .refresh_token()
            .map(|t| t.secret().as_str())
            .unwrap_or(refresh_token_value);

        self.token_repo
            .upsert(UpsertOAuthTokenParams {
                user_id,
                server_url,
                access_token: &new_access_token,
                refresh_token: Some(new_refresh),
                token_type: "bearer",
                expires_at,
            })
            .await?;

        info!(server_url, "OAuth token refreshed");
        Ok(new_access_token)
    }

    /// Persist token response to DB.
    async fn persist_token<TR: TokenResponse>(
        &self,
        user_id: &str,
        server_url: &str,
        token_result: &TR,
    ) -> Result<(), McpError> {
        let expires_at: Option<TimestampMs> = token_result.expires_in().map(|d| now_ms() + d.as_millis() as i64);

        self.token_repo
            .upsert(UpsertOAuthTokenParams {
                user_id,
                server_url,
                access_token: token_result.access_token().secret(),
                refresh_token: token_result.refresh_token().map(|t| t.secret().as_str()),
                token_type: "bearer",
                expires_at,
            })
            .await?;

        Ok(())
    }

    /// Clear one pending login state. Keyed by oauth_state so a cancelled
    /// older sign-in never clears the newer one.
    async fn remove_pending(&self, user_id: &str, state: &str) {
        let mut guard = self.pending.lock().await;
        guard.remove(&(user_id.to_string(), state.to_string()));
    }
}

fn login_failure(error: &McpError) -> OAuthLoginResponse {
    OAuthLoginResponse {
        success: false,
        error: Some(error.to_string()),
    }
}

/// Host shown on the callback page.
fn server_host(server_url: &str) -> String {
    reqwest::Url::parse(server_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "the MCP server".to_string())
}

fn describe_duration(duration: Duration) -> String {
    match duration.as_secs() {
        secs if secs >= 60 => format!("{} minutes", secs / 60),
        secs if secs >= 1 => format!("{secs}s"),
        _ => format!("{}ms", duration.as_millis()),
    }
}

// ---------------------------------------------------------------------------
// Callback listener and token HTTP helpers
// ---------------------------------------------------------------------------

/// Port of the loopback redirect URI a stored client was registered with.
fn registered_callback_port(row: &OAuthClientRow) -> Option<u16> {
    reqwest::Url::parse(&row.redirect_uri).ok()?.port()
}

/// `oauth2` HTTP client that applies the OAuth timeouts, redirect policy and
/// response size cap.
async fn send_capped(http: reqwest::Client, request: HttpRequest) -> Result<HttpResponse, McpError> {
    let request: reqwest::Request = request
        .try_into()
        .map_err(|e| McpError::OAuth(format!("Invalid token request: {e}")))?;
    let url = request.url().clone();
    let resp = http
        .execute(request)
        .await
        .map_err(|e| McpError::OAuth(format!("Request to {url} failed: {e}")))?;
    let mut builder = oauth2::http::Response::builder().status(resp.status());
    for (name, value) in resp.headers() {
        builder = builder.header(name, value);
    }
    let body = read_capped(resp, MAX_RESPONSE_BYTES).await.map_err(McpError::OAuth)?;
    builder
        .body(body)
        .map_err(|e| McpError::OAuth(format!("Invalid token response: {e}")))
}

/// Readable token-endpoint failure that never includes the response body.
fn describe_token_error(err: &RequestTokenError<McpError, BasicErrorResponse>) -> String {
    match err {
        RequestTokenError::ServerResponse(resp) => resp.to_string(),
        RequestTokenError::Request(e) => match e {
            McpError::OAuth(message) => message.clone(),
            other => other.to_string(),
        },
        RequestTokenError::Parse(..) => "the token endpoint returned an invalid response".to_string(),
        RequestTokenError::Other(message) => message.clone(),
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "oauth_flow_tests.rs"]
mod flow_tests;

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_USER_ID: &str = "user-1";

    // -- McpOAuthService construction ----------------------------------------

    #[test]
    fn service_clone_is_independent() {
        let repo: Arc<dyn IOAuthTokenRepository> = Arc::new(MockTokenRepo);
        let svc = McpOAuthService::new(repo, Arc::new(NoClientRepo));
        let _clone = svc.clone();
    }

    #[tokio::test]
    async fn remove_pending_keeps_other_user_same_oauth_state() {
        let svc = McpOAuthService::new(Arc::new(MockTokenRepo), Arc::new(NoClientRepo));
        insert_pending_login(&svc, "user-a", "shared-state").await;
        insert_pending_login(&svc, "user-b", "shared-state").await;

        svc.remove_pending("user-a", "shared-state").await;

        let pending = svc.pending.lock().await;
        assert!(!pending.contains_key(&("user-a".to_string(), "shared-state".to_string())));
        assert!(pending.contains_key(&("user-b".to_string(), "shared-state".to_string())));
    }

    // -- Mock repositories ---------------------------------------------------

    async fn insert_pending_login(svc: &McpOAuthService, user_id: &str, state: &str) {
        let (_, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let mut pending = svc.pending.lock().await;
        pending.insert(
            (user_id.to_string(), state.to_string()),
            PendingLogin {
                pkce_verifier,
                auth_url: "https://auth.example.com/authorize".to_string(),
                token_url: "https://auth.example.com/token".to_string(),
                redirect_url: "http://127.0.0.1/callback".to_string(),
                client: ClientCredentials::default_client(),
                resource: "https://auth.example.com".to_string(),
            },
        );
    }

    struct NoClientRepo;

    #[async_trait::async_trait]
    impl IOAuthClientRepository for NoClientRepo {
        async fn get_by_url(&self, _: &str, _: &str) -> Result<Option<OAuthClientRow>, aionui_db::DbError> {
            Ok(None)
        }

        async fn upsert(&self, _: UpsertOAuthClientParams<'_>) -> Result<OAuthClientRow, aionui_db::DbError> {
            unimplemented!()
        }
    }

    struct MockTokenRepo;

    #[async_trait::async_trait]
    impl IOAuthTokenRepository for MockTokenRepo {
        async fn get_by_url(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<aionui_db::models::OAuthTokenRow>, aionui_db::DbError> {
            Ok(None)
        }

        async fn upsert(
            &self,
            _: UpsertOAuthTokenParams<'_>,
        ) -> Result<aionui_db::models::OAuthTokenRow, aionui_db::DbError> {
            unimplemented!()
        }

        async fn delete(&self, _: &str, _: &str) -> Result<(), aionui_db::DbError> {
            Ok(())
        }

        async fn list_authenticated_urls(&self, _: &str) -> Result<Vec<String>, aionui_db::DbError> {
            Ok(vec![])
        }
    }

    struct IdempotentDeleteRepo;

    #[async_trait::async_trait]
    impl IOAuthTokenRepository for IdempotentDeleteRepo {
        async fn get_by_url(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<aionui_db::models::OAuthTokenRow>, aionui_db::DbError> {
            Ok(None)
        }

        async fn upsert(
            &self,
            _: UpsertOAuthTokenParams<'_>,
        ) -> Result<aionui_db::models::OAuthTokenRow, aionui_db::DbError> {
            unimplemented!()
        }

        async fn delete(&self, _: &str, url: &str) -> Result<(), aionui_db::DbError> {
            Err(aionui_db::DbError::NotFound(format!(
                "OAuth token for '{url}' not found"
            )))
        }

        async fn list_authenticated_urls(&self, _: &str) -> Result<Vec<String>, aionui_db::DbError> {
            Ok(vec![])
        }
    }

    struct ValidTokenRepo;

    #[async_trait::async_trait]
    impl IOAuthTokenRepository for ValidTokenRepo {
        async fn get_by_url(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<aionui_db::models::OAuthTokenRow>, aionui_db::DbError> {
            Ok(Some(aionui_db::models::OAuthTokenRow {
                user_id: TEST_USER_ID.to_string(),
                server_url: "https://example.com".to_string(),
                access_token: "valid_access_token".to_string(),
                refresh_token: None,
                token_type: "bearer".to_string(),
                expires_at: Some(now_ms() + 3_600_000),
                created_at: now_ms(),
                updated_at: now_ms(),
            }))
        }

        async fn upsert(
            &self,
            _: UpsertOAuthTokenParams<'_>,
        ) -> Result<aionui_db::models::OAuthTokenRow, aionui_db::DbError> {
            unimplemented!()
        }

        async fn delete(&self, _: &str, _: &str) -> Result<(), aionui_db::DbError> {
            Ok(())
        }

        async fn list_authenticated_urls(&self, _: &str) -> Result<Vec<String>, aionui_db::DbError> {
            Ok(vec!["https://example.com".to_string()])
        }
    }

    struct ExpiredTokenRepo;

    #[async_trait::async_trait]
    impl IOAuthTokenRepository for ExpiredTokenRepo {
        async fn get_by_url(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<aionui_db::models::OAuthTokenRow>, aionui_db::DbError> {
            Ok(Some(aionui_db::models::OAuthTokenRow {
                user_id: TEST_USER_ID.to_string(),
                server_url: "https://example.com".to_string(),
                access_token: "expired_token".to_string(),
                refresh_token: None,
                token_type: "bearer".to_string(),
                expires_at: Some(1000),
                created_at: 500,
                updated_at: 500,
            }))
        }

        async fn upsert(
            &self,
            _: UpsertOAuthTokenParams<'_>,
        ) -> Result<aionui_db::models::OAuthTokenRow, aionui_db::DbError> {
            unimplemented!()
        }

        async fn delete(&self, _: &str, _: &str) -> Result<(), aionui_db::DbError> {
            Ok(())
        }

        async fn list_authenticated_urls(&self, _: &str) -> Result<Vec<String>, aionui_db::DbError> {
            Ok(vec![])
        }
    }

    struct NoExpiryTokenRepo;

    #[async_trait::async_trait]
    impl IOAuthTokenRepository for NoExpiryTokenRepo {
        async fn get_by_url(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Option<aionui_db::models::OAuthTokenRow>, aionui_db::DbError> {
            Ok(Some(aionui_db::models::OAuthTokenRow {
                user_id: TEST_USER_ID.to_string(),
                server_url: "https://example.com".to_string(),
                access_token: "no_expiry_token".to_string(),
                refresh_token: None,
                token_type: "bearer".to_string(),
                expires_at: None,
                created_at: now_ms(),
                updated_at: now_ms(),
            }))
        }

        async fn upsert(
            &self,
            _: UpsertOAuthTokenParams<'_>,
        ) -> Result<aionui_db::models::OAuthTokenRow, aionui_db::DbError> {
            unimplemented!()
        }

        async fn delete(&self, _: &str, _: &str) -> Result<(), aionui_db::DbError> {
            Ok(())
        }

        async fn list_authenticated_urls(&self, _: &str) -> Result<Vec<String>, aionui_db::DbError> {
            Ok(vec!["https://example.com".to_string()])
        }
    }

    // -- Service behavior tests ----------------------------------------------

    #[tokio::test]
    async fn check_status_no_token_returns_false() {
        let svc = McpOAuthService::new(Arc::new(MockTokenRepo), Arc::new(NoClientRepo));
        let status = svc
            .check_oauth_status(TEST_USER_ID, "https://example.com")
            .await
            .unwrap();
        assert!(!status.authenticated);
    }

    #[tokio::test]
    async fn check_status_with_valid_token() {
        let svc = McpOAuthService::new(Arc::new(ValidTokenRepo), Arc::new(NoClientRepo));
        let status = svc
            .check_oauth_status(TEST_USER_ID, "https://example.com")
            .await
            .unwrap();
        assert!(status.authenticated);
    }

    #[tokio::test]
    async fn check_status_with_expired_token() {
        let svc = McpOAuthService::new(Arc::new(ExpiredTokenRepo), Arc::new(NoClientRepo));
        let status = svc
            .check_oauth_status(TEST_USER_ID, "https://example.com")
            .await
            .unwrap();
        assert!(!status.authenticated);
    }

    #[tokio::test]
    async fn check_status_no_expiry_treated_as_valid() {
        let svc = McpOAuthService::new(Arc::new(NoExpiryTokenRepo), Arc::new(NoClientRepo));
        let status = svc
            .check_oauth_status(TEST_USER_ID, "https://example.com")
            .await
            .unwrap();
        assert!(status.authenticated);
    }

    #[tokio::test]
    async fn logout_idempotent_for_nonexistent() {
        let svc = McpOAuthService::new(Arc::new(IdempotentDeleteRepo), Arc::new(NoClientRepo));
        svc.logout(TEST_USER_ID, "https://nonexistent.example.com")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn get_authenticated_servers_empty() {
        let svc = McpOAuthService::new(Arc::new(MockTokenRepo), Arc::new(NoClientRepo));
        let urls = svc.get_authenticated_servers(TEST_USER_ID).await.unwrap();
        assert!(urls.is_empty());
    }

    #[tokio::test]
    async fn get_authenticated_servers_returns_urls() {
        let svc = McpOAuthService::new(Arc::new(ValidTokenRepo), Arc::new(NoClientRepo));
        let urls = svc.get_authenticated_servers(TEST_USER_ID).await.unwrap();
        assert_eq!(urls, vec!["https://example.com"]);
    }

    #[tokio::test]
    async fn get_token_returns_none_when_no_token() {
        let svc = McpOAuthService::new(Arc::new(MockTokenRepo), Arc::new(NoClientRepo));
        let token = svc.get_token(TEST_USER_ID, "https://example.com").await.unwrap();
        assert!(token.is_none());
    }

    #[tokio::test]
    async fn get_token_returns_access_token() {
        let svc = McpOAuthService::new(Arc::new(ValidTokenRepo), Arc::new(NoClientRepo));
        let token = svc.get_token(TEST_USER_ID, "https://example.com").await.unwrap();
        assert_eq!(token.as_deref(), Some("valid_access_token"));
    }

    #[tokio::test]
    async fn get_token_returns_expired_when_no_refresh() {
        let svc = McpOAuthService::new(Arc::new(ExpiredTokenRepo), Arc::new(NoClientRepo));
        // Expired token with no refresh_token: returns the expired token as-is.
        let token = svc.get_token(TEST_USER_ID, "https://example.com").await.unwrap();
        assert_eq!(token.as_deref(), Some("expired_token"));
    }
}
