//! Allowlisted passthrough bridge: the console webview's ONLY path to the
//! daemon. The webview cannot fetch 127.0.0.1 directly (no CORS on the
//! daemon), and this allowlist keeps it from becoming a generic localhost
//! proxy. A Rust client sends no Origin/Sec-Fetch-Site headers, which is the
//! daemon's documented non-browser carve-out through rejectCrossSiteBrowser.
//!
//! INVARIANT (mirrors the daemon's own): nothing on the credentials route is
//! ever logged — no path, no body, no response.

use crate::Shared;
use std::sync::Arc;
use std::time::Duration;

/// (method, exact path) pairs — query strings are stripped before matching.
const ALLOW: &[(&str, &str)] = &[
    ("GET", "/api/ui/state"),
    ("GET", "/api/ui/pair/code"),
    ("GET", "/api/ui/credentials"),
    ("GET", "/api/ui/admin/status"),
    ("GET", "/api/ui/admin/runs"),
    ("GET", "/api/ui/audit"),
    ("GET", "/api/ui/setup/network-secret"),
    ("POST", "/api/ui/setup/identity"),
    ("POST", "/api/ui/setup/network-secret"),
    ("POST", "/api/ui/pair/code"),
    ("POST", "/api/ui/pair/redeem"),
    ("POST", "/api/ui/pair/revoke"),
    ("POST", "/api/ui/credentials/sudo"),
    ("POST", "/api/ui/lane"),
    ("POST", "/api/ui/admin/run"),
    ("POST", "/api/ui/restart"),
    ("DELETE", "/api/ui/pair/code"),
    ("DELETE", "/api/ui/credentials/sudo"),
];

pub fn allowed(method: &str, path: &str) -> bool {
    let base = path.split('?').next().unwrap_or(path);
    if ALLOW.iter().any(|(m, p)| *m == method && *p == base) {
        return true;
    }
    // GET /api/ui/admin/run/{runId} — runId is base64url, daemon-validated too.
    if method == "GET" {
        if let Some(id) = base.strip_prefix("/api/ui/admin/run/") {
            return !id.is_empty()
                && id.len() <= 64
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        }
    }
    false
}

#[derive(serde::Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

fn network_error() -> ApiResponse {
    ApiResponse {
        status: 0,
        body: serde_json::json!({ "message": "The daemon did not answer." }),
    }
}

#[tauri::command]
pub async fn api_call(
    state: tauri::State<'_, Arc<Shared>>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<ApiResponse, String> {
    if !allowed(&method, &path) {
        return Err(format!("refused: {method} {path} is not an allowed console route"));
    }
    let url = format!("{}{}", state.endpoint, path);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "http client".to_string())?;
    let mut req = match method.as_str() {
        "GET" => http.get(&url),
        "POST" => http.post(&url),
        "DELETE" => http.delete(&url),
        _ => return Err("refused: unsupported method".into()),
    };
    // JSON bodies always declare application/json; bodyless requests carry no
    // Content-Type at all (a body with no CT is a 415 at the daemon).
    if let Some(b) = body {
        req = req.json(&b);
    }
    let Ok(res) = req.send().await else {
        return Ok(network_error());
    };
    let status = res.status().as_u16();
    let body = res
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    Ok(ApiResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn allowlist_exact_routes() {
        assert!(allowed("GET", "/api/ui/state"));
        assert!(allowed("POST", "/api/ui/admin/run"));
        assert!(allowed("DELETE", "/api/ui/pair/code"));
        assert!(allowed("GET", "/api/ui/admin/runs?limit=20"));
        assert!(allowed("GET", "/api/ui/audit?limit=40"));
    }

    #[test]
    fn allowlist_run_id() {
        assert!(allowed("GET", "/api/ui/admin/run/abc_DEF-123"));
        assert!(!allowed("GET", "/api/ui/admin/run/"));
        assert!(!allowed("GET", "/api/ui/admin/run/../../status"));
        assert!(!allowed("GET", &format!("/api/ui/admin/run/{}", "x".repeat(65))));
        assert!(!allowed("POST", "/api/ui/admin/run/abc"));
    }

    #[test]
    fn allowlist_refuses_everything_else() {
        assert!(!allowed("GET", "/status"));
        assert!(!allowed("GET", "/health"));
        assert!(!allowed("GET", "/exec/audit/tail"));
        assert!(!allowed("POST", "/gossip"));
        assert!(!allowed("PUT", "/api/ui/lane"));
        assert!(!allowed("POST", "/api/ui/admin/lane")); // legacy alias deliberately absent
        assert!(!allowed("GET", "/api/ui/state/../../../etc"));
        assert!(!allowed("POST", "/api/ui/state"));
    }

    #[test]
    fn query_stripping_cannot_smuggle() {
        assert!(!allowed("GET", "/exec/audit/tail?x=/api/ui/state"));
        assert!(allowed("GET", "/api/ui/state?ignored=1"));
    }
}
