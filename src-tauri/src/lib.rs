use std::process::Child;
use std::sync::Mutex;

#[allow(dead_code)]
struct MpvState(Mutex<Option<Child>>);

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_native_player(
    state: tauri::State<'_, MpvState>,
    title: String,
    url: String
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let mut lock = state.0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            let _ = child.kill();
        }
        println!("[DESKTOP] Launching MPV for: {}", title);
        let child = std::process::Command::new("mpv")
            .arg(url)
            .arg(format!("--title={}", title))
            .spawn()
            .map_err(|e| e.to_string())?;
        *lock = Some(child);
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, title, url);
    }
    Ok(())
}

#[tauri::command]
fn close_native_player(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let mut lock = state.0.lock().unwrap();
        if let Some(mut child) = lock.take() {
            let _ = child.kill();
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MpvState(Mutex::new(None)))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet, 
            open_native_player, 
            close_native_player
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
