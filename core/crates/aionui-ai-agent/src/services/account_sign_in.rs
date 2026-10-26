//! Signing an engine account in: whether its config dir holds a login, and a terminal that runs the CLI on that dir.

use std::path::Path;

use aionui_runtime::Builder as CmdBuilder;

/// The CLI the terminal runs; on a config dir with no login it walks the user through signing in (`/login` otherwise).
const SIGN_IN_CLI: &str = "claude";
/// The script Terminal opens on macOS, written into the account's dir.
const MAC_SCRIPT: &str = "sign-in.command";

/// Whether the claude CLI on `dir` is signed in. verified on real installs (2026-10-26): Windows keeps the login in
/// `<dir>/.credentials.json` (present for the signed-in default dir, absent for a never-signed-in account), and macOS
/// keeps the token in the keychain while `<dir>/.claude.json` records the signed-in `oauthAccount` (present only on the
/// signed-in account dir).
pub(crate) fn is_signed_in(dir: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return dir.join(".credentials.json").is_file();
    }
    std::fs::read_to_string(dir.join(".claude.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .is_some_and(|json| json.get("oauthAccount").is_some_and(|account| !account.is_null()))
}

/// A POSIX single-quoted word.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The macOS script: the CLI on the account's dir, in the user's own shell environment.
fn mac_script(env_key: &str, dir: &str) -> String {
    format!("#!/bin/sh\nexport {env_key}={}\nexec {SIGN_IN_CLI}\n", shell_quote(dir))
}

/// Opens a terminal window running the CLI with `env_key` pointing at `dir`. macOS opens a `.command` script in
/// Terminal (no automation permission needed); Windows opens a console through `start`. Other systems are unsupported.
pub(crate) async fn open_sign_in_terminal(env_key: &str, dir: &Path) -> std::io::Result<()> {
    let mut command = if cfg!(target_os = "macos") {
        let script = dir.join(MAC_SCRIPT);
        tokio::fs::write(&script, mac_script(env_key, &dir.to_string_lossy())).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let mut command = CmdBuilder::new("open");
        command.arg("-a").arg("Terminal").arg(script);
        command
    } else if cfg!(windows) {
        // `start ""`: the empty title keeps `start` from reading the program as one. The new console inherits the env.
        let mut command = CmdBuilder::new("cmd");
        command
            .args(["/c", "start", "", "cmd", "/k", SIGN_IN_CLI])
            .env(env_key, dir);
        command
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "opening a terminal is not supported on this system",
        ));
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let output = command.output().await?;
    if output.status.success() {
        return Ok(());
    }
    Err(std::io::Error::other(format!(
        "terminal launcher exited with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_script_quotes_the_dir_for_the_shell() {
        let script = mac_script("CLAUDE_CONFIG_DIR", "/Users/a/Application Support/it's/x");
        assert_eq!(
            script,
            "#!/bin/sh\nexport CLAUDE_CONFIG_DIR='/Users/a/Application Support/it'\\''s/x'\nexec claude\n"
        );
    }

    #[test]
    fn an_empty_dir_is_not_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".claude.json"), r#"{"hasCompletedOnboarding":false}"#).unwrap();
        assert!(!is_signed_in(dir.path()));
    }

    #[test]
    fn a_dir_with_the_platform_login_is_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        if cfg!(target_os = "macos") {
            std::fs::write(
                dir.path().join(".claude.json"),
                r#"{"oauthAccount":{"accountUuid":"x"}}"#,
            )
            .unwrap();
        } else {
            std::fs::write(dir.path().join(".credentials.json"), "{}").unwrap();
        }
        assert!(is_signed_in(dir.path()));
    }
}
