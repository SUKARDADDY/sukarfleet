// SPDX-License-Identifier: MIT
//! Loopback HTTP client for the daemon. Read-only by contract: GET only, v1.
//! The webview never talks to the daemon (no CORS there) — all HTTP lives here.

use crate::model::{Snapshot, Status, UiState};
use std::time::Duration;

pub struct Client {
    base: String,
    http: reqwest::Client,
}

#[derive(Debug)]
pub enum PollOutcome {
    /// Daemon answered (full or /status-only reduced view).
    Up(Snapshot),
    /// Daemon unreachable / timed out.
    Down,
}

impl Client {
    pub fn new(base: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("http client");
        Self { base, http }
    }

    pub async fn poll(&self) -> PollOutcome {
        let ui_url = format!("{}/api/ui/state", self.base);
        let status_url = format!("{}/status", self.base);
        let (ui_res, status_res) =
            tokio::join!(self.http.get(&ui_url).send(), self.http.get(&status_url).send());

        let ui: Option<UiState> = match ui_res {
            Ok(r) if r.status().is_success() => r.json().await.ok(),
            // 404 = admin.uiEnabled:false → reduced /status-only view, not "down".
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
                eprintln!("sukarfleet-tray: unsupported UiState v={} — update the tray app", u.v);
                return PollOutcome::Down;
            }
        }
        PollOutcome::Up(Snapshot { ui, status })
    }
}
