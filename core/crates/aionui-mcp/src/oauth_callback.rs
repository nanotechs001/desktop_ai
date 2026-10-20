//! Loopback OAuth redirect server. It accepts one browser redirect, hands the
//! authorization code to the login flow, and answers the browser only after
//! the login flow reports how the token exchange went.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tracing::debug;

use crate::error::McpError;

/// Longest reason shown on the browser page.
const MAX_REASON_CHARS: usize = 200;

/// The redirect's code and state, plus the channel the login flow answers on
/// once the exchange finished (`Err` carries a short, user-safe reason).
pub(crate) struct CallbackCode {
    pub code: String,
    pub state: String,
    pub outcome: oneshot::Sender<Result<(), String>>,
}

/// Bind the loopback callback server, preferring the port the stored client
/// was registered with so its exact redirect URI still matches.
pub(crate) async fn bind_callback_listener(preferred_port: Option<u16>) -> Result<TcpListener, McpError> {
    if let Some(port) = preferred_port {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => debug!(port, error = %e, "Registered callback port unavailable; using a new one"),
        }
    }
    TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| McpError::OAuth(format!("Failed to bind callback server: {e}")))
}

/// Serve one redirect: send the code on `code_tx`, keep the browser connection
/// open until the outcome arrives (at most `outcome_timeout`), then reply.
pub(crate) async fn serve_one_callback(
    listener: TcpListener,
    server_host: String,
    outcome_timeout: Duration,
    code_tx: oneshot::Sender<Result<CallbackCode, McpError>>,
) {
    let mut stream = match listener.accept().await {
        Ok((stream, _)) => stream,
        Err(e) => {
            let _ = code_tx.send(Err(McpError::OAuth(format!("Failed to accept connection: {e}"))));
            return;
        }
    };
    drop(listener);

    let (code, state) = match read_callback(&mut stream).await {
        Ok(callback) => callback,
        Err(e) => {
            write_page(&mut stream, &failure_page(&short_reason(&e))).await;
            let _ = code_tx.send(Err(e));
            return;
        }
    };

    let (outcome_tx, outcome_rx) = oneshot::channel();
    let callback = CallbackCode {
        code,
        state,
        outcome: outcome_tx,
    };
    if code_tx.send(Ok(callback)).is_err() {
        write_page(&mut stream, &failure_page("this sign-in is no longer active")).await;
        return;
    }

    let page = match tokio::time::timeout(outcome_timeout, outcome_rx).await {
        Ok(Ok(Ok(()))) => success_page(&server_host),
        Ok(Ok(Err(reason))) => failure_page(&reason),
        Ok(Err(_)) => failure_page("sign-in was interrupted"),
        Err(_) => still_finishing_page(),
    };
    write_page(&mut stream, &page).await;
}

async fn read_callback(stream: &mut TcpStream) -> Result<(String, String), McpError> {
    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| McpError::OAuth(format!("Failed to read request: {e}")))?;
    parse_callback_query(&String::from_utf8_lossy(&buf[..n]))
}

async fn write_page(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    if let Err(e) = stream.write_all(response.as_bytes()).await {
        debug!(error = %e, "Could not answer the OAuth callback browser request");
    }
}

/// Short, user-safe reason for a failed sign-in.
pub(crate) fn short_reason(err: &McpError) -> String {
    let message = match err {
        McpError::OAuth(message) => message.clone(),
        other => other.to_string(),
    };
    let trimmed = message.trim().trim_end_matches('.');
    match trimmed.char_indices().nth(MAX_REASON_CHARS) {
        Some((cut, _)) => format!("{}…", &trimmed[..cut]),
        None => trimmed.to_string(),
    }
}

fn success_page(server_host: &str) -> String {
    page(
        "Signed in",
        &format!(
            "Signed in to {}. You can close this tab and return to Pixebot Browser.",
            escape_html(server_host)
        ),
    )
}

fn failure_page(reason: &str) -> String {
    page(
        "Sign-in failed",
        &format!(
            "Sign-in failed: {}. Return to Pixebot Browser and try again.",
            escape_html(reason)
        ),
    )
}

fn still_finishing_page() -> String {
    page(
        "Still signing in",
        "Sign-in is taking longer than expected. Return to Pixebot Browser to see whether it finished.",
    )
}

/// `message` must already be HTML-escaped.
fn page(title: &str, message: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body><h1>{title}</h1><p>{message}</p></body></html>"
    )
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

/// Parse `code` and `state` from the first line of an HTTP request.
///
/// Expects: `GET /callback?code=xxx&state=yyy HTTP/1.1`
fn parse_callback_query(request: &str) -> Result<(String, String), McpError> {
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| McpError::OAuth("Empty HTTP request".to_string()))?;

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| McpError::OAuth("Malformed HTTP request line".to_string()))?;

    let query_str = path
        .split_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| McpError::OAuth("No query parameters in callback".to_string()))?;

    let mut code = None;
    let mut state = None;

    for pair in query_str.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "code" => code = Some(url_decode(value)),
                "state" => state = Some(url_decode(value)),
                _ => {}
            }
        }
    }

    let code = code
        .filter(|c| !c.is_empty())
        .ok_or_else(|| McpError::OAuth("Missing 'code' in callback".to_string()))?;
    let state = state
        .filter(|s| !s.is_empty())
        .ok_or_else(|| McpError::OAuth("Missing 'state' in callback".to_string()))?;

    Ok((code, state))
}

/// Minimal percent-decoding for query parameter values.
fn url_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.bytes();

    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(h), Some(l)) = (hi, lo) {
                let hex = [h, l];
                if let Ok(s) = std::str::from_utf8(&hex)
                    && let Ok(byte) = u8::from_str_radix(s, 16)
                {
                    result.push(byte as char);
                    continue;
                }
                // Malformed percent-encoding: keep as-is.
                result.push('%');
                result.push(h as char);
                result.push(l as char);
            }
        } else if b == b'+' {
            result.push(' ');
        } else {
            result.push(b as char);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- pages ---------------------------------------------------------------

    #[test]
    fn pages_escape_the_host_and_reason() {
        let success = success_page("<script>alert(1)</script>");
        assert!(success.contains("Signed in to &lt;script&gt;alert(1)&lt;/script&gt;."));
        assert!(!success.contains("<script>"));

        let failure = failure_page("bad \"value\" & <b>");
        assert!(failure.contains("Sign-in failed: bad &quot;value&quot; &amp; &lt;b&gt;. Return to Pixebot Browser"));
        assert!(!failure.contains("<b>"));
    }

    #[test]
    fn short_reason_drops_trailing_period_and_caps_length() {
        assert_eq!(
            short_reason(&McpError::OAuth("Token exchange failed: invalid_grant.".to_string())),
            "Token exchange failed: invalid_grant"
        );
        let long = short_reason(&McpError::OAuth("x".repeat(500)));
        assert_eq!(long.chars().count(), MAX_REASON_CHARS + 1);
        assert!(long.ends_with('…'));
    }

    #[tokio::test]
    async fn malformed_redirect_gets_the_failure_page_and_reports_the_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (code_tx, code_rx) = oneshot::channel();
        let server = tokio::spawn(serve_one_callback(
            listener,
            "mcp.example.com".to_string(),
            Duration::from_secs(5),
            code_tx,
        ));

        let page = reqwest::get(format!("http://127.0.0.1:{port}/callback?state=s"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();

        assert!(
            page.contains("Sign-in failed: Missing &#39;code&#39; in callback."),
            "{page}"
        );
        let err = code_rx.await.unwrap().err().unwrap();
        assert!(err.to_string().contains("Missing 'code'"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn slow_outcome_gets_the_still_finishing_page() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (code_tx, code_rx) = oneshot::channel();
        tokio::spawn(serve_one_callback(
            listener,
            "mcp.example.com".to_string(),
            Duration::from_millis(100),
            code_tx,
        ));

        let browser = tokio::spawn(async move {
            reqwest::get(format!("http://127.0.0.1:{port}/callback?code=c&state=s"))
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        // Hold the outcome sender without answering.
        let _callback = code_rx.await.unwrap().unwrap();
        let page = browser.await.unwrap();

        assert!(page.contains("Sign-in is taking longer than expected"), "{page}");
        assert!(!page.contains("Signed in to"), "{page}");
    }

    // -- parse_callback_query ------------------------------------------------

    #[test]
    fn parse_valid_callback_query() {
        let request = "GET /callback?code=abc123&state=xyz789 HTTP/1.1\r\nHost: localhost\r\n";
        let (code, state) = parse_callback_query(request).unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
    }

    #[test]
    fn parse_callback_query_reversed_params() {
        let request = "GET /callback?state=s1&code=c1 HTTP/1.1\r\n";
        let (code, state) = parse_callback_query(request).unwrap();
        assert_eq!(code, "c1");
        assert_eq!(state, "s1");
    }

    #[test]
    fn parse_callback_query_with_extra_params() {
        let request = "GET /callback?code=c&foo=bar&state=s HTTP/1.1\r\n";
        let (code, state) = parse_callback_query(request).unwrap();
        assert_eq!(code, "c");
        assert_eq!(state, "s");
    }

    #[test]
    fn parse_callback_query_missing_code() {
        let request = "GET /callback?state=s HTTP/1.1\r\n";
        let err = parse_callback_query(request).unwrap_err();
        assert!(err.to_string().contains("Missing 'code'"));
    }

    #[test]
    fn parse_callback_query_missing_state() {
        let request = "GET /callback?code=c HTTP/1.1\r\n";
        let err = parse_callback_query(request).unwrap_err();
        assert!(err.to_string().contains("Missing 'state'"));
    }

    #[test]
    fn parse_callback_query_rejects_empty_values() {
        let err = parse_callback_query("GET /callback?code=&state=s HTTP/1.1\r\n").unwrap_err();
        assert!(err.to_string().contains("Missing 'code'"));
        let err = parse_callback_query("GET /callback?code=c&state= HTTP/1.1\r\n").unwrap_err();
        assert!(err.to_string().contains("Missing 'state'"));
    }

    #[test]
    fn parse_callback_query_no_query_string() {
        let request = "GET /callback HTTP/1.1\r\n";
        let err = parse_callback_query(request).unwrap_err();
        assert!(err.to_string().contains("No query parameters"));
    }

    #[test]
    fn parse_callback_query_empty_request() {
        let err = parse_callback_query("").unwrap_err();
        assert!(err.to_string().contains("Empty HTTP request"));
    }

    // -- url_decode ----------------------------------------------------------

    #[test]
    fn url_decode_no_encoding() {
        assert_eq!(url_decode("hello"), "hello");
    }

    #[test]
    fn url_decode_percent_encoded() {
        assert_eq!(url_decode("hello%20world"), "hello world");
    }

    #[test]
    fn url_decode_plus_sign() {
        assert_eq!(url_decode("hello+world"), "hello world");
    }

    #[test]
    fn url_decode_special_characters() {
        assert_eq!(url_decode("%3D%26%3F"), "=&?");
    }

    #[test]
    fn url_decode_mixed() {
        assert_eq!(url_decode("a%20b+c%3Dd"), "a b c=d");
    }
}
