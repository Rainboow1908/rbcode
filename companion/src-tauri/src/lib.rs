mod computer;
#[cfg(windows)]
mod conpty;
mod mcp;
mod music;
mod server;
mod state;
mod web;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

use state::AppState;

/// 与网页端 CompanionBackend 约定的探测端口（见 web/src/lib/executor/companion.ts）
const PORT: u16 = 7717;

#[derive(Serialize)]
struct Status {
    token: String,
    port: u16,
    root: String,
    autostart: bool,
    requests: u64,
}

#[tauri::command]
fn get_status(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Status {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    Status {
        token: state.token(),
        port: state.port,
        root: state.root_path().to_string_lossy().to_string(),
        autostart,
        requests: state.requests.load(Ordering::Relaxed),
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|err| err.to_string())
}

#[tauri::command]
fn regenerate_token(state: tauri::State<'_, Arc<AppState>>) -> String {
    state.regenerate_token()
}

pub fn run() {
    let state = Arc::new(AppState::new(PORT));
    println!("RB Code 本机执行器启动，配对令牌：{}", state.token());

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_autostart,
            regenerate_token
        ])
        .setup(move |app| {
            server::start(state.clone());
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口只隐藏，程序继续在托盘里运行
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon()
                .expect("缺少窗口图标")
                .clone(),
        )
        .tooltip("RB Code 本机执行器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
