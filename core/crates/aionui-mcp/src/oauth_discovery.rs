//! OAuth discovery for MCP servers, following the MCP authorization spec:
//! protected-resource metadata (RFC 9728), then authorization server metadata
//! (RFC 8414 / OpenID Connect Discovery). Also holds the bounded HTTP helpers
//! every OAuth request uses (timeouts, size cap, same-origin redirects only).

use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tracing::{debug, info, warn};

use crate::error::McpError;

/// Total time allowed for one OAuth HTTP request.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest response body read from any OAuth endpoint.
pub(crate) const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 5;

/// Unauthenticated MCP `initialize` request used to provoke the server's 401.
const PROBE_BODY: &str = concat!(
    r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","#,
    r#""capabilities":{},"clientInfo":{"name":"Pixebot Browser","version":""#,
    env!("CARGO_PKG_VERSION"),
    r#""}}}"#
);

/// Protected Resource Metadata (RFC 9728), the fields we use.
#[derive(Debug, Deserialize)]
struct ProtectedResourceMetadata {
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

/// Authorization Server Metadata (RFC 8414), the fields we use.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AuthServerMetadata {
    #[serde(default)]
    pub issuer: Option<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Option<Vec<String>>,
}

/// Everything the login and refresh flows need from discovery.
#[derive(Debug, Clone)]
pub(crate) struct OAuthDiscovery {
    /// Authorization server identifier; equals the metadata `issuer`.
    pub issuer: String,
    pub metadata: AuthServerMetadata,
    /// RFC 8707 `resource` value sent on authorize and token requests.
    pub resource: String,
    /// Scopes to request (the protected resource's `scopes_supported`).
    pub scopes: Vec<String>,
}

fn oauth_err(message: impl Into<String>) -> McpError {
    McpError::OAuth(message.into())
}

/// HTTP client for OAuth traffic: bounded time, and redirects followed only
/// within the same scheme, host and port.
pub(crate) fn oauth_http_client() -> Result<reqwest::Client, McpError> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let same_origin = attempt
            .previous()
            .first()
            .is_some_and(|first| first.origin() == attempt.url().origin());
        if same_origin && attempt.previous().len() <= MAX_REDIRECTS {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(policy)
        .build()
        .map_err(|e| oauth_err(format!("Failed to build HTTP client: {e}")))
}

/// Parse a URL taken from user input or server metadata and require https
/// (plain http only for loopback hosts).
pub(crate) fn parse_secure_url(raw: &str, what: &str) -> Result<Url, McpError> {
    let url = Url::parse(raw).map_err(|e| oauth_err(format!("{what} '{raw}' is not a valid URL: {e}")))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(oauth_err(format!("{what} '{raw}' must use https"))),
    }
}

/// Read a response body, failing once it exceeds `limit` bytes.
pub(crate) async fn read_capped(mut resp: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let url = resp.url().clone();
    if resp.content_length().is_some_and(|len| len > limit as u64) {
        return Err(format!("{url} returned a response larger than {limit} bytes"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Failed to read response from {url}: {e}"))?
    {
        if body.len() + chunk.len() > limit {
            return Err(format!("{url} returned a response larger than {limit} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_json<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T, String> {
    let resp = client
        .get(url)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("Request to {url} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{url} returned HTTP {status}"));
    }
    let body = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    serde_json::from_slice(&body).map_err(|e| format!("{url} returned invalid metadata: {e}"))
}

/// Discover the authorization server, resource and scopes for an MCP server.
pub(crate) async fn discover(client: &reqwest::Client, server_url: &str) -> Result<OAuthDiscovery, McpError> {
    let server = parse_secure_url(server_url, "MCP server URL")?;
    let default_resource = canonical_resource(&server);
    let origin = server.origin().ascii_serialization();

    let (resource, scopes, issuer) = match fetch_protected_resource_metadata(client, &server).await {
        Some(prm) => {
            let resource = match prm.resource {
                Some(resource) => {
                    check_resource_matches_server(&resource, &server)?;
                    resource
                }
                None => default_resource,
            };
            let issuer = match prm.authorization_servers.into_iter().next() {
                Some(issuer) => issuer,
                None => {
                    warn!(
                        server_url,
                        "Protected resource metadata lists no authorization server; using the server origin"
                    );
                    origin
                }
            };
            (resource, prm.scopes_supported, issuer)
        }
        None => {
            info!(
                server_url,
                "No protected resource metadata found; using the server origin as authorization server"
            );
            (default_resource, Vec::new(), origin)
        }
    };

    let metadata = fetch_auth_server_metadata(client, &issuer).await?;
    info!(
        server_url,
        issuer = %issuer,
        has_registration_endpoint = metadata.registration_endpoint.is_some(),
        "Discovered OAuth authorization server"
    );
    Ok(OAuthDiscovery {
        issuer,
        metadata,
        resource,
        scopes,
    })
}

/// The server URL without fragment or trailing slash (MCP canonical server URI).
fn canonical_resource(server: &Url) -> String {
    let mut url = server.clone();
    url.set_fragment(None);
    url.as_str().trim_end_matches('/').to_string()
}

/// RFC 9728 §3.3: the advertised resource must identify this server. Accept
/// the same origin with a path equal to, or a parent of, the server path.
fn check_resource_matches_server(resource: &str, server: &Url) -> Result<(), McpError> {
    let parsed = parse_secure_url(resource, "Protected resource")?;
    let resource_path = parsed.path().trim_end_matches('/');
    let server_path = server.path().trim_end_matches('/');
    let path_ok = resource_path.is_empty()
        || server_path == resource_path
        || server_path.starts_with(&format!("{resource_path}/"));
    if parsed.origin() == server.origin() && path_ok {
        Ok(())
    } else {
        Err(oauth_err(format!(
            "Protected resource metadata names resource '{resource}', which does not match the MCP server URL '{server}'"
        )))
    }
}

/// Try, in order: the `resource_metadata` hint from a 401 `WWW-Authenticate`,
/// then the path-aware and root well-known URIs. Fetch failures fall through.
async fn fetch_protected_resource_metadata(
    client: &reqwest::Client,
    server: &Url,
) -> Option<ProtectedResourceMetadata> {
    let mut candidates = Vec::new();
    if let Some(hint) = probe_resource_metadata_hint(client, server).await {
        match parse_secure_url(&hint, "Protected resource metadata URL") {
            Ok(url) => candidates.push(url.to_string()),
            Err(e) => warn!(server_url = %server, error = %e, "Ignoring resource_metadata hint"),
        }
    }
    candidates.extend(protected_resource_metadata_urls(server));

    for url in candidates {
        match fetch_json::<ProtectedResourceMetadata>(client, &url).await {
            Ok(prm) => {
                info!(server_url = %server, metadata_url = %url, "Found protected resource metadata");
                return Some(prm);
            }
            Err(e) => debug!(metadata_url = %url, error = %e, "Protected resource metadata not available"),
        }
    }
    None
}

/// Send an unauthenticated MCP request and read `resource_metadata` from a 401.
async fn probe_resource_metadata_hint(client: &reqwest::Client, server: &Url) -> Option<String> {
    let resp = match client
        .post(server.clone())
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json, text/event-stream")
        .body(PROBE_BODY)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            debug!(server_url = %server, error = %e, "Unauthenticated probe failed");
            return None;
        }
    };
    if resp.status() != StatusCode::UNAUTHORIZED {
        debug!(server_url = %server, status = %resp.status(), "Unauthenticated probe did not return 401");
        return None;
    }
    resp.headers()
        .get_all(WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(parse_resource_metadata_param)
}

/// Extract the `resource_metadata` auth-param from a `WWW-Authenticate` value.
pub(crate) fn parse_resource_metadata_param(header: &str) -> Option<String> {
    const KEY: &str = "resource_metadata=";
    let lower = header.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(KEY) {
        let start = from + pos;
        let value_start = start + KEY.len();
        let at_boundary = start == 0 || matches!(lower.as_bytes()[start - 1], b' ' | b',' | b'\t');
        if at_boundary {
            let rest = &header[value_start..];
            let value = match rest.strip_prefix('"') {
                Some(quoted) => &quoted[..quoted.find('"')?],
                None => rest.split([',', ' ', '\t']).next().unwrap_or_default(),
            };
            return (!value.is_empty()).then(|| value.to_string());
        }
        from = value_start;
    }
    None
}

/// `{origin}/.well-known/oauth-protected-resource{path}`, then the root form.
pub(crate) fn protected_resource_metadata_urls(server: &Url) -> Vec<String> {
    let origin = server.origin().ascii_serialization();
    let path = server.path().trim_end_matches('/');
    let root = format!("{origin}/.well-known/oauth-protected-resource");
    if path.is_empty() {
        vec![root]
    } else {
        vec![format!("{root}{path}"), root]
    }
}

/// RFC 8414 path insertion, then OIDC path insertion, then OIDC path append.
pub(crate) fn auth_server_metadata_urls(issuer: &Url) -> Vec<String> {
    let origin = issuer.origin().ascii_serialization();
    let path = issuer.path().trim_end_matches('/');
    if path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server{path}"),
            format!("{origin}/.well-known/openid-configuration{path}"),
            format!("{origin}{path}/.well-known/openid-configuration"),
        ]
    }
}

async fn fetch_auth_server_metadata(client: &reqwest::Client, issuer: &str) -> Result<AuthServerMetadata, McpError> {
    let issuer_url = parse_secure_url(issuer, "Authorization server")?;
    let mut failures = Vec::new();
    for url in auth_server_metadata_urls(&issuer_url) {
        match fetch_json::<AuthServerMetadata>(client, &url).await {
            Ok(metadata) => {
                validate_auth_server_metadata(&metadata, issuer)?;
                return Ok(metadata);
            }
            Err(e) => {
                debug!(metadata_url = %url, error = %e, "Authorization server metadata not available");
                failures.push(e);
            }
        }
    }
    Err(oauth_err(format!(
        "Could not find OAuth authorization server metadata for {issuer} ({})",
        failures.join("; ")
    )))
}

/// Issuer must match the server it was fetched for; endpoints must be secure.
fn validate_auth_server_metadata(metadata: &AuthServerMetadata, expected_issuer: &str) -> Result<(), McpError> {
    let issuer = metadata.issuer.as_deref().unwrap_or_default();
    if issuer.trim_end_matches('/') != expected_issuer.trim_end_matches('/') {
        return Err(oauth_err(format!(
            "Authorization server metadata issuer '{issuer}' does not match '{expected_issuer}'"
        )));
    }
    parse_secure_url(&metadata.authorization_endpoint, "Authorization endpoint")?;
    parse_secure_url(&metadata.token_endpoint, "Token endpoint")?;
    if let Some(endpoint) = &metadata.registration_endpoint {
        parse_secure_url(endpoint, "Registration endpoint")?;
    }
    if let Some(methods) = &metadata.code_challenge_methods_supported
        && !methods.iter().any(|m| m == "S256")
    {
        return Err(oauth_err(format!(
            "Authorization server {expected_issuer} does not support PKCE S256"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn resource_metadata_param_quoted_and_bare() {
        assert_eq!(
            parse_resource_metadata_param(
                r#"Bearer resource_metadata="https://mcp.bugherd.com/.well-known/oauth-protected-resource""#
            )
            .as_deref(),
            Some("https://mcp.bugherd.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(
            parse_resource_metadata_param("Bearer realm=x, Resource_Metadata=https://a.example/m, scope=read")
                .as_deref(),
            Some("https://a.example/m")
        );
        assert_eq!(parse_resource_metadata_param("Bearer realm=x"), None);
        assert_eq!(parse_resource_metadata_param("Bearer xresource_metadata=a"), None);
    }

    #[test]
    fn protected_resource_urls_insert_path_then_root() {
        assert_eq!(
            protected_resource_metadata_urls(&url("https://mcp.bugherd.com/mcp")),
            vec![
                "https://mcp.bugherd.com/.well-known/oauth-protected-resource/mcp",
                "https://mcp.bugherd.com/.well-known/oauth-protected-resource",
            ]
        );
        assert_eq!(
            protected_resource_metadata_urls(&url("https://mcp.example.com/")),
            vec!["https://mcp.example.com/.well-known/oauth-protected-resource"]
        );
    }

    #[test]
    fn auth_server_urls_use_path_insertion() {
        assert_eq!(
            auth_server_metadata_urls(&url("https://auth.example.com/tenant1")),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
                "https://auth.example.com/.well-known/openid-configuration/tenant1",
                "https://auth.example.com/tenant1/.well-known/openid-configuration",
            ]
        );
        assert_eq!(
            auth_server_metadata_urls(&url("https://mcp.bugherd.com")),
            vec![
                "https://mcp.bugherd.com/.well-known/oauth-authorization-server",
                "https://mcp.bugherd.com/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn secure_url_rejects_plain_http_except_loopback() {
        let err = parse_secure_url("http://auth.example.com/token", "Token endpoint").unwrap_err();
        assert!(err.to_string().contains("must use https"), "{err}");
        assert!(parse_secure_url("http://127.0.0.1:9/x", "x").is_ok());
        assert!(parse_secure_url("http://localhost:9/x", "x").is_ok());
        assert!(parse_secure_url("ftp://auth.example.com", "x").is_err());
    }

    #[test]
    fn resource_must_identify_the_server() {
        let server = url("https://mcp.bugherd.com/mcp");
        assert!(check_resource_matches_server("https://mcp.bugherd.com/mcp", &server).is_ok());
        assert!(check_resource_matches_server("https://mcp.bugherd.com", &server).is_ok());
        assert!(check_resource_matches_server("https://evil.example.com/mcp", &server).is_err());
        assert!(check_resource_matches_server("https://mcp.bugherd.com/mcpx", &server).is_err());
    }

    #[test]
    fn metadata_validation_checks_issuer_and_pkce() {
        let metadata = AuthServerMetadata {
            issuer: Some("https://mcp.bugherd.com".into()),
            authorization_endpoint: "https://mcp.bugherd.com/oauth/authorize".into(),
            token_endpoint: "https://mcp.bugherd.com/oauth/token".into(),
            registration_endpoint: Some("https://mcp.bugherd.com/oauth/register".into()),
            code_challenge_methods_supported: Some(vec!["S256".into()]),
        };
        assert!(validate_auth_server_metadata(&metadata, "https://mcp.bugherd.com/").is_ok());

        let err = validate_auth_server_metadata(&metadata, "https://other.example.com").unwrap_err();
        assert!(err.to_string().contains("does not match"), "{err}");

        let plain = AuthServerMetadata {
            code_challenge_methods_supported: Some(vec!["plain".into()]),
            ..metadata.clone()
        };
        assert!(
            validate_auth_server_metadata(&plain, "https://mcp.bugherd.com")
                .unwrap_err()
                .to_string()
                .contains("S256")
        );

        let insecure = AuthServerMetadata {
            token_endpoint: "http://mcp.bugherd.com/oauth/token".into(),
            ..metadata
        };
        assert!(
            validate_auth_server_metadata(&insecure, "https://mcp.bugherd.com")
                .unwrap_err()
                .to_string()
                .contains("must use https")
        );
    }
}
