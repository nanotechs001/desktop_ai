-- OAuth clients registered with an MCP server's authorization server through
-- Dynamic Client Registration (RFC 7591).
--
-- One row per (user, MCP server URL). `issuer` and `redirect_uri` record what
-- the registration was made for, so the app re-registers when either changes.
-- Servers without a registration endpoint have no row and use the default
-- public client id.
CREATE TABLE IF NOT EXISTS oauth_clients (
    user_id       TEXT NOT NULL REFERENCES users(id),
    server_url    TEXT NOT NULL,
    issuer        TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    client_secret TEXT,
    redirect_uri  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, server_url)
);
