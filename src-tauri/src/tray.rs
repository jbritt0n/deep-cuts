//! System tray: show / poll now / quit. The window hides on close so the
//! poller keeps running (ING-05).

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Deep Cuts", true, None::<&str>)?;
    let poll = MenuItem::with_id(app, "poll", "Check Spotify now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &poll, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray").menu(&menu).show_menu_on_left_click(false).tooltip("Deep Cuts");
    if let Some(icon) = app.default_window_icon().cloned() { builder = builder.icon(icon); }
    builder
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "poll" => {
                let a = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let st = a.state::<crate::AppState>();
                    match crate::spotify::sync::poll_recent(&st.spotify_ref(), &st.real) {
                        Ok(n) => { use tauri::Emitter; let _ = a.emit("data:changed", serde_json::json!({ "reason": "poll", "added": n })); }
                        Err(e) => st.real.log_activity("poll", "error", "Manual poll failed", Some(&format!("{e:#}"))),
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = ev { show_main(tray.app_handle()); }
        })
        .build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); }
}
