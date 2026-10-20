//! Env for the app's built-in stdio MCP servers (browser, artifacts, notes).
//!
//! Electron main puts the relay and artifact-server credentials in aioncore's own env, and
//! the built-ins read them (`packages/desktop/src/process/resources/builtinMcp/aionBrowser/
//! relayClient.ts`, `.../aionArtifacts/apiClient.ts`). An engine that builds an MCP child's env
//! from an allowlist plus the server's explicit `env` map drops them (codex, verified:
//! openai/codex `codex-rs/rmcp-client/src/utils.rs` `create_env_for_mcp_server`), so those
//! lanes pass them explicitly. Only the built-in names get them: on any other server the
//! tokens would leak. A snapshot entry may carry a built-in name only when the user's MCP row of
//! that name is a built-in one (checked when the conversation's MCP snapshot is built).

use aionui_api_types::{SessionMcpServer, SessionMcpTransport};
use serde_json::Value;

use crate::types::AIONUI_CONVERSATION_ID_ENV;

const RELAY_URL: &str = "AION_BROWSER_RELAY_URL";
const RELAY_TOKEN: &str = "AION_BROWSER_RELAY_TOKEN";
const ARTIFACTS_URL: &str = "AION_ARTIFACTS_URL";
const ARTIFACTS_TOKEN: &str = "AION_ARTIFACTS_TOKEN";

/// Keys this module owns on a built-in: whatever the spec carries for them is replaced.
const MANAGED_ENV_KEYS: [&str; 5] = [
    RELAY_URL,
    RELAY_TOKEN,
    ARTIFACTS_URL,
    ARTIFACTS_TOKEN,
    AIONUI_CONVERSATION_ID_ENV,
];

/// Keys whose values never go into a dump or a log.
const SECRET_ENV_KEYS: [&str; 2] = [RELAY_TOKEN, ARTIFACTS_TOKEN];

const REDACTED: &str = "[redacted]";

/// The (url, token) pair a built-in reads, by name; `None` for every other server. Names must
/// match `BUILTIN_*_MCP_NAME` in `packages/desktop/src/common/config/constants.ts`; the keys are
/// what each server reads (`aionBrowser/relayClient.ts`; `aionArtifacts/apiClient.ts`, which
/// `aionNotes/server.ts` also uses). All three also read the conversation id.
fn credential_keys(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "aionui-browser" => Some((RELAY_URL, RELAY_TOKEN)),
        "aionui-artifacts" | "aionui-notes" => Some((ARTIFACTS_URL, ARTIFACTS_TOKEN)),
        _ => None,
    }
}

/// A copy of `server` with its built-in env set when it is one of the built-ins.
/// The conversation id comes from the session's runtime env.
pub(crate) fn with_builtin_mcp_env(server: &SessionMcpServer, runtime_env: &[(String, String)]) -> SessionMcpServer {
    with_builtin_mcp_env_from(server, runtime_env, |key| std::env::var(key).ok())
}

/// The URL and token are set together from the process env, never from the spec, so a spec
/// cannot pair a foreign URL with the real token; each built-in gets only its own pair.
pub(crate) fn with_builtin_mcp_env_from(
    server: &SessionMcpServer,
    runtime_env: &[(String, String)],
    process_env: impl Fn(&str) -> Option<String>,
) -> SessionMcpServer {
    let mut server = server.clone();
    let Some((url_key, token_key)) = credential_keys(&server.name) else {
        return server;
    };
    let SessionMcpTransport::Stdio { env, .. } = &mut server.transport else {
        return server;
    };
    env.retain(|key, _| !MANAGED_ENV_KEYS.contains(&key.as_str()));
    let non_empty = |value: Option<String>| value.filter(|value| !value.is_empty());
    let mut added = Vec::new();
    if let (Some(url), Some(token)) = (non_empty(process_env(url_key)), non_empty(process_env(token_key))) {
        env.insert(url_key.to_owned(), url);
        env.insert(token_key.to_owned(), token);
        added.extend([url_key, token_key]);
    }
    let conversation_id = runtime_env
        .iter()
        .find(|(key, _)| key == AIONUI_CONVERSATION_ID_ENV)
        .and_then(|(_, value)| non_empty(Some(value.clone())));
    if let Some(conversation_id) = conversation_id {
        env.insert(AIONUI_CONVERSATION_ID_ENV.to_owned(), conversation_id);
        added.push(AIONUI_CONVERSATION_ID_ENV);
    }
    // Keys only: no url/token pair means the relay / artifact server was not running.
    tracing::info!(server = %server.name, keys = ?added, "builtin MCP: env passed explicitly");
    server
}

/// True for the app's built-in MCP server names.
pub fn is_builtin_mcp_name(name: &str) -> bool {
    credential_keys(name).is_some()
}

/// Resolve a built-in's bare `node` to an absolute path, as the ACP lane does for every
/// snapshot server (`factory::acp::ensure_stdio_launch`). On failure the server is kept as is.
pub(crate) async fn resolve_builtin_command(server: SessionMcpServer) -> SessionMcpServer {
    if !is_builtin_mcp_name(&server.name) {
        return server;
    }
    let SessionMcpTransport::Stdio { command, args, env } = &server.transport else {
        return server;
    };
    match aionui_runtime::ensure_runtime_command(command).await {
        Ok(resolved) => {
            let mut final_args: Vec<String> = resolved
                .args_prefix
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            final_args.extend(args.iter().cloned());
            let mut final_env = env.clone();
            final_env.extend(
                resolved
                    .env
                    .iter()
                    .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())),
            );
            SessionMcpServer {
                transport: SessionMcpTransport::Stdio {
                    command: resolved.program.to_string_lossy().into_owned(),
                    args: final_args,
                    env: final_env,
                },
                ..server
            }
        }
        Err(error) => {
            tracing::warn!(server = %server.name, command = %command, error = %error, "builtin MCP: launch command not resolved; using it as is");
            server
        }
    }
}

/// `value` with every built-in secret replaced, both as a map key (`{"KEY": "v"}`) and as an
/// env entry (`{"name": "KEY", "value": "v"}`).
pub(crate) fn redact_secret_env(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let names_secret = map
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| SECRET_ENV_KEYS.contains(&name));
            Value::Object(
                map.into_iter()
                    .map(|(key, value)| {
                        let secret = SECRET_ENV_KEYS.contains(&key.as_str()) || (names_secret && key == "value");
                        let value = if secret {
                            Value::String(REDACTED.to_owned())
                        } else {
                            redact_secret_env(value)
                        };
                        (key, value)
                    })
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_secret_env).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn stdio(name: &str, env: &[(&str, &str)]) -> SessionMcpServer {
        SessionMcpServer {
            id: format!("id-{name}"),
            name: name.into(),
            transport: SessionMcpTransport::Stdio {
                command: "node".into(),
                args: vec!["server.js".into()],
                env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
            },
        }
    }

    fn fake_process_env(key: &str) -> Option<String> {
        match key {
            "AION_BROWSER_RELAY_URL" => Some("ws://127.0.0.1:4100".into()),
            "AION_BROWSER_RELAY_TOKEN" => Some("relay-secret".into()),
            "AION_ARTIFACTS_URL" => Some("http://127.0.0.1:4200".into()),
            "AION_ARTIFACTS_TOKEN" => Some("artifacts-secret".into()),
            _ => None,
        }
    }

    fn runtime_env() -> Vec<(String, String)> {
        vec![(AIONUI_CONVERSATION_ID_ENV.into(), "conv-1".into())]
    }

    fn env_of(server: &SessionMcpServer) -> &HashMap<String, String> {
        match &server.transport {
            SessionMcpTransport::Stdio { env, .. } => env,
            _ => panic!("stdio expected"),
        }
    }

    #[test]
    fn each_builtin_gets_only_its_own_keys() {
        let browser = with_builtin_mcp_env_from(&stdio("aionui-browser", &[]), &runtime_env(), fake_process_env);
        let mut keys: Vec<_> = env_of(&browser).keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, [AIONUI_CONVERSATION_ID_ENV, RELAY_TOKEN, RELAY_URL]);
        assert_eq!(env_of(&browser)[RELAY_URL], "ws://127.0.0.1:4100");
        assert_eq!(env_of(&browser)[RELAY_TOKEN], "relay-secret");
        assert_eq!(env_of(&browser)[AIONUI_CONVERSATION_ID_ENV], "conv-1");

        for name in ["aionui-artifacts", "aionui-notes"] {
            let server = with_builtin_mcp_env_from(&stdio(name, &[]), &runtime_env(), fake_process_env);
            let mut keys: Vec<_> = env_of(&server).keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                [AIONUI_CONVERSATION_ID_ENV, ARTIFACTS_TOKEN, ARTIFACTS_URL],
                "{name}"
            );
            assert_eq!(env_of(&server)[ARTIFACTS_URL], "http://127.0.0.1:4200");
            assert_eq!(env_of(&server)[ARTIFACTS_TOKEN], "artifacts-secret");
            assert_eq!(env_of(&server)[AIONUI_CONVERSATION_ID_ENV], "conv-1");
        }
    }

    #[test]
    fn other_servers_get_none_of_it() {
        let server = with_builtin_mcp_env_from(
            &stdio("aionui-browser-copy", &[("USER_KEY", "v")]),
            &runtime_env(),
            fake_process_env,
        );
        assert_eq!(env_of(&server).len(), 1);
        assert_eq!(env_of(&server)["USER_KEY"], "v");
        assert!(!is_builtin_mcp_name("aionui-browser-copy"));
    }

    #[test]
    fn spec_url_is_replaced_by_the_process_url() {
        let server = with_builtin_mcp_env_from(
            &stdio(
                "aionui-browser",
                &[(RELAY_URL, "ws://evil.example:1"), ("USER_KEY", "kept")],
            ),
            &runtime_env(),
            fake_process_env,
        );
        let env = env_of(&server);
        assert_eq!(env[RELAY_URL], "ws://127.0.0.1:4100");
        assert_eq!(env[RELAY_TOKEN], "relay-secret");
        assert_eq!(env["USER_KEY"], "kept");
    }

    #[test]
    fn spec_values_are_dropped_when_the_process_has_no_pair() {
        // Only a URL in the process env: no half pair, and the spec's own values go too.
        let server = with_builtin_mcp_env_from(
            &stdio(
                "aionui-artifacts",
                &[
                    (ARTIFACTS_URL, "http://evil.example"),
                    (ARTIFACTS_TOKEN, "stale"),
                    (RELAY_TOKEN, "foreign"),
                    (AIONUI_CONVERSATION_ID_ENV, "other-chat"),
                ],
            ),
            &[],
            |key| (key == ARTIFACTS_URL).then(|| "http://127.0.0.1:4200".to_owned()),
        );
        assert!(env_of(&server).is_empty(), "{:?}", env_of(&server));
    }

    #[test]
    fn redaction_covers_map_and_name_value_shapes() {
        let dump = serde_json::json!({
            "mcp_servers": [
                { "env": { "AION_BROWSER_RELAY_TOKEN": "relay-secret", "AION_BROWSER_RELAY_URL": "ws://x" } },
                { "env": [
                    { "name": "AION_ARTIFACTS_TOKEN", "value": "artifacts-secret" },
                    { "name": "OTHER", "value": "kept" }
                ] }
            ]
        });
        let redacted = redact_secret_env(dump).to_string();
        assert!(!redacted.contains("relay-secret"), "{redacted}");
        assert!(!redacted.contains("artifacts-secret"), "{redacted}");
        assert!(redacted.contains("ws://x"));
        assert!(redacted.contains("kept"));
    }
}
