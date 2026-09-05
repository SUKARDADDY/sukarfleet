//! Console window lifecycle. A normal decorated, resizable window (forms and
//! out-of-band steps must survive focus loss — e.g. copying the mesh-secret
//! sudo command into a terminal). Hidden, not destroyed, on close so reopen
//! is instant and screen state survives.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const CONSOLE: &str = "console";

pub fn show_console(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CONSOLE) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, CONSOLE, WebviewUrl::App("index.html".into()))
        .title("sukarfleet console")
        .inner_size(960.0, 680.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true);
    match builder.build() {
        Ok(win) => {
            let win2 = win.clone();
            win.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = win2.hide();
                }
            });
        }
        Err(e) => eprintln!("sukarfleet-tray: console window: {e}"),
    }
}
