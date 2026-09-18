// SPDX-License-Identifier: MIT
//! Loopback HTTP client for the daemon. Read-only by contract: GET only, v1.
//! The webview never talks to the daemon (no CORS there), so all HTTP lives here.

use crate::model::{Snapshot, Status, UiState};
use std::path::PathBuf;
use std::time::Duration;

pub struct Client {
    base: String,
    /// Set on a machine-wide install: the daemon gates /api/ui/* behind a
    /// bearer token kept in this file.
    token_file: Option<PathBuf>,
    http: reqwest::Client,
}

#[derive(Debug)]
pub enum PollOutcome {
    /// Daemon answered (full or /status-only reduced view).
    Up(Snapshot),
    /// Daemon unreachable / timed out.
    Down,
    /// The daemon may well be up, but this tray cannot present a token it can
    /// use. Carries the sentence to show, because "not responding" would send
    /// an operator to restart a healthy node.
    Blocked(String),
}

impl Client {
    pub fn new(base: String, token_file: Option<PathBuf>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("http client");
        Self { base, token_file, http }
    }

    pub async fn poll(&self) -> PollOutcome {
        let token = match &self.token_file {
            Some(p) => match crate::config::read_token(p) {
                Ok(t) => Some(t),
                Err(e) => return PollOutcome::Blocked(e),
            },
            None => None,
        };
        let ui_url = format!("{}/api/ui/state", self.base);
        let status_url = format!("{}/status", self.base);
        let (ui_res, status_res) = tokio::join!(
            bearer(self.http.get(&ui_url), token.as_deref()).send(),
            bearer(self.http.get(&status_url), token.as_deref()).send()
        );

        let ui: Option<UiState> = match ui_res {
            Ok(r) if r.status().is_success() => r.json().await.ok(),
            // The node is gated and this token is not the one it holds. Saying
            // so beats a reduced view that looks like a disabled web GUI.
            Ok(r) if r.status().as_u16() == 401 => {
                return PollOutcome::Blocked("the node refused this console token".into())
            }
            // 404 = admin.uiEnabled:false -> reduced /status-only view, not "down".
            Ok(_) => None,
            Err(_) => None,
        };
        let status: Option<Status> = match status_res {
            Ok(r) if r.status().is_success() => r.json().await.ok(),
            _ => None,
        };

        if ui.is_none() && status.is_none() {
            return PollOutcome::Down;
        }
        if let Some(u) = &ui {
            if u.v != 1 {
                // Contract discipline mirrors the daemon's own: refuse an unknown major.
                eprintln!("sukarfleet-tray: unsupported UiState v={} - update the tray app", u.v);
                return PollOutcome::Down;
            }
        }
        PollOutcome::Up(Snapshot { ui, status })
    }
}

fn bearer(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(t) => req.bearer_auth(t),
        None => req,
    }
}

#[cfg(test)]
mod tests {
    use super::bearer;

    // The regression this guards: the header going on one of the two HTTP
    // paths and not the other. Both call this helper.
    #[test]
    fn bearer_header_rides_only_when_a_token_was_read() {
        let http = reqwest::Client::new();
        let with = bearer(http.get("http://127.0.0.1:7710/api/ui/state"), Some("a-token"))
            .build()
            .expect("request");
        assert_eq!(with.headers().get("authorization").unwrap(), "Bearer a-token");

        let without = bearer(http.get("http://127.0.0.1:7710/status"), None).build().expect("request");
        assert!(without.headers().get("authorization").is_none());
    }
}
