// SPDX-License-Identifier: MIT
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod client;
mod config;
mod health;
mod model;
mod notify;
mod tray;
mod window;

use client::{Client, PollOutcome};
use health::{Engine, EngineOutput, Observation, TrayState};
use model::{format_duration, Snapshot};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

// A tray-first app that fails to start fails invisibly: no window appears, and
// on Windows there is not even a console for a panic to land in. SUKARFLEET_TRAY_TRACE=1
// prints one line per startup stage to stderr, so "it runs and nothing happens"
// becomes "it stopped between these two lines".
fn trace(stage: &str) {
    if std::env::var_os("SUKARFLEET_TRAY_TRACE").is_some() {
        eprintln!("sukarfleet-tray: {stage}");
    }
}

pub struct Shared {
    pub endpoint: String,
    pub summary: Mutex<String>,
    pub last_model: Mutex<Option<tray::MenuModel>>,
    pub refresh: tokio::sync::Notify,
}

#[tauri::command]
fn snapshot(state: tauri::State<'_, Arc<Shared>>) -> Option<tray::MenuModel> {
    state.last_model.lock().ok().and_then(|m| m.clone())
}

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const DOWN_BACKOFF_SECS: [u64; 6] = [1, 2, 4, 8, 16, 30];

fn main() {
    trace("main");
    let endpoint = config::endpoint();
    trace("endpoint resolved");
    let shared = Arc::new(Shared {
        endpoint,
        summary: Mutex::new(String::new()),
        last_model: Mutex::new(None),
        refresh: tokio::sync::Notify::new(),
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![snapshot, api::api_call])
        .manage(shared.clone())
        .setup(move |app| {
            trace("setup");
            tray::init(app.handle())?;
            trace("tray created");
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { poll_loop(handle, shared).await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building sukarfleet-tray");
    trace("built");

    app.run(|_app, event| {
        // Tray-only app: closing the popover must not exit; only app.exit() (Quit) does.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

async fn poll_loop(app: AppHandle, shared: Arc<Shared>) {
    let client = Client::new(shared.endpoint.clone());
    let mut engine = Engine::new(POLL_INTERVAL);
    let mut notifier = notify::Notifier::load(config::state_dir());
    let mut last_hash: u64 = 0;
    let mut down_streak: usize = 0;
    let mut last_up_wall: Option<SystemTime> = None;

    trace("poll loop");
    loop {
        let outcome = client.poll().await;
        let now = Instant::now();
        let wall = SystemTime::now();

        let (obs, snap) = match outcome {
            PollOutcome::Up(s) => {
                down_streak = 0;
                last_up_wall = Some(wall);
                let faults = s.faults();
                (
                    Observation::Up {
                        setup_complete: s.setup_complete(),
                        has_critical: faults.iter().any(|f| f.urgency == "critical"),
                        has_any_fault: !faults.is_empty(),
                        uptime_sec: s.uptime_sec(),
                    },
                    Some(s),
                )
            }
            PollOutcome::Down => {
                down_streak += 1;
                (Observation::Failure, None)
            }
        };

        let out = engine.observe(&obs, now, wall);
        let m = build_menu_model(&snap, &out, &shared.endpoint, last_up_wall, wall);
        if let Ok(mut s) = shared.summary.lock() {
            *s = m.summary.clone();
        }

        let mut hasher = DefaultHasher::new();
        m.hash(&mut hasher);
        let h = hasher.finish();
        if h != last_hash {
            last_hash = h;
            let app2 = app.clone();
            let m2 = m.clone();
            let _ = app.run_on_main_thread(move || tray::apply(&app2, &m2));
        }
        let _ = app.emit("state", &m);
        if let Ok(mut lm) = shared.last_model.lock() {
            *lm = Some(m);
        }

        let faults = snap.as_ref().map(|s| s.faults()).unwrap_or_default();
        notifier.tick(&app, &faults, out.suppress_notifications);

        let popover_open = app
            .get_webview_window(window::CONSOLE)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        let delay = if down_streak > 0 {
            Duration::from_secs(DOWN_BACKOFF_SECS[(down_streak - 1).min(DOWN_BACKOFF_SECS.len() - 1)])
        } else if popover_open {
            Duration::from_secs(3)
        } else {
            POLL_INTERVAL
        };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shared.refresh.notified() => {}
        }
    }
}

fn build_menu_model(
    snap: &Option<Snapshot>,
    out: &EngineOutput,
    endpoint: &str,
    last_up_wall: Option<SystemTime>,
    wall: SystemTime,
) -> tray::MenuModel {
    let console_url = format!("{endpoint}/ui");
    let state_key = tray::state_key(out.displayed);

    let Some(snap) = snap else {
        let ago = last_up_wall
            .and_then(|t| wall.duration_since(t).ok())
            .map(|d| format_duration(Some(d.as_millis() as i64)))
            .unwrap_or_else(|| "never".into());
        let header = if out.displayed == TrayState::Unknown {
            "sukarfleet — connecting…".to_string()
        } else {
            format!("sukarfleet — daemon not responding · last seen {ago}")
        };
        let summary = format!("{header}\nendpoint: {endpoint}");
        return tray::MenuModel {
            state_key,
            header,
            faults: vec![],
            peers: vec![],
            repos: vec![],
            unreachable: out.displayed == TrayState::Unreachable,
            console_url,
            summary,
        };
    };

    let now_ms = snap.now_ms();
    let age = |ms: Option<i64>| format_duration(ms.map(|v| now_ms.saturating_sub(v)));

    let (machine, role) = snap
        .ui
        .as_ref()
        .map(|u| (u.self_info.machine.clone(), u.self_info.role.clone()))
        .or_else(|| {
            snap.status
                .as_ref()
                .map(|s| (s.self_info.machine.clone(), s.self_info.role.clone()))
        })
        .unwrap_or_default();

    let mut header = format!("sukarfleet — {machine} · {role}");
    if out.in_grace {
        header.push_str(" · resuming…");
    }
    if snap.ui.is_none() {
        header.push_str(" · reduced view (web GUI disabled)");
    }

    let faults: Vec<String> = snap
        .faults()
        .iter()
        .map(|f| {
            let glyph = if f.urgency == "critical" { "⛔" } else { "⚠" };
            format!("{glyph} {} — {}", f.message, age(Some(f.first_seen_ms)))
        })
        .collect();

    let peers: Vec<String> = if let Some(ui) = &snap.ui {
        ui.peers
            .iter()
            .map(|p| {
                let mut line = if p.online {
                    format!("● {} — online · seen {} ago", p.name, age(p.last_seen_ms))
                } else {
                    format!("○ {} — offline · last seen {} ago", p.name, age(p.last_seen_ms))
                };
                if p.sync_stale {
                    line.push_str(" · sync stale");
                }
                if !p.paired {
                    line.push_str(" · unpaired");
                }
                line
            })
            .collect()
    } else if let Some(st) = &snap.status {
        st.peers
            .iter()
            .map(|p| {
                let glyph = if p.online { "●" } else { "○" };
                format!("{glyph} {} — seen {} ago", p.name, age(p.last_seen_ms))
            })
            .collect()
    } else {
        vec![]
    };

    let push_ms = snap
        .status
        .as_ref()
        .map(|s| s.self_info.github_push_ok_ms.clone())
        .unwrap_or_default();
    let repos: Vec<String> = if let Some(ui) = &snap.ui {
        ui.repos
            .iter()
            .map(|r| {
                if let Some(err) = &r.sync_error {
                    let short: String = err.chars().take(60).collect();
                    return format!("⛔ {} — {}", r.name, short);
                }
                let mut line = format!("● {} — sync {}", r.name, age(r.last_sync_ok_ms));
                if let Some(Some(p)) = push_ms.get(&r.name) {
                    line.push_str(&format!(" · push {}", age(Some(*p))));
                }
                if let Some(c) = &r.last_commit {
                    line.push_str(&format!(" · {}", &c[..c.len().min(7)]));
                }
                line
            })
            .collect()
    } else {
        vec![]
    };

    let mut summary = format!("{header}\n");
    if faults.is_empty() {
        summary.push_str("all green\n");
    } else {
        for f in &faults {
            summary.push_str(f);
            summary.push('\n');
        }
    }
    for p in &peers {
        summary.push_str(p);
        summary.push('\n');
    }
    for r in &repos {
        summary.push_str(r);
        summary.push('\n');
    }

    tray::MenuModel {
        state_key,
        header,
        faults,
        peers,
        repos,
        unreachable: false,
        console_url,
        summary,
    }
}
