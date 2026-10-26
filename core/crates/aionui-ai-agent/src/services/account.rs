//! Engine accounts: another login of a builtin CLI engine as its own catalog row.
//!
//! An account row copies the builtin row (same backend, command and
//! `agent_source = "builtin"`, so every builtin code path treats it alike) and
//! adds one env var pointing the CLI at the account's own config dir under the
//! data dir. `agent_source_info.account_of` marks it, so vendor-label lookups
//! keep resolving the seeded row.

use aionui_api_types::{AgentAccountStatus, AgentEnvEntry, AgentMetadata, AgentSourceInfo};
use aionui_common::generate_short_id;
use aionui_db::UpsertAgentMetadataParams;
use tracing::{info, warn};

use super::AgentService;
use super::account_sign_in::{is_signed_in, open_sign_in_terminal};
use crate::error::AgentError;

/// Backends whose CLI keeps a separate login per config dir, and the env var naming it.
/// verified: claude.exe 2.1.301 reads `.credentials.json` from `CLAUDE_CONFIG_DIR ?? ~/.claude` and suffixes its
/// keychain entry with a hash of that dir (strings of the binary).
const ACCOUNT_CONFIG_DIR_ENV: &[(&str, &str)] = &[("claude", "CLAUDE_CONFIG_DIR")];
const ACCOUNTS_DIR: &str = "accounts";

fn parse_source_info(raw: Option<&str>) -> AgentSourceInfo {
    raw.and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default()
}

impl AgentService {
    /// Adds an account of the builtin engine `base_id`: a new engine row whose CLI uses its own config dir, so the
    /// user can sign it in to another account. Returns the new row.
    pub async fn create_agent_account(
        &self,
        user_id: &str,
        base_id: &str,
        label: &str,
    ) -> Result<AgentMetadata, AgentError> {
        let label = label.trim();
        if label.is_empty() {
            return Err(AgentError::bad_request("label must not be empty"));
        }
        let repo = self.registry().repo_handle();
        let base = repo
            .get_for_user(user_id, base_id)
            .await
            .map_err(|e| AgentError::internal(format!("repo.get_for_user: {e}")))?
            .ok_or_else(|| AgentError::not_found(format!("Agent '{base_id}' not found")))?;
        let base_info = parse_source_info(base.agent_source_info.as_deref());
        let env_key = ACCOUNT_CONFIG_DIR_ENV
            .iter()
            .find(|(backend, _)| base.backend.as_deref() == Some(*backend))
            .map(|(_, key)| *key)
            .filter(|_| base.agent_source == "builtin" && base_info.account_of.is_none())
            .ok_or_else(|| AgentError::bad_request(format!("Agent '{base_id}' does not support accounts")))?;

        let id = generate_short_id();
        let config_dir = self.data_dir().join(ACCOUNTS_DIR).join(&id);
        tokio::fs::create_dir_all(&config_dir)
            .await
            .map_err(|e| AgentError::internal(format!("create account dir: {e}")))?;

        let config_dir = config_dir.to_string_lossy().into_owned();
        let mut env: Vec<AgentEnvEntry> = base
            .env
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default();
        env.retain(|entry| entry.name != env_key);
        env.push(AgentEnvEntry {
            name: env_key.to_owned(),
            value: config_dir.clone(),
            description: None,
        });
        let env_json = serde_json::to_string(&env).map_err(|e| AgentError::internal(format!("encode env: {e}")))?;
        let info_json = serde_json::to_string(&AgentSourceInfo {
            account_of: Some(base_id.to_owned()),
            account_dir: Some(config_dir),
            ..base_info
        })
        .map_err(|e| AgentError::internal(format!("encode agent_source_info: {e}")))?;
        let name = format!("{} · {label}", base.name);

        let params = UpsertAgentMetadataParams {
            id: &id,
            icon: base.icon.as_deref(),
            name: &name,
            // The label is the user's own, so no localized name may replace it.
            name_i18n: None,
            description: base.description.as_deref(),
            description_i18n: base.description_i18n.as_deref(),
            backend: base.backend.as_deref(),
            agent_type: &base.agent_type,
            agent_source: &base.agent_source,
            agent_source_info: Some(&info_json),
            enabled: true,
            command: base.command.as_deref(),
            args: base.args.as_deref(),
            env: Some(&env_json),
            native_skills_dirs: base.native_skills_dirs.as_deref(),
            skill_delivery: base.skill_delivery.as_deref(),
            behavior_policy: base.behavior_policy.as_deref(),
            yolo_id: base.yolo_id.as_deref(),
            agent_capabilities: base.agent_capabilities.as_deref(),
            auth_methods: base.auth_methods.as_deref(),
            config_options: base.config_options.as_deref(),
            available_modes: base.available_modes.as_deref(),
            available_models: base.available_models.as_deref(),
            available_commands: base.available_commands.as_deref(),
            sort_order: base.sort_order + 1,
        };
        repo.upsert_for_user(user_id, &params)
            .await
            .map_err(|e| AgentError::internal(format!("repo.upsert_for_user: {e}")))?;
        self.registry()
            .reload_one(&id)
            .await
            .map_err(|e| AgentError::internal(format!("registry reload: {e}")))?;
        info!(agent_id = %id, base_id, "engine account created");

        self.registry()
            .get_for_user(user_id, &id)
            .await?
            .ok_or_else(|| AgentError::internal(format!("Agent '{id}' not visible after upsert")))
    }

    /// Whether each of the user's engine accounts is signed in.
    pub async fn agent_account_status(&self, user_id: &str) -> Result<Vec<AgentAccountStatus>, AgentError> {
        let rows = self
            .registry()
            .repo_handle()
            .list_all_for_user(user_id)
            .await
            .map_err(|e| AgentError::internal(format!("repo.list_all_for_user: {e}")))?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let info = parse_source_info(row.agent_source_info.as_deref());
                info.account_of?;
                let signed_in = info
                    .account_dir
                    .is_some_and(|dir| is_signed_in(std::path::Path::new(&dir)));
                Some(AgentAccountStatus { id: row.id, signed_in })
            })
            .collect())
    }

    /// Opens a terminal running the account's CLI on its own config dir, where the user signs it in.
    pub async fn sign_in_agent_account(&self, user_id: &str, id: &str) -> Result<(), AgentError> {
        let row = self
            .registry()
            .repo_handle()
            .get_for_user(user_id, id)
            .await
            .map_err(|e| AgentError::internal(format!("repo.get_for_user: {e}")))?
            .ok_or_else(|| AgentError::not_found(format!("Agent '{id}' not found")))?;
        let info = parse_source_info(row.agent_source_info.as_deref());
        let env_key = ACCOUNT_CONFIG_DIR_ENV
            .iter()
            .find(|(backend, _)| row.backend.as_deref() == Some(*backend))
            .map(|(_, key)| *key);
        let (Some(_), Some(dir), Some(env_key)) = (info.account_of, info.account_dir, env_key) else {
            return Err(AgentError::bad_request(format!(
                "Agent '{id}' is not an engine account"
            )));
        };
        // Only a dir this service made: the terminal runs a CLI there.
        let dir = std::path::PathBuf::from(dir);
        if !dir.starts_with(self.data_dir().join(ACCOUNTS_DIR)) {
            return Err(AgentError::forbidden(
                "The account's folder is outside the app's accounts folder",
            ));
        }
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| AgentError::internal(format!("create account dir: {e}")))?;
        open_sign_in_terminal(env_key, &dir).await.map_err(|e| {
            warn!(agent_id = %id, error = %e, "engine account sign-in terminal failed");
            if e.kind() == std::io::ErrorKind::Unsupported {
                AgentError::bad_request(e.to_string())
            } else {
                AgentError::internal(format!("open terminal: {e}"))
            }
        })?;
        info!(agent_id = %id, "engine account sign-in terminal opened");
        Ok(())
    }

    /// Removes an account row. Its config dir (and the login in it) is left on disk.
    pub async fn delete_agent_account(&self, user_id: &str, id: &str) -> Result<(), AgentError> {
        let repo = self.registry().repo_handle();
        let existing = repo
            .get_for_user(user_id, id)
            .await
            .map_err(|e| AgentError::internal(format!("repo.get_for_user: {e}")))?
            .ok_or_else(|| AgentError::not_found(format!("Agent '{id}' not found")))?;
        if parse_source_info(existing.agent_source_info.as_deref())
            .account_of
            .is_none()
        {
            return Err(AgentError::forbidden(
                "Only engine accounts can be deleted via this endpoint",
            ));
        }
        let removed = repo
            .delete_for_user(user_id, id)
            .await
            .map_err(|e| AgentError::internal(format!("repo.delete_for_user: {e}")))?;
        if !removed {
            return Err(AgentError::not_found(format!("Agent '{id}' not found")));
        }
        if let Err(err) = self.registry().reload_one(id).await {
            warn!(agent_id = %id, error = %err, "registry reload failed after delete_agent_account");
        }
        info!(agent_id = %id, "engine account deleted");
        Ok(())
    }
}
