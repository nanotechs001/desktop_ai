//! OAuth discovery, client registration, login and refresh against a local
//! mock MCP server + authorization server shaped like `mcp.bugherd.com`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use aionui_db::{
    Database, IOAuthClientRepository, IOAuthTokenRepository, SqliteOAuthClientRepository, SqliteOAuthTokenRepository,
    UpsertOAuthClientParams, UpsertOAuthTokenParams,
};
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use serde_json::{Value, json};

use super::McpOAuthService;
use crate::oauth_discovery::{discover, oauth_http_client};

const USER: &str = "system_default_user";
const PRM_ROOT: &str = "/.well-known/oauth-protected-resource";
const HINT_PRM_PATH: &str = "/custom/resource-metadata";

/// Knobs for the mock server; the defaults mirror mcp.bugherd.com.
#[derive(Clone)]
struct MockConfig {
    /// 401 carries `resource_metadata` pointing at `HINT_PRM_PATH`, and PRM is
    /// served only there.
    www_authenticate_hint: bool,
    /// Path appended to the base URL to form the authorization server id.
    as_path: &'static str,
    /// Path the authorization server metadata is served at.
    as_metadata_path: String,
    /// Replaces `authorization_servers[0]` in the protected-resource metadata.
    authorization_server_override: Option<String>,
    issuer_override: Option<String>,
    with_registration: bool,
    registration_rejected: bool,
}

impl Default for MockConfig {
    fn default() -> Self {
        Self {
            www_authenticate_hint: false,
            as_path: "",
            as_metadata_path: "/.well-known/oauth-authorization-server".to_string(),
            authorization_server_override: None,
            issuer_override: None,
            with_registration: true,
            registration_rejected: false,
        }
    }
}

#[derive(Default)]
struct Recorded {
    paths: Vec<String>,
    registrations: Vec<Value>,
    token_requests: Vec<HashMap<String, String>>,
}

#[derive(Clone)]
struct MockState {
    base: String,
    config: MockConfig,
    recorded: Arc<StdMutex<Recorded>>,
}

struct MockServer {
    base: String,
    recorded: Arc<StdMutex<Recorded>>,
}

impl MockServer {
    async fn start(config: MockConfig) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let recorded = Arc::new(StdMutex::new(Recorded::default()));
        let state = MockState {
            base: base.clone(),
            config,
            recorded: recorded.clone(),
        };
        let app = Router::new().fallback(mock_handler).with_state(state);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { base, recorded }
    }

    fn server_url(&self) -> String {
        format!("{}/mcp", self.base)
    }

    fn recorded(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.recorded.lock().unwrap()
    }
}

fn form_pairs(body: &[u8]) -> HashMap<String, String> {
    let url = Url::parse(&format!("http://x/?{}", String::from_utf8_lossy(body))).unwrap();
    url.query_pairs().into_owned().collect()
}

async fn mock_handler(
    State(s): State<MockState>,
    method: Method,
    uri: Uri,
    _headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().to_string();
    s.recorded.lock().unwrap().paths.push(format!("{method} {path}"));
    let base = &s.base;
    let cfg = &s.config;
    let issuer = format!("{base}{}", cfg.as_path);

    let prm = || {
        let auth_server = cfg
            .authorization_server_override
            .clone()
            .unwrap_or_else(|| issuer.clone());
        axum::Json(json!({
            "resource": format!("{base}/mcp"),
            "authorization_servers": [auth_server],
            "scopes_supported": ["read", "write"],
            "bearer_methods_supported": ["header"],
        }))
        .into_response()
    };

    match (method, path.as_str()) {
        (Method::POST, "/mcp") => {
            let challenge = if cfg.www_authenticate_hint {
                format!(r#"Bearer resource_metadata="{base}{HINT_PRM_PATH}""#)
            } else {
                "Bearer".to_string()
            };
            (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, challenge)]).into_response()
        }
        (Method::GET, p) if cfg.www_authenticate_hint && p == HINT_PRM_PATH => prm(),
        (Method::GET, p) if !cfg.www_authenticate_hint && (p == PRM_ROOT || p == format!("{PRM_ROOT}/mcp")) => prm(),
        (Method::GET, p) if p == cfg.as_metadata_path => {
            let mut metadata = json!({
                "issuer": cfg.issuer_override.clone().unwrap_or_else(|| issuer.clone()),
                "authorization_endpoint": format!("{base}/oauth/authorize"),
                "token_endpoint": format!("{base}/oauth/token"),
                "revocation_endpoint": format!("{base}/oauth/revoke"),
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": ["read", "write"],
                "token_endpoint_auth_methods_supported": ["none"],
                "client_id_metadata_document_supported": true,
            });
            if cfg.with_registration {
                metadata["registration_endpoint"] = json!(format!("{base}/oauth/register"));
            }
            axum::Json(metadata).into_response()
        }
        (Method::POST, "/oauth/register") => {
            if cfg.registration_rejected {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({"error": "invalid_redirect_uri", "error_description": "loopback only"})),
                )
                    .into_response();
            }
            let request: Value = serde_json::from_slice(&body).unwrap();
            let mut recorded = s.recorded.lock().unwrap();
            recorded.registrations.push(request.clone());
            let client_id = format!("dcr-client-{}", recorded.registrations.len());
            (
                StatusCode::CREATED,
                axum::Json(json!({
                    "client_id": client_id,
                    "client_name": request["client_name"],
                    "redirect_uris": request["redirect_uris"],
                    "token_endpoint_auth_method": "none",
                })),
            )
                .into_response()
        }
        (Method::POST, "/oauth/token") => {
            let form = form_pairs(&body);
            let access_token = if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
                "at-refreshed"
            } else {
                "at-1"
            };
            s.recorded.lock().unwrap().token_requests.push(form);
            axum::Json(json!({
                "access_token": access_token,
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": "rt-1",
            }))
            .into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

struct Harness {
    svc: McpOAuthService,
    tokens: Arc<dyn IOAuthTokenRepository>,
    clients: Arc<dyn IOAuthClientRepository>,
    _db: Database,
}

async fn harness() -> Harness {
    let db = aionui_db::init_database_memory().await.unwrap();
    let tokens: Arc<dyn IOAuthTokenRepository> = Arc::new(SqliteOAuthTokenRepository::new(db.pool().clone()));
    let clients: Arc<dyn IOAuthClientRepository> = Arc::new(SqliteOAuthClientRepository::new(db.pool().clone()));
    Harness {
        svc: McpOAuthService::new(tokens.clone(), clients.clone()),
        tokens,
        clients,
        _db: db,
    }
}

fn query(url: &str) -> HashMap<String, String> {
    Url::parse(url).unwrap().query_pairs().into_owned().collect()
}

/// Play the browser: deliver `code` + `state` to the loopback redirect URI.
async fn deliver_callback(redirect_uri: &str, state: &str) {
    let url = format!("{redirect_uri}?code=the-code&state={state}");
    let resp = reqwest::get(url).await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
}

// -- Discovery ---------------------------------------------------------------

#[tokio::test]
async fn discovers_bugherd_shaped_protected_resource_then_authorization_server() {
    let mock = MockServer::start(MockConfig::default()).await;
    let discovery = discover(&oauth_http_client().unwrap(), &mock.server_url())
        .await
        .unwrap();

    assert_eq!(discovery.issuer, mock.base);
    assert_eq!(discovery.resource, mock.server_url());
    assert_eq!(discovery.scopes, vec!["read", "write"]);
    assert_eq!(discovery.metadata.token_endpoint, format!("{}/oauth/token", mock.base));
    assert_eq!(
        discovery.metadata.registration_endpoint.as_deref(),
        Some(format!("{}/oauth/register", mock.base).as_str())
    );
    let paths = mock.recorded().paths.clone();
    assert!(
        paths.contains(&"GET /.well-known/oauth-protected-resource/mcp".to_string()),
        "{paths:?}"
    );
    // The old bug: metadata was looked up under the server path.
    assert!(
        !paths.iter().any(|p| p.starts_with("GET /mcp/.well-known")),
        "{paths:?}"
    );
}

#[tokio::test]
async fn follows_www_authenticate_resource_metadata_hint() {
    let mock = MockServer::start(MockConfig {
        www_authenticate_hint: true,
        ..MockConfig::default()
    })
    .await;
    let discovery = discover(&oauth_http_client().unwrap(), &mock.server_url())
        .await
        .unwrap();

    assert_eq!(discovery.issuer, mock.base);
    let paths = mock.recorded().paths.clone();
    assert_eq!(paths[0], "POST /mcp");
    assert_eq!(paths[1], format!("GET {HINT_PRM_PATH}"));
}

#[tokio::test]
async fn authorization_server_metadata_uses_rfc8414_path_insertion() {
    let mock = MockServer::start(MockConfig {
        as_path: "/tenant1",
        as_metadata_path: "/.well-known/oauth-authorization-server/tenant1".to_string(),
        ..MockConfig::default()
    })
    .await;
    let discovery = discover(&oauth_http_client().unwrap(), &mock.server_url())
        .await
        .unwrap();
    assert_eq!(discovery.issuer, format!("{}/tenant1", mock.base));
}

#[tokio::test]
async fn authorization_server_metadata_falls_back_to_oidc_path_append() {
    let mock = MockServer::start(MockConfig {
        as_path: "/tenant1",
        as_metadata_path: "/tenant1/.well-known/openid-configuration".to_string(),
        ..MockConfig::default()
    })
    .await;
    let discovery = discover(&oauth_http_client().unwrap(), &mock.server_url())
        .await
        .unwrap();
    assert_eq!(discovery.issuer, format!("{}/tenant1", mock.base));
    let paths = mock.recorded().paths.clone();
    assert!(paths.contains(&"GET /.well-known/openid-configuration/tenant1".to_string()));
}

#[tokio::test]
async fn rejects_issuer_mismatch() {
    let mock = MockServer::start(MockConfig {
        issuer_override: Some("https://evil.example.com".to_string()),
        ..MockConfig::default()
    })
    .await;
    let err = discover(&oauth_http_client().unwrap(), &mock.server_url())
        .await
        .unwrap_err();
    let message = err.to_string();
    assert!(
        message.contains("issuer 'https://evil.example.com' does not match"),
        "{message}"
    );
}

#[tokio::test]
async fn rejects_non_https_server_and_authorization_server() {
    let err = discover(&oauth_http_client().unwrap(), "http://mcp.example.com/mcp")
        .await
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("MCP server URL 'http://mcp.example.com/mcp' must use https")
    );

    let mock = MockServer::start(MockConfig {
        authorization_server_override: Some("http://auth.example.com".to_string()),
        ..MockConfig::default()
    })
    .await;
    let err = discover(&oauth_http_client().unwrap(), &mock.server_url())
        .await
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("Authorization server 'http://auth.example.com' must use https"),
        "{err}"
    );
}

// -- Login, registration and refresh -------------------------------------------

#[tokio::test]
async fn login_registers_client_sends_resource_and_scope_and_refresh_reuses_client() {
    let mock = MockServer::start(MockConfig::default()).await;
    let h = harness().await;
    let server_url = mock.server_url();

    let (authorize_url, listener) = h.svc.prepare_login_flow(USER, &server_url).await.unwrap();
    let params = query(&authorize_url);
    assert!(authorize_url.starts_with(&format!("{}/oauth/authorize?", mock.base)));
    assert_eq!(params["client_id"], "dcr-client-1");
    assert_eq!(params["resource"], server_url);
    assert_eq!(params["scope"], "read write");
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["response_type"], "code");
    assert!(!params["code_challenge"].is_empty());
    let redirect_uri = params["redirect_uri"].clone();
    assert!(redirect_uri.starts_with("http://127.0.0.1:") && redirect_uri.ends_with("/callback"));

    {
        let recorded = mock.recorded();
        assert_eq!(recorded.registrations.len(), 1);
        let registration = &recorded.registrations[0];
        assert_eq!(registration["client_name"], "Pixebot Browser");
        assert_eq!(registration["redirect_uris"], json!([redirect_uri]));
        assert_eq!(
            registration["grant_types"],
            json!(["authorization_code", "refresh_token"])
        );
        assert_eq!(registration["response_types"], json!(["code"]));
        assert_eq!(registration["token_endpoint_auth_method"], "none");
    }
    let stored = h.clients.get_by_url(USER, &server_url).await.unwrap().unwrap();
    assert_eq!(stored.client_id, "dcr-client-1");
    assert_eq!(stored.issuer, mock.base);
    assert_eq!(stored.redirect_uri, redirect_uri);

    // Browser redirect → loopback callback → token exchange.
    let (callback, ()) = tokio::join!(
        h.svc.wait_for_callback(USER, listener),
        deliver_callback(&redirect_uri, &params["state"])
    );
    let (code, state) = callback.unwrap();
    assert_eq!(code, "the-code");
    h.svc.exchange_code(USER, &server_url, code, state).await.unwrap();

    {
        let recorded = mock.recorded();
        let exchange = &recorded.token_requests[0];
        assert_eq!(exchange["grant_type"], "authorization_code");
        assert_eq!(exchange["code"], "the-code");
        assert_eq!(exchange["client_id"], "dcr-client-1");
        assert_eq!(exchange["resource"], server_url);
        assert_eq!(exchange["redirect_uri"], redirect_uri);
        assert!(!exchange["code_verifier"].is_empty());
    }
    let token = h.tokens.get_by_url(USER, &server_url).await.unwrap().unwrap();
    assert_eq!(token.access_token, "at-1");

    // A second login on the same redirect URI reuses the registration.
    let (authorize_url, listener) = h.svc.prepare_login_flow(USER, &server_url).await.unwrap();
    assert_eq!(query(&authorize_url)["client_id"], "dcr-client-1");
    assert_eq!(query(&authorize_url)["redirect_uri"], redirect_uri);
    assert_eq!(mock.recorded().registrations.len(), 1);
    drop(listener);
    h.svc.clear_pending_for_user(USER).await;

    // Expired token → refresh with the registered client id.
    h.tokens
        .upsert(UpsertOAuthTokenParams {
            user_id: USER,
            server_url: &server_url,
            access_token: "at-1",
            refresh_token: Some("rt-1"),
            token_type: "bearer",
            expires_at: Some(1000),
        })
        .await
        .unwrap();
    let refreshed = h.svc.get_token(USER, &server_url).await.unwrap();
    assert_eq!(refreshed.as_deref(), Some("at-refreshed"));
    let recorded = mock.recorded();
    let refresh = recorded.token_requests.last().unwrap();
    assert_eq!(refresh["grant_type"], "refresh_token");
    assert_eq!(refresh["refresh_token"], "rt-1");
    assert_eq!(refresh["client_id"], "dcr-client-1");
    assert_eq!(refresh["resource"], server_url);
}

#[tokio::test]
async fn re_registers_when_the_registered_redirect_port_is_unavailable() {
    let mock = MockServer::start(MockConfig::default()).await;
    let h = harness().await;
    let server_url = mock.server_url();

    // Hold the port the stored client was registered with.
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let old_redirect = format!("http://127.0.0.1:{}/callback", occupied.local_addr().unwrap().port());
    h.clients
        .upsert(UpsertOAuthClientParams {
            user_id: USER,
            server_url: &server_url,
            issuer: &mock.base,
            client_id: "old-client",
            client_secret: None,
            redirect_uri: &old_redirect,
        })
        .await
        .unwrap();

    let (authorize_url, _listener) = h.svc.prepare_login_flow(USER, &server_url).await.unwrap();
    let params = query(&authorize_url);
    assert_eq!(params["client_id"], "dcr-client-1");
    assert_ne!(params["redirect_uri"], old_redirect);
    let stored = h.clients.get_by_url(USER, &server_url).await.unwrap().unwrap();
    assert_eq!(stored.client_id, "dcr-client-1");
    assert_eq!(stored.redirect_uri, params["redirect_uri"]);
}

#[tokio::test]
async fn uses_default_client_id_without_registration_endpoint() {
    let mock = MockServer::start(MockConfig {
        with_registration: false,
        ..MockConfig::default()
    })
    .await;
    let h = harness().await;
    let server_url = mock.server_url();

    let (authorize_url, _listener) = h.svc.prepare_login_flow(USER, &server_url).await.unwrap();
    assert_eq!(query(&authorize_url)["client_id"], "aionui");
    assert!(h.clients.get_by_url(USER, &server_url).await.unwrap().is_none());
}

#[tokio::test]
async fn registration_rejection_is_reported_with_the_server_reason() {
    let mock = MockServer::start(MockConfig {
        registration_rejected: true,
        ..MockConfig::default()
    })
    .await;
    let h = harness().await;

    let err = h.svc.login(USER, &mock.server_url()).await.unwrap_err();
    let message = err.to_string();
    assert!(
        message.contains("HTTP 400 Bad Request: invalid_redirect_uri (loopback only)"),
        "{message}"
    );
}
