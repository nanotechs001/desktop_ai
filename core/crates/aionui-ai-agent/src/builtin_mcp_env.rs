//! Env for the app's built-in stdio MCP servers (browser, artifacts, notes).
//!
//! Electron main puts the relay and artifact-server credentials in aioncore's own env, and
//! the built-ins read them (`packages/desktop/src/process/resources/builtinMcp/aionBrowser/
//! relayClient.ts`, `.../aionArtifacts/apiClient.ts`). An engine that builds an MCP child's env
//! from an allowlist plus the server's explicit `env` map drops them (codex, verified:
//! openai/codex `codex-rs/rmcp-client/src/utils.rs` `create_env_for_mcp_server`), so those
//! lanes pass them explicitly. Only the built-in names get them: on any other server the
//! tokens would leak.

use aionui_api_types::{SessionMcpServer, SessionMcpTransport};
use serde_json::Value;

use crate::types::AIONUI_CONVERSATION_ID_ENV;

/// Must match `BUILTIN_*_MCP_NAME` in `packages/desktop/src/common/config/constants.ts`.
const BUILTIN_MCP_NAMES: [&str; 3] = ["aionui-browser", "aionui-artifacts", "aionui-notes"];

/// What the built-ins read that aioncore inherits from Electron main (`index.ts`).
const INHERITED_ENV_KEYS: [&str; 4] = [
    "AION_BROWSER_RELAY_URL",
    "AION_BROWSER_RELAY_TOKEN",
    "AION_ARTIFACTS_URL",
    "AION_ARTIFACTS_TOKEN",
];

/// Keys whose values never go into a dump or a log.
const SECRET_ENV_KEYS: [&str; 2] = ["AION_BROWSER_RELAY_TOKEN", "AION_ARTIFACTS_TOKEN"];

const REDACTED: &str = "[redacted]";

/// A copy of `server` with the built-in env added when it is one of the built-ins.
/// The conversation id comes from the session's runtime env. A value already in the spec wins.
pub(crate) fn with_builtin_mcp_env(server: &SessionMcpServer, runtime_env: &[(String, String)]) -> SessionMcpServer {
    with_builtin_mcp_env_from(server, runtime_env, |key| std::env::var(key).ok())
}

pub(crate) fn with_builtin_mcp_env_from(
    server: &SessionMcpServer,
    runtime_env: &[(String, String)],
    process_env: impl Fn(&str) -> Option<String>,
) -> SessionMcpServer {
    let mut server = server.clone();
    if !is_builtin_mcp_name(&server.name) {
        return server;
    }
    let SessionMcpTransport::Stdio { env, .. } = &mut server.transport else {
        return server;
    };
    let conversation_id = runtime_env
        .iter()
        .find(|(key, _)| key == AIONUI_CONVERSATION_ID_ENV)
        .map(|(_, value)| value.clone());
    let values = INHERITED_ENV_KEYS
        .iter()
        .map(|key| (*key, process_env(key)))
        .chain(std::iter::once((AIONUI_CONVERSATION_ID_ENV, conversation_id)));
    let mut added = Vec::new();
    for (key, value) in values {
        let Some(value) = value.filter(|value| !value.is_empty()) else {
            continue;
        };
        if !env.contains_key(key) {
            env.insert(key.to_owned(), value);
            added.push(key);
        }
    }
    // Keys only: an empty list means the relay / artifact server was not running.
    tracing::info!(server = %server.name, keys = ?added, "builtin MCP: env passed explicitly");
    server
}

pub(crate) fn is_builtin_mcp_name(name: &str) -> bool {
    BUILTIN_MCP_NAMES.contains(&name)
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
    fn builtin_servers_get_relay_artifacts_and_conversation_env() {
        for name in BUILTIN_MCP_NAMES {
            let server = with_builtin_mcp_env_from(&stdio(name, &[]), &runtime_env(), fake_process_env);
            let env = env_of(&server);
            assert_eq!(env["AION_BROWSER_RELAY_URL"], "ws://127.0.0.1:4100");
            assert_eq!(env["AION_BROWSER_RELAY_TOKEN"], "relay-secret");
            assert_eq!(env["AION_ARTIFACTS_URL"], "http://127.0.0.1:4200");
            assert_eq!(env["AION_ARTIFACTS_TOKEN"], "artifacts-secret");
            assert_eq!(env[AIONUI_CONVERSATION_ID_ENV], "conv-1");
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
    }

    #[test]
    fn explicit_spec_value_wins_and_missing_values_are_not_set() {
        let server = with_builtin_mcp_env_from(
            &stdio("aionui-browser", &[("AION_BROWSER_RELAY_URL", "ws://explicit")]),
            &[],
            |key| (key == "AION_BROWSER_RELAY_URL").then(|| "ws://process".to_owned()),
        );
        let env = env_of(&server);
        assert_eq!(env["AION_BROWSER_RELAY_URL"], "ws://explicit");
        assert_eq!(
            env.len(),
            1,
            "unset keys and the absent conversation id are left out: {env:?}"
        );
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
