//! OpenCode gets the app's built-in MCP servers through its own config, so their tools are
//! offered to the model directly.
//!
//! OpenCode puts every ACP `mcpServers` entry behind its Code Mode `execute` tool, listed in a
//! catalog with a size budget (opencode v2.1.2: 2000 units of ~4 chars, shared by all servers,
//! cheapest tool first; a server stops listing at its first tool that does not fit), so the
//! browser's `act` went unlisted and weak models never found it. ACP cannot say otherwise: its
//! adapter keeps only command, args and env. OpenCode's config can: a server with
//! `codemode: false` under `mcp.servers` is offered as direct tools (`<server>_<tool>`).
//! Verified against opencode v2.1.2 with a probe server: `codemode: false` under `mcp.servers`
//! gave a direct `probe-two_shout` call; the legacy `mcp.<name>` layout drops `codemode`; and
//! `{env:NAME}` in `environment` is filled from OpenCode's own env.
//!
//! The relay and artifact credentials stay out of the config text: they are written as
//! `{env:NAME}`, which OpenCode fills from its env, inherited from aioncore's
//! (`aionui_runtime::agent_process_env`), where the launch read them in the first place.

use agent_client_protocol::schema::v1::McpServer;
use serde_json::{Map, Value, json};

use crate::factory::builtin_mcp_env::{is_builtin_mcp_name, is_process_env_credential};

/// The env var OpenCode reads an extra config document from.
pub(crate) const OPENCODE_CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

const OPENCODE_BACKEND: &str = "opencode";

/// OpenCode config substitutes these in any string; a literal carrying one is left on ACP.
const CONFIG_SUBSTITUTIONS: [&str; 2] = ["{env:", "{file:"];

/// The servers to send over ACP and, for an OpenCode session, the `OPENCODE_CONFIG_CONTENT` that
/// launches the built-ins instead. Nothing moves for other backends, or when the user already
/// sets `OPENCODE_CONFIG_CONTENT` (setting ours would replace theirs).
pub(crate) fn route_builtin_mcp_servers(
    backend: Option<&str>,
    servers: Vec<McpServer>,
    user_config_content_set: bool,
) -> (Vec<McpServer>, Option<String>) {
    if backend != Some(OPENCODE_BACKEND) || user_config_content_set {
        return (servers, None);
    }
    let mut config_servers = Map::new();
    let mut acp_servers = Vec::with_capacity(servers.len());
    for server in servers {
        match direct_server_config(&server) {
            Some((name, config)) => {
                config_servers.insert(name, config);
            }
            None => acp_servers.push(server),
        }
    }
    if config_servers.is_empty() {
        return (acp_servers, None);
    }
    let names: Vec<&String> = config_servers.keys().collect();
    tracing::info!(servers = ?names, "opencode: built-in MCP servers launched from config with codemode off");
    let content = json!({ "mcp": { "servers": config_servers } }).to_string();
    (acp_servers, Some(content))
}

/// `(name, OpenCode local server config)` for a built-in stdio server; `None` for anything else.
fn direct_server_config(server: &McpServer) -> Option<(String, Value)> {
    let McpServer::Stdio(stdio) = server else {
        return None;
    };
    if !is_builtin_mcp_name(&stdio.name) {
        return None;
    }
    let mut command = vec![stdio.command.to_str()?.to_owned()];
    command.extend(stdio.args.iter().cloned());
    let literal_env = stdio.env.iter().filter(|var| !is_process_env_credential(&var.name));
    let substituted = command
        .iter()
        .chain(literal_env.map(|var| &var.value))
        .any(|text| CONFIG_SUBSTITUTIONS.iter().any(|marker| text.contains(marker)));
    if substituted {
        tracing::warn!(server = %stdio.name, "opencode: built-in launch text looks like a config substitution; kept on ACP");
        return None;
    }
    let environment: Map<String, Value> = stdio
        .env
        .iter()
        .map(|var| {
            let value = if is_process_env_credential(&var.name) {
                format!("{{env:{}}}", var.name)
            } else {
                var.value.clone()
            };
            (var.name.clone(), Value::String(value))
        })
        .collect();
    let config = json!({
        "type": "local",
        "command": command,
        "environment": environment,
        "codemode": false,
    });
    Some((stdio.name.clone(), config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};

    fn stdio(name: &str, env: &[(&str, &str)]) -> McpServer {
        McpServer::Stdio(
            McpServerStdio::new(name, "/usr/local/bin/node")
                .args(vec!["/app/aionBrowser.js".to_owned()])
                .env(env.iter().map(|(k, v)| EnvVariable::new(*k, *v)).collect()),
        )
    }

    fn names(servers: &[McpServer]) -> Vec<String> {
        servers
            .iter()
            .map(|server| match server {
                McpServer::Stdio(stdio) => stdio.name.clone(),
                _ => "other".to_owned(),
            })
            .collect()
    }

    #[test]
    fn opencode_launches_builtins_from_config_with_codemode_off_and_keeps_user_servers_on_acp() {
        let servers = vec![
            stdio(
                "aionui-browser",
                &[
                    ("AION_BROWSER_RELAY_URL", "ws://127.0.0.1:1/"),
                    ("AION_BROWSER_RELAY_TOKEN", "real-token"),
                    ("AIONUI_CONVERSATION_ID", "353fd4bb"),
                ],
            ),
            stdio("mcp-docs", &[("DOCS_KEY", "k")]),
        ];
        let (acp, content) = route_builtin_mcp_servers(Some("opencode"), servers, false);
        assert_eq!(names(&acp), ["mcp-docs"]);
        let content = content.expect("config content");
        assert!(
            !content.contains("real-token"),
            "tokens must not be written into the config"
        );
        assert!(
            !content.contains("ws://127.0.0.1:1/"),
            "the relay url comes from the env too"
        );
        let config: Value = serde_json::from_str(&content).unwrap();
        let browser = &config["mcp"]["servers"]["aionui-browser"];
        assert_eq!(browser["type"], "local");
        assert_eq!(browser["codemode"], false);
        assert_eq!(
            browser["command"],
            json!(["/usr/local/bin/node", "/app/aionBrowser.js"])
        );
        assert_eq!(
            browser["environment"]["AION_BROWSER_RELAY_TOKEN"],
            "{env:AION_BROWSER_RELAY_TOKEN}"
        );
        assert_eq!(
            browser["environment"]["AION_BROWSER_RELAY_URL"],
            "{env:AION_BROWSER_RELAY_URL}"
        );
        assert_eq!(browser["environment"]["AIONUI_CONVERSATION_ID"], "353fd4bb");
    }

    #[test]
    fn other_backends_and_a_user_set_config_content_keep_everything_on_acp() {
        let servers = || vec![stdio("aionui-notes", &[])];
        for (backend, user_set) in [(Some("goose"), false), (None, false), (Some("opencode"), true)] {
            let (acp, content) = route_builtin_mcp_servers(backend, servers(), user_set);
            assert_eq!(names(&acp), ["aionui-notes"]);
            assert!(content.is_none());
        }
    }

    #[test]
    fn opencode_without_builtins_sets_no_config() {
        let (acp, content) = route_builtin_mcp_servers(Some("opencode"), vec![stdio("mcp-docs", &[])], false);
        assert_eq!(names(&acp), ["mcp-docs"]);
        assert!(content.is_none());
    }

    #[test]
    fn a_launch_literal_that_opencode_would_substitute_stays_on_acp() {
        let servers = vec![stdio("aionui-artifacts", &[("AIONUI_CONVERSATION_ID", "{env:HOME}")])];
        let (acp, content) = route_builtin_mcp_servers(Some("opencode"), servers, false);
        assert_eq!(names(&acp), ["aionui-artifacts"]);
        assert!(content.is_none());
    }
}
