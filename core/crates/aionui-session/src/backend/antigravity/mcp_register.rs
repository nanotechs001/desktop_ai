//! Registers a session's MCP servers with agy.
//!
//! agy 1.5.13 takes MCP servers only from its global config: `--settings` has no MCP key, and a
//! server added with `agy mcp add` is started and called in a `-p` run. The server inherits agy's
//! process env as well as the entry's own `--env` (verified:
//! `~/aion/protocols/samples/antigravity/1.5.13/mcp-global-config/`). So an entry carries only
//! the launch command, never env: per-chat values and tokens reach the server through the env of
//! the agy process each turn runs, and nothing secret is written to the user's config.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use aionui_common::{CommandSpec, EnvVar};
use aionui_process::Spawner;

use crate::backend::{McpServerSpec, McpTransport};

/// `agy mcp add` takes under half a second; this only bounds a hung agy.
const REGISTER_TIMEOUT: Duration = Duration::from_secs(20);

/// The `agy mcp add` arguments that register `spec` without env; `None` for a non-stdio server.
pub(crate) fn mcp_add_args(spec: &McpServerSpec) -> Option<Vec<String>> {
    let McpTransport::Stdio { command, args, .. } = &spec.transport else {
        return None;
    };
    // `--` keeps a command or argument that starts with '-' from being read as a flag (`agy mcp add --help`).
    let mut out = vec![
        "mcp".to_owned(),
        "add".to_owned(),
        spec.name.clone(),
        "--".to_owned(),
        command.clone(),
    ];
    out.extend(args.iter().cloned());
    Some(out)
}

/// Argument lists this process already registered: agy keeps them in its config, so one run each suffices.
fn registered() -> &'static Mutex<HashSet<Vec<String>>> {
    static REGISTERED: OnceLock<Mutex<HashSet<Vec<String>>>> = OnceLock::new();
    REGISTERED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Registers every stdio server in `specs` that this process has not registered yet, one at a time
/// (each `agy mcp add` rewrites the same config file). Best-effort: a failure is logged and the
/// session opens without that server's tools.
pub(crate) async fn register_mcp_servers(
    spawner: &Arc<dyn Spawner>,
    program: &std::path::Path,
    specs: &[McpServerSpec],
    spawn_env: &[EnvVar],
    owner_tag: &str,
) {
    for spec in specs {
        let Some(args) = mcp_add_args(spec) else { continue };
        if registered().lock().is_ok_and(|done| done.contains(&args)) {
            continue;
        }
        if run_mcp_add(spawner, program, &args, spawn_env, owner_tag).await {
            if let Ok(mut done) = registered().lock() {
                done.insert(args);
            }
            tracing::info!(server = %spec.name, "antigravity: MCP server registered with agy");
        } else {
            tracing::warn!(server = %spec.name, "antigravity: could not register the MCP server with agy; its tools are unavailable");
        }
    }
}

async fn run_mcp_add(
    spawner: &Arc<dyn Spawner>,
    program: &std::path::Path,
    args: &[String],
    spawn_env: &[EnvVar],
    owner_tag: &str,
) -> bool {
    let spec = CommandSpec {
        command: program.to_path_buf(),
        args: args.to_vec(),
        env: spawn_env.to_vec(),
        cwd: None,
    };
    let Ok(proc) = spawner.spawn(spec, &[], owner_tag).await else {
        return false;
    };
    // Closed stdin, as for `agy models`, so agy never waits on it.
    if let Some((stdin, stdout)) = proc.take_stdio().await {
        drop(stdin);
        drop(stdout);
    }
    match tokio::time::timeout(REGISTER_TIMEOUT, proc.wait_for_exit()).await {
        Ok(status) => status.is_some_and(|s| s.success()),
        Err(_) => {
            let _ = proc.kill(Duration::from_secs(1)).await;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str, command: &str, args: &[&str]) -> McpServerSpec {
        McpServerSpec {
            name: name.to_owned(),
            transport: McpTransport::Stdio {
                command: command.to_owned(),
                args: args.iter().map(|a| (*a).to_owned()).collect(),
                env: vec![("AION_BROWSER_RELAY_TOKEN".to_owned(), "secret".to_owned())],
            },
        }
    }

    #[test]
    fn registers_the_launch_command_without_env() {
        let args = mcp_add_args(&stdio("aionui-browser", "node", &["/app/builtin-mcp-browser.js"])).unwrap();
        assert_eq!(
            args,
            [
                "mcp",
                "add",
                "aionui-browser",
                "--",
                "node",
                "/app/builtin-mcp-browser.js"
            ]
        );
        assert!(
            !args.iter().any(|a| a.contains("secret") || a == "--env"),
            "env must never reach agy's config"
        );
    }

    #[test]
    fn skips_servers_agy_cannot_launch_from_a_command() {
        let http = McpServerSpec {
            name: "remote".to_owned(),
            transport: McpTransport::Http {
                url: "https://example.com/mcp".to_owned(),
                headers: vec![],
            },
        };
        assert!(mcp_add_args(&http).is_none());
    }

    /// A stand-in for agy that appends its arguments to `calls.txt` and exits 0.
    #[cfg(unix)]
    fn fake_agy(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake-agy");
        let log = dir.join("calls.txt");
        std::fs::write(&script, format!("#!/bin/sh\necho \"$*\" >> '{}'\n", log.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_agy_mcp_add_once_per_server_per_process() {
        let tmp = tempfile::tempdir().unwrap();
        let program = fake_agy(tmp.path());
        let spawner: Arc<dyn Spawner> = Arc::new(aionui_process::RealSpawner::new(
            Arc::new(aionui_process::FileRegistryStore::new(tmp.path())),
            uuid::Uuid::now_v7(),
            "test-machine",
        ));
        // A unique script path, so other tests' registrations cannot satisfy this one.
        let script = tmp.path().join("builtin-mcp-notes.js").display().to_string();
        let specs = [stdio("aionui-notes", "node", &[&script])];

        register_mcp_servers(&spawner, &program, &specs, &[], "register-test").await;
        register_mcp_servers(&spawner, &program, &specs, &[], "register-test").await;

        let calls = std::fs::read_to_string(tmp.path().join("calls.txt")).unwrap();
        assert_eq!(calls, format!("mcp add aionui-notes -- node {script}\n"));
    }
}
