//! OAuth 2.0 Dynamic Client Registration (RFC 7591) for MCP servers.

use serde::{Deserialize, Serialize};

use crate::error::McpError;
use crate::oauth_discovery::{MAX_RESPONSE_BYTES, read_capped};

/// Name shown to the user on the authorization server's consent screen.
pub(crate) const CLIENT_NAME: &str = "Pixebot Browser";

#[derive(Debug, Serialize)]
struct RegistrationRequest<'a> {
    client_name: &'a str,
    redirect_uris: [&'a str; 1],
    grant_types: [&'a str; 2],
    response_types: [&'a str; 1],
    token_endpoint_auth_method: &'a str,
}

/// Client credentials issued by the authorization server.
#[derive(Debug, Deserialize)]
pub(crate) struct RegisteredClient {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorBody {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Register a public native client for `redirect_uri` at `endpoint`.
pub(crate) async fn register_client(
    client: &reqwest::Client,
    endpoint: &str,
    redirect_uri: &str,
) -> Result<RegisteredClient, McpError> {
    let request = RegistrationRequest {
        client_name: CLIENT_NAME,
        redirect_uris: [redirect_uri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
    };
    let resp = client
        .post(endpoint)
        .json(&request)
        .send()
        .await
        .map_err(|e| McpError::OAuth(format!("Client registration request to {endpoint} failed: {e}")))?;
    let status = resp.status();
    let body = read_capped(resp, MAX_RESPONSE_BYTES)
        .await
        .map_err(|e| McpError::OAuth(format!("Client registration failed: {e}")))?;

    if !status.is_success() {
        let detail = serde_json::from_slice::<OAuthErrorBody>(&body)
            .map(|b| match b.error_description {
                Some(description) => format!(": {} ({description})", b.error),
                None => format!(": {}", b.error),
            })
            .unwrap_or_default();
        return Err(McpError::OAuth(format!(
            "Client registration at {endpoint} was rejected with HTTP {status}{detail}"
        )));
    }

    // Parse errors are not echoed: they can quote field values such as a secret.
    let registered: RegisteredClient = serde_json::from_slice(&body).map_err(|_| {
        McpError::OAuth(format!(
            "Client registration at {endpoint} returned an invalid response"
        ))
    })?;
    if registered.client_id.trim().is_empty() {
        return Err(McpError::OAuth(format!(
            "Client registration at {endpoint} returned an empty client_id"
        )));
    }
    Ok(registered)
}
