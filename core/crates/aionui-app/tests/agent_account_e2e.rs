//! E2E tests for engine accounts: a second login of the claude CLI as its own
//! engine row (`POST /api/agents/{id}/accounts`, `DELETE /api/agents/accounts/{id}`).
//!
//! An account row is a copy of the built-in claude row whose spawn env points
//! `CLAUDE_CONFIG_DIR` at its own folder under the data dir, so it keeps its
//! own login (verified: claude.exe 2.1.301 reads `.credentials.json` from
//! `CLAUDE_CONFIG_DIR ?? ~/.claude`).

mod common;

use axum::http::StatusCode;
use serde_json::{Value, json};
use tower::ServiceExt;

use aionui_app::{AppConfig, AppServices, create_router};
use common::{body_json, get_with_token, json_with_token, setup_and_login};

/// Seeded built-in claude row (`030_user_scope.sql`).
const CLAUDE_ID: &str = "2d23ff1c";
/// Seeded built-in opencode row: an engine without a verified per-account dir.
const OPENCODE_ID: &str = "53861a53";

async fn build_app_in(data_dir: &std::path::Path) -> (axum::Router, AppServices) {
    let db = aionui_db::init_database_memory().await.unwrap();
    let config = AppConfig {
        data_dir: data_dir.to_path_buf(),
        ..AppConfig::default()
    };
    let services = AppServices::from_config(db, &config).await.unwrap();
    let router = create_router(&services).await.expect("build router");
    (router, services)
}

async fn send(app: &axum::Router, req: axum::http::Request<axum::body::Body>) -> (StatusCode, Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

async fn add_account(app: &axum::Router, token: &str, csrf: &str, base: &str, label: &str) -> (StatusCode, Value) {
    let uri = format!("/api/agents/{base}/accounts");
    send(
        app,
        json_with_token("POST", &uri, json!({ "label": label }), token, csrf),
    )
    .await
}

async fn management_ids(app: &axum::Router, token: &str) -> Vec<String> {
    let (_, json) = send(app, get_with_token("/api/agents/management", token)).await;
    json["data"]
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn account_is_a_claude_engine_with_its_own_config_dir_until_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let (mut app, services) = build_app_in(dir.path()).await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;

    let (status, json) = add_account(&app, &token, &csrf, CLAUDE_ID, "Work").await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let account = &json["data"];
    let id = account["id"].as_str().expect("id").to_owned();
    assert_ne!(id, CLAUDE_ID);
    assert_eq!(account["backend"], "claude");
    assert_eq!(account["agent_source"], "builtin");
    assert_eq!(account["agent_source_info"]["account_of"], CLAUDE_ID);
    assert!(account["name"].as_str().unwrap().ends_with("· Work"), "{account}");
    let config_dir = dir.path().join("accounts").join(&id);
    let env = account["env"].as_array().expect("env");
    assert!(
        env.iter()
            .any(|e| e["name"] == "CLAUDE_CONFIG_DIR" && e["value"] == config_dir.to_string_lossy().as_ref()),
        "{env:?}"
    );
    assert!(config_dir.is_dir(), "the account's config dir is created");
    // The management view never shows env (it can hold secrets), so the dir is also named in source info.
    assert_eq!(
        account["agent_source_info"]["account_dir"],
        config_dir.to_string_lossy().as_ref()
    );
    let ids = management_ids(&app, &token).await;
    assert!(ids.contains(&id) && ids.contains(&CLAUDE_ID.to_owned()));

    let uri = format!("/api/agents/accounts/{id}");
    let (status, json) = send(&app, json_with_token("DELETE", &uri, json!(null), &token, &csrf)).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    let ids = management_ids(&app, &token).await;
    assert!(!ids.contains(&id), "a deleted account leaves the engine list");
    assert!(ids.contains(&CLAUDE_ID.to_owned()), "the built-in row stays");
}

#[tokio::test]
async fn account_creation_rejects_bad_input() {
    let dir = tempfile::tempdir().unwrap();
    let (mut app, services) = build_app_in(dir.path()).await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;

    let (status, json) = add_account(&app, &token, &csrf, CLAUDE_ID, "   ").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{json}");
    assert!(json.to_string().contains("label"), "{json}");

    let (status, json) = add_account(&app, &token, &csrf, OPENCODE_ID, "Work").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{json}");
    assert!(json.to_string().contains("accounts"), "{json}");

    let (status, _) = add_account(&app, &token, &csrf, "no-such-agent", "Work").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // An account is not a base for another account.
    let (_, created) = add_account(&app, &token, &csrf, CLAUDE_ID, "Work").await;
    let account_id = created["data"]["id"].as_str().unwrap().to_owned();
    let (status, _) = add_account(&app, &token, &csrf, &account_id, "Nested").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn only_account_rows_can_be_deleted_as_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let (mut app, services) = build_app_in(dir.path()).await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;

    let uri = format!("/api/agents/accounts/{CLAUDE_ID}");
    let (status, _) = send(&app, json_with_token("DELETE", &uri, json!(null), &token, &csrf)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(management_ids(&app, &token).await.contains(&CLAUDE_ID.to_owned()));

    let (status, _) = send(
        &app,
        json_with_token(
            "DELETE",
            "/api/agents/accounts/no-such-agent",
            json!(null),
            &token,
            &csrf,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn account_endpoints_require_login() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _services) = build_app_in(dir.path()).await;
    // A valid CSRF pair, so the request reaches the auth check.
    let csrf = "csrf-test";
    let request = |method: &str, uri: String, body: &'static str| {
        axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-csrf-token", csrf)
            .header("cookie", format!("aionui-csrf-token={csrf}"))
            .body(axum::body::Body::from(body))
            .unwrap()
    };
    let add = request(
        "POST",
        format!("/api/agents/{CLAUDE_ID}/accounts"),
        r#"{"label":"Work"}"#,
    );
    let (status, json) = send(&app, add).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["code"], "UNAUTHORIZED");
    let remove = request("DELETE", format!("/api/agents/accounts/{CLAUDE_ID}"), "{}");
    let (status, _) = send(&app, remove).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        !dir.path().join("accounts").exists(),
        "nothing is created without a login"
    );
}
