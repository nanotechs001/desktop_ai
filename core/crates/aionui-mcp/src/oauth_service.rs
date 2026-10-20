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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::error::McpError;
use crate::oauth_discovery::{MAX_RESPONSE_BYTES, OAuthDiscovery, discover, oauth_http_client, read_capped};
use crate::oauth_registration::register_client;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default timeout for the OAuth callback server waiting for the redirect.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(120);

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
struct PendingLogin {
    csrf_token: CsrfToken,
    pkce_verifier: PkceCodeVerifier,
    auth_url: String,
    token_url: String,
    redirect_url: String,
    client: ClientCredentials,
    resource: String,
}

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
}

impl McpOAuthService {
    pub fn new(token_repo: Arc<dyn IOAuthTokenRepository>, client_repo: Arc<dyn IOAuthClientRepository>) -> Self {
        Self {
            token_repo,
            client_repo,
            pending: Arc::new(Mutex::new(HashMap::new())),
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
        let (authorize_url, listener) = match self.prepare_login_flow(user_id, server_url).await {
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

        // Wait for callback.
        let (code, state) = match self.wait_for_callback(user_id, listener).await {
            Ok(callback) => callback,
            Err(e) => {
                warn!(server_url, error = %e, "OAuth callback failed");
                self.clear_pending_for_user(user_id).await;
                return Ok(OAuthLoginResponse {
                    success: false,
                    error: Some(e.to_string()),
                });
            }
        };

        // Exchange code for tokens.
        match self.exchange_code(user_id, server_url, code, state).await {
            Ok(()) => {
                info!(server_url, "OAuth login completed");
                Ok(OAuthLoginResponse {
                    success: true,
                    error: None,
                })
            }
            Err(e) => {
                warn!(server_url, error = %e, "OAuth token exchange failed");
                self.clear_pending_for_user(user_id).await;
                Ok(OAuthLoginResponse {
                    success: false,
                    error: Some(e.to_string()),
                })
            }
        }
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
    /// callback server, store pending state, and return the authorization URL
    /// + listener.
    async fn prepare_login_flow(&self, user_id: &str, server_url: &str) -> Result<(String, TcpListener), McpError> {
        let http = oauth_http_client()?;
        let discovery = discover(&http, server_url).await?;
        let stored = self.client_repo.get_by_url(user_id, server_url).await?;

        let auth_url = AuthUrl::new(discovery.metadata.authorization_endpoint.clone())
            .map_err(|e| McpError::OAuth(format!("Invalid auth URL: {e}")))?;
        let token_url = TokenUrl::new(discovery.metadata.token_endpoint.clone())
            .map_err(|e| McpError::OAuth(format!("Invalid token URL: {e}")))?;

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

        {
            let mut pending = self.pending.lock().await;
            let state = csrf_token.secret().clone();
            pending.insert(
                (user_id.to_string(), state),
                PendingLogin {
                    csrf_token,
                    pkce_verifier,
                    auth_url: discovery.metadata.authorization_endpoint,
                    token_url: discovery.metadata.token_endpoint,
                    redirect_url: redirect_url_str,
                    client: credentials,
                    resource: discovery.resource,
                },
            );
        }

        Ok((authorize_url.to_string(), listener))
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

    /// Wait for the OAuth callback redirect on the given listener.
    async fn wait_for_callback(&self, user_id: &str, listener: TcpListener) -> Result<(String, String), McpError> {
        let (code_tx, code_rx) = tokio::sync::oneshot::channel::<Result<(String, String), McpError>>();
        let pending = self.pending.clone();
        let user_id = user_id.to_string();

        tokio::spawn(async move {
            let result = Self::handle_callback_connection(&user_id, listener, pending).await;
            let _ = code_tx.send(result);
        });

        match tokio::time::timeout(CALLBACK_TIMEOUT, code_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(McpError::OAuth("Callback channel closed unexpectedly".to_string())),
            Err(_) => Err(McpError::OAuth(
                "OAuth callback timed out — no redirect received within 120s".to_string(),
            )),
        }
    }

    /// Handle a single HTTP connection on the callback server.
    async fn handle_callback_connection(
        user_id: &str,
        listener: TcpListener,
        pending: Arc<Mutex<HashMap<(String, String), PendingLogin>>>,
    ) -> Result<(String, String), McpError> {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| McpError::OAuth(format!("Failed to accept connection: {e}")))?;

        let mut buf = vec![0u8; 4096];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| McpError::OAuth(format!("Failed to read request: {e}")))?;

        let request = String::from_utf8_lossy(&buf[..n]);
        let (code, state) = parse_callback_query(&request)?;

        // Validate CSRF state.
        let guard = pending.lock().await;
        let pending_login = guard
            .get(&(user_id.to_string(), state.clone()))
            .ok_or_else(|| McpError::OAuth("No pending login state".to_string()))?;

        if state != *pending_login.csrf_token.secret() {
            return Err(McpError::OAuth("CSRF state mismatch".to_string()));
        }

        // Send a success response to the browser.
        let response = "HTTP/1.1 200 OK\r\n\
            Content-Type: text/html; charset=utf-8\r\n\
            Connection: close\r\n\r\n\
            <html><body><h1>Authorization successful!</h1>\
            <p>You can close this window and return to AionUi.</p>\
            </body></html>";

        let _ = stream.write_all(response.as_bytes()).await;

        Ok((code, state))
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

    /// Clear the pending login state.
    async fn clear_pending_for_user(&self, user_id: &str) {
        let mut guard = self.pending.lock().await;
        guard.retain(|(pending_user_id, _), _| pending_user_id != user_id);
    }
}

// ---------------------------------------------------------------------------
// Callback listener and token HTTP helpers
// ---------------------------------------------------------------------------

/// Port of the loopback redirect URI a stored client was registered with.
fn registered_callback_port(row: &OAuthClientRow) -> Option<u16> {
    reqwest::Url::parse(&row.redirect_uri).ok()?.port()
}

/// Bind the loopback callback server, preferring the port the stored client
/// was registered with so its exact redirect URI still matches.
async fn bind_callback_listener(preferred_port: Option<u16>) -> Result<TcpListener, McpError> {
    if let Some(port) = preferred_port {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => debug!(port, error = %e, "Registered callback port unavailable; using a new one"),
        }
    }
    TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| McpError::OAuth(format!("Failed to bind callback server: {e}")))
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
// Query parameter parsing
// ---------------------------------------------------------------------------

/// Parse `code` and `state` from the first line of an HTTP request.
///
/// Expects: `GET /callback?code=xxx&state=yyy HTTP/1.1`
fn parse_callback_query(request: &str) -> Result<(String, String), McpError> {
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| McpError::OAuth("Empty HTTP request".to_string()))?;

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| McpError::OAuth("Malformed HTTP request line".to_string()))?;

    let query_str = path
        .split_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| McpError::OAuth("No query parameters in callback".to_string()))?;

    let mut code = None;
    let mut state = None;

    for pair in query_str.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "code" => code = Some(url_decode(value)),
                "state" => state = Some(url_decode(value)),
                _ => {}
            }
        }
    }

    let code = code.ok_or_else(|| McpError::OAuth("Missing 'code' in callback".to_string()))?;
    let state = state.ok_or_else(|| McpError::OAuth("Missing 'state' in callback".to_string()))?;

    Ok((code, state))
}

/// Minimal percent-decoding for query parameter values.
fn url_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.bytes();

    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(h), Some(l)) = (hi, lo) {
                let hex = [h, l];
                if let Ok(s) = std::str::from_utf8(&hex)
                    && let Ok(byte) = u8::from_str_radix(s, 16)
                {
                    result.push(byte as char);
                    continue;
                }
                // Malformed percent-encoding: keep as-is.
                result.push('%');
                result.push(h as char);
                result.push(l as char);
            }
        } else if b == b'+' {
            result.push(' ');
        } else {
            result.push(b as char);
        }
    }

    result
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

    // -- parse_callback_query ------------------------------------------------

    #[test]
    fn parse_valid_callback_query() {
        let request = "GET /callback?code=abc123&state=xyz789 HTTP/1.1\r\nHost: localhost\r\n";
        let (code, state) = parse_callback_query(request).unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
    }

    #[test]
    fn parse_callback_query_reversed_params() {
        let request = "GET /callback?state=s1&code=c1 HTTP/1.1\r\n";
        let (code, state) = parse_callback_query(request).unwrap();
        assert_eq!(code, "c1");
        assert_eq!(state, "s1");
    }

    #[test]
    fn parse_callback_query_with_extra_params() {
        let request = "GET /callback?code=c&foo=bar&state=s HTTP/1.1\r\n";
        let (code, state) = parse_callback_query(request).unwrap();
        assert_eq!(code, "c");
        assert_eq!(state, "s");
    }

    #[test]
    fn parse_callback_query_missing_code() {
        let request = "GET /callback?state=s HTTP/1.1\r\n";
        let err = parse_callback_query(request).unwrap_err();
        assert!(err.to_string().contains("Missing 'code'"));
    }

    #[test]
    fn parse_callback_query_missing_state() {
        let request = "GET /callback?code=c HTTP/1.1\r\n";
        let err = parse_callback_query(request).unwrap_err();
        assert!(err.to_string().contains("Missing 'state'"));
    }

    #[test]
    fn parse_callback_query_no_query_string() {
        let request = "GET /callback HTTP/1.1\r\n";
        let err = parse_callback_query(request).unwrap_err();
        assert!(err.to_string().contains("No query parameters"));
    }

    #[test]
    fn parse_callback_query_empty_request() {
        let err = parse_callback_query("").unwrap_err();
        assert!(err.to_string().contains("Empty HTTP request"));
    }

    // -- url_decode ----------------------------------------------------------

    #[test]
    fn url_decode_no_encoding() {
        assert_eq!(url_decode("hello"), "hello");
    }

    #[test]
    fn url_decode_percent_encoded() {
        assert_eq!(url_decode("hello%20world"), "hello world");
    }

    #[test]
    fn url_decode_plus_sign() {
        assert_eq!(url_decode("hello+world"), "hello world");
    }

    #[test]
    fn url_decode_special_characters() {
        assert_eq!(url_decode("%3D%26%3F"), "=&?");
    }

    #[test]
    fn url_decode_mixed() {
        assert_eq!(url_decode("a%20b+c%3Dd"), "a b c=d");
    }

    // -- McpOAuthService construction ----------------------------------------

    #[test]
    fn service_clone_is_independent() {
        let repo: Arc<dyn IOAuthTokenRepository> = Arc::new(MockTokenRepo);
        let svc = McpOAuthService::new(repo, Arc::new(NoClientRepo));
        let _clone = svc.clone();
    }

    #[tokio::test]
    async fn clear_pending_for_user_keeps_other_user_same_oauth_state() {
        let svc = McpOAuthService::new(Arc::new(MockTokenRepo), Arc::new(NoClientRepo));
        insert_pending_login(&svc, "user-a", "shared-state").await;
        insert_pending_login(&svc, "user-b", "shared-state").await;

        svc.clear_pending_for_user("user-a").await;

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
                csrf_token: CsrfToken::new(state.to_string()),
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
