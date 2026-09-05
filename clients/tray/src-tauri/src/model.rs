// SPDX-License-Identifier: MIT
//! Rust mirror of the daemon's UiState / status wire shapes (sukarfleet src/types.ts).
//! Every field is defaulted so an additive daemon change never breaks deserialization.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiState {
    pub v: u64,
    pub now_ms: i64,
    #[serde(rename = "self")]
    pub self_info: UiSelf,
    pub peers: Vec<UiPeer>,
    pub repos: Vec<UiRepo>,
    pub faults: Vec<UiFault>,
    pub admin: UiAdmin,
    pub setup: UiSetup,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSelf {
    pub machine: String,
    pub role: String,
    pub mesh_ip: String,
    pub node_port: u16,
    pub uptime_sec: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiPeer {
    pub name: String,
    pub mesh_ip: String,
    pub node_port: u16,
    pub online: bool,
    pub last_seen_ms: Option<i64>,
    pub sync_stale: bool,
    pub paired: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiRepo {
    pub name: String,
    pub path: String,
    pub last_sync_ok_ms: Option<i64>,
    pub last_commit: Option<String>,
    pub sync_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiFault {
    pub key: String,
    pub fault_class: String,
    pub message: String,
    pub urgency: String,
    pub first_seen_ms: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiAdmin {
    pub ui_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSetup {
    pub complete: bool,
}

impl Default for UiSetup {
    // A missing/partial setup block must not fake the setup takeover state.
    fn default() -> Self {
        Self { complete: true }
    }
}

// --- GET /status (reduced fallback source + enrichment) ---

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Status {
    pub now_ms: i64,
    #[serde(rename = "self")]
    pub self_info: StatusSelf,
    pub peers: Vec<StatusPeer>,
    pub health: HealthSnap,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusSelf {
    pub machine: String,
    pub role: String,
    pub clock_vetted: bool,
    pub repos: HashMap<String, RepoStat>,
    pub github_push_ok_ms: HashMap<String, Option<i64>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoStat {
    pub last_sync_ok_ms: Option<i64>,
    pub last_commit: Option<String>,
    pub sync_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusPeer {
    pub name: String,
    pub last_seen_ms: Option<i64>,
    pub online: bool,
    pub sync_stale: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthSnap {
    pub faults: Vec<FaultSnap>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FaultSnap {
    pub key: String,
    pub fault_class: String,
    pub message: String,
    pub urgency: String,
    pub first_seen_ms: i64,
}

/// One poll's combined result. `ui` is None when /api/ui/state 404s
/// (admin.uiEnabled=false) and only the /status reduced view is available.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub ui: Option<UiState>,
    pub status: Option<Status>,
}

impl Snapshot {
    pub fn faults(&self) -> Vec<UiFault> {
        if let Some(ui) = &self.ui {
            return ui.faults.clone();
        }
        if let Some(st) = &self.status {
            return st
                .health
                .faults
                .iter()
                .map(|f| UiFault {
                    key: f.key.clone(),
                    fault_class: f.fault_class.clone(),
                    message: f.message.clone(),
                    urgency: f.urgency.clone(),
                    first_seen_ms: f.first_seen_ms,
                })
                .collect();
        }
        Vec::new()
    }

    pub fn setup_complete(&self) -> bool {
        self.ui.as_ref().map(|u| u.setup.complete).unwrap_or(true)
    }

    pub fn uptime_sec(&self) -> Option<f64> {
        self.ui.as_ref().map(|u| u.self_info.uptime_sec)
    }

    pub fn now_ms(&self) -> i64 {
        self.ui
            .as_ref()
            .map(|u| u.now_ms)
            .or_else(|| self.status.as_ref().map(|s| s.now_ms))
            .unwrap_or(0)
    }
}

/// Exact port of health.ts formatDuration: "47m", "1h5m", "2d3h"; "unknown" for unbounded.
pub fn format_duration(ms: Option<i64>) -> String {
    let Some(ms) = ms else { return "unknown".into() };
    let total_min = (ms / 60_000).max(0);
    if total_min < 60 {
        return format!("{total_min}m");
    }
    let total_hours = total_min / 60;
    let rem_min = total_min % 60;
    if total_hours < 24 {
        return if rem_min > 0 {
            format!("{total_hours}h{rem_min}m")
        } else {
            format!("{total_hours}h")
        };
    }
    let days = total_hours / 24;
    let rem_hours = total_hours % 24;
    if rem_hours > 0 {
        format!("{days}d{rem_hours}h")
    } else {
        format!("{days}d")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_fixture_deserializes() {
        // SYNTHETIC fixture — never a live capture (daemon repo's personal-data guard).
        let raw = include_str!("../tests/fixtures/ui-state-golden.json");
        let ui: UiState = serde_json::from_str(raw).expect("golden UiState");
        assert_eq!(ui.v, 1);
        assert_eq!(ui.self_info.machine, "alpha");
        assert_eq!(ui.peers.len(), 1);
        assert_eq!(ui.faults.len(), 1);
        assert_eq!(ui.faults[0].urgency, "critical");
        assert!(ui.setup.complete);
    }

    #[test]
    fn unknown_fields_and_missing_blocks_tolerated() {
        let ui: UiState = serde_json::from_str(r#"{"v":1,"futureField":{"x":1}}"#).unwrap();
        assert_eq!(ui.v, 1);
        assert!(ui.setup.complete, "missing setup must not fake the setup screen");
    }

    #[test]
    fn format_duration_matches_daemon() {
        assert_eq!(format_duration(Some(47 * 60_000)), "47m");
        assert_eq!(format_duration(Some(65 * 60_000)), "1h5m");
        assert_eq!(format_duration(Some(60 * 60_000)), "1h");
        assert_eq!(format_duration(Some((51 * 60) * 60_000)), "2d3h");
        assert_eq!(format_duration(Some((48 * 60) * 60_000)), "2d");
        assert_eq!(format_duration(Some(30_000)), "0m");
        assert_eq!(format_duration(None), "unknown");
    }
}
