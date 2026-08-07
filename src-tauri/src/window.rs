//! Popover window lifecycle. Undecorated, always-on-top, hidden (not
//! destroyed) on close/focus-loss so reopen is instant. Positioned top-right;
//! on Wayland absolute positioning may be ignored — acceptable.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const POPOVER: &str = "popover";

pub fn show_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(POPOVER) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let mut builder = WebviewWindowBuilder::new(app, POPOVER, WebviewUrl::App("index.html".into()))
        .title("sukarfleet")
        .inner_size(380.0, 520.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false);
    if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let logical_w = mon.size().width as f64 / scale;
        builder = builder.position((logical_w - 380.0 - 20.0).max(0.0), 48.0);
    }
    match builder.build() {
        Ok(win) => {
            let win2 = win.clone();
            win.on_window_event(move |e| match e {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = win2.hide();
                }
                WindowEvent::Focused(false) => {
                    let _ = win2.hide();
                }
                _ => {}
            });
        }
        Err(e) => eprintln!("sukarfleet-tray: popover: {e}"),
    }
}
