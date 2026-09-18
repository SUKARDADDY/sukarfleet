// SPDX-License-Identifier: MIT
//! Tray icon + menu. On Linux (SNI/AppIndicator) the tray carries no click
//! events — the menu IS the primary readout. Rebuilt only when the model hash
//! changes (rebuilding an SNI menu every tick makes GNOME blink).

use crate::health::TrayState;
use crate::Shared;
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const TRAY_ID: &str = "main";

// What the unreachable menu offers to copy. The node is a systemd user unit on
// Linux and a scheduled task on Windows, so one pair of strings for both would
// be a confidently wrong answer on one of them.
#[cfg(target_os = "windows")]
mod cmds {
    pub const START: &str = "Start-ScheduledTask -TaskName sukarfleet";
    // Machine-wide scope: the node is a WinSW service, not a logon task.
    pub const SERVICE_START: &str = "Start-Service sukarfleet-node";
    pub const SERVICE_CHECK: &str = "Get-Service sukarfleet-node";
    // The task's output goes nowhere. Windows has no journal, and the installer
    // registers `bun run src\node.ts` as the task action rather than behind a
    // shell that could redirect it, so there is no log file to tail and saying
    // otherwise would send an operator looking for one. What does exist is the
    // task's own last-run record, so that is what this offers, under a label
    // that does not promise logs.
    pub const CHECK: &str = "Get-ScheduledTaskInfo -TaskName sukarfleet";
    pub const CHECK_LABEL: &str = "Copy check command";
}
#[cfg(not(target_os = "windows"))]
mod cmds {
    pub const START: &str = "systemctl --user start sukarfleet.service";
    pub const CHECK: &str = "journalctl --user -u sukarfleet -n 200";
    pub const CHECK_LABEL: &str = "Copy log command";
    // There is no machine-wide install outside Windows yet, so a token file
    // here still means the user unit. Naming a system unit nobody installs
    // would be a confidently wrong answer.
    pub const SERVICE_START: &str = START;
    pub const SERVICE_CHECK: &str = CHECK;
}

/// Service mode is exactly "a console token file was configured": that is what
/// a machine-wide install passes and a per-user install never does.
fn service_mode(app: &AppHandle) -> bool {
    app.try_state::<Arc<Shared>>().map(|s| s.token_file.is_some()).unwrap_or(false)
}

fn start_cmd(service: bool) -> &'static str {
    if service {
        cmds::SERVICE_START
    } else {
        cmds::START
    }
}

fn check_cmd(service: bool) -> &'static str {
    if service {
        cmds::SERVICE_CHECK
    } else {
        cmds::CHECK
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq, serde::Serialize)]
pub struct MenuModel {
    pub state_key: &'static str,
    pub header: String,
    pub faults: Vec<String>,
    pub peers: Vec<String>,
    pub repos: Vec<String>,
    pub unreachable: bool,
    pub console_url: String,
    pub summary: String,
}

pub fn state_key(s: TrayState) -> &'static str {
    match s {
        TrayState::Unknown => "unknown",
        TrayState::Unreachable => "unreachable",
        TrayState::Setup => "setup",
        TrayState::Critical => "critical",
        TrayState::Degraded => "degraded",
        TrayState::Ok => "ok",
    }
}

fn icon_for(key: &str) -> Image<'static> {
    let bytes: &'static [u8] = match key {
        "ok" => include_bytes!("../icons/tray-ok-32.png"),
        "degraded" => include_bytes!("../icons/tray-degraded-32.png"),
        "critical" => include_bytes!("../icons/tray-critical-32.png"),
        "setup" => include_bytes!("../icons/tray-setup-32.png"),
        "unreachable" => include_bytes!("../icons/tray-unreachable-32.png"),
        _ => include_bytes!("../icons/tray-unknown-32.png"),
    };
    Image::from_bytes(bytes).expect("embedded tray icon")
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let model = MenuModel {
        state_key: "unknown",
        header: "sukarfleet — connecting…".into(),
        faults: vec![],
        peers: vec![],
        repos: vec![],
        unreachable: false,
        console_url: String::new(),
        summary: String::new(),
    };
    let menu = build_menu(app, &model)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_for("unknown"))
        .menu(&menu)
        // Linux SNI delivers no click events, so the menu has to open on the
        // primary click or the tray has no primary readout at all. Windows does
        // deliver them, and its convention is the other way round: left opens
        // the thing, right opens the menu. Following it costs one line, and a
        // Windows hand does it without being told.
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            // Never fires on Linux. On Windows this is the left click the line
            // above stopped handing to the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::window::show_console(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn apply(app: &AppHandle, model: &MenuModel) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_icon(Some(icon_for(model.state_key)));
    if let Ok(menu) = build_menu(app, model) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(&model.header));
}

fn build_menu(app: &AppHandle, m: &MenuModel) -> tauri::Result<Menu<Wry>> {
    let service = service_mode(app);
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "header", &m.header, false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    if m.unreachable {
        menu.append(&MenuItem::with_id(
            app,
            "copy-start",
            "Copy start command",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            "copy-logs",
            cmds::CHECK_LABEL,
            true,
            None::<&str>,
        )?)?;
    } else {
        if m.faults.is_empty() {
            menu.append(&MenuItem::with_id(app, "all-green", "All green", false, None::<&str>)?)?;
        } else {
            let sub = Submenu::with_id(app, "faults", format!("Faults ({})", m.faults.len()), true)?;
            for (i, f) in m.faults.iter().enumerate() {
                sub.append(&MenuItem::with_id(app, format!("fault-{i}"), f, false, None::<&str>)?)?;
            }
            menu.append(&sub)?;
        }
        if !m.peers.is_empty() {
            let sub = Submenu::with_id(app, "peers", "Peers", true)?;
            for (i, p) in m.peers.iter().enumerate() {
                sub.append(&MenuItem::with_id(app, format!("peer-{i}"), p, false, None::<&str>)?)?;
            }
            menu.append(&sub)?;
        }
        if !m.repos.is_empty() {
            let sub = Submenu::with_id(app, "repos", "Repos", true)?;
            for (i, r) in m.repos.iter().enumerate() {
                sub.append(&MenuItem::with_id(app, format!("repo-{i}"), r, false, None::<&str>)?)?;
            }
            menu.append(&sub)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open-window", "Open fleet console", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "copy-status", "Copy status", true, None::<&str>)?)?;
    if service {
        menu.append(&MenuItem::with_id(
            app,
            "copy-token",
            "Copy console token",
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if service {
        // The machine-wide install owns startup through an HKLM Run value that
        // carries the endpoint and the token file. A checkbox here writes an
        // HKCU value with neither, which is a second, token-less tray. So the
        // checkbox is gone and a disabled line says who owns the setting.
        menu.append(&MenuItem::with_id(
            app,
            "autostart-managed",
            "Start at login (managed by the machine-wide install)",
            false,
            None::<&str>,
        )?)?;
    } else {
        let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
        menu.append(&CheckMenuItem::with_id(
            app,
            "autostart",
            "Start at login",
            true,
            autostart_on,
            None::<&str>,
        )?)?;
    }
    menu.append(&MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    let shared = app.state::<Arc<Shared>>();
    let service = shared.token_file.is_some();
    match id {
        "quit" => app.exit(0),
        "refresh" => shared.refresh.notify_one(),
        "open-window" => crate::window::show_console(app),
        "autostart" => {
            let launcher = app.autolaunch();
            let enabled = launcher.is_enabled().unwrap_or(false);
            let res = if enabled { launcher.disable() } else { launcher.enable() };
            if let Err(e) = res {
                eprintln!("sukarfleet-tray: autostart toggle failed: {e}");
            }
        }
        "copy-status" => {
            let text = shared.summary.lock().map(|s| s.clone()).unwrap_or_default();
            let _ = app.clipboard().write_text(text);
        }
        "copy-start" => {
            let _ = app.clipboard().write_text(start_cmd(service));
        }
        "copy-logs" => {
            let _ = app.clipboard().write_text(check_cmd(service));
        }
        "copy-token" => {
            // The operator's own account may not be able to read the file (the
            // installer's default grants every local user, an icacls line can
            // narrow it), so say which it was rather than copying nothing.
            match shared.token_file.as_ref().map(|p| crate::config::read_token(p)) {
                Some(Ok(token)) => {
                    let _ = app.clipboard().write_text(token);
                }
                Some(Err(e)) => eprintln!("sukarfleet-tray: {e}"),
                None => {}
            }
        }
        _ => {}
    }
}
