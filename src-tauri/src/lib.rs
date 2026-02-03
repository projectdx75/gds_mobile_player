use std::sync::{Arc, Mutex};
use libmpv2::Mpv;
use cocoa::base::{id, YES, NO};
use cocoa::foundation::{NSRect, NSPoint, NSSize};
use objc::{msg_send, sel, sel_impl, class};
use serde_json;
use tauri_plugin_http::reqwest;

#[allow(dead_code)]
struct MpvState(Arc<Mutex<Option<Mpv>>>);

#[tauri::command]
fn open_native_player(
    state: tauri::State<'_, MpvState>,
    app: tauri::AppHandle,
    title: String,
    url: String,
    subtitle_url: Option<String>
) -> Result<(), String> {
    println!("[INVOKE] open_native_player: title={}, url={}", title, url);
    #[cfg(target_os = "macos")]
    {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        if lock.is_none() {
            let (tx, rx) = std::sync::mpsc::channel();
            let app_handle = app.clone();
            
            app.run_on_main_thread(move || {
                let res: Result<Mpv, String> = (|| {
                    use tauri::Manager;
                    let window = app_handle.get_webview_window("main").ok_or_else(|| "Main window not found".to_string())?;
                    let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;
                    
                    // Get window frame for positioning
                    let parent_frame: NSRect = unsafe { msg_send![ns_window, frame] };
                    
                    // Initialize MPV - let it create its own window
                    let mpv = Mpv::with_initializer(|init| {
                        // IMPORTANT: Disable config files first to prevent override
                        init.set_option("config", "no")?;
                        init.set_option("load-scripts", "no")?;

                        // Use GPU video output driver
                        init.set_option("vo", "gpu-next")?;
                        init.set_option("hwdec", "videotoolbox")?;

                        // Set window position to match parent window
                        let pos = format!("{}x{}", parent_frame.origin.x, parent_frame.origin.y);
                        init.set_option("geometry", format!("{}x{}+{}+{}", 
                            parent_frame.size.width, parent_frame.size.height, 
                            parent_frame.origin.x, parent_frame.origin.y))?;

                        // Enable OSC (still OK as option)
                        init.set_option("osc", "yes")?;
                        let _ = init.set_option("osd-bar", "yes");

                        Ok(())
                    }).map_err(|e| e.to_string())?;
                    
                    // Wait a bit for mpv window to be created
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    
                    // Try to find and position the mpv window over parent window
                    let _: () = unsafe {
                        // Get all windows
                        let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
                        let windows: id = msg_send![ns_app, windows];
                        let count: usize = msg_send![windows, count];
                        
                        println!("[POSITION] Found {} windows", count);
                        
                        // Iterate through windows to find the mpv window
                        for i in 0..count {
                            let window: id = msg_send![windows, objectAtIndex: i];
                            
                            // Check if this is not our parent window
                            if window != ns_window {
                                // Get window title to check if it's mpv
                                let title: id = msg_send![window, title];
                                let title_str: *const i8 = msg_send![title, UTF8String];
                                let title_cstr = unsafe { std::ffi::CStr::from_ptr(title_str) };
                                let title_str = unsafe { std::ffi::CStr::to_str(title_cstr).unwrap_or_default() };
                                
                                println!("[POSITION] Window {}: title = {:?}", i, title_str);
                                
                                // Only call window APIs if the instance implements setFrame:
                                let responds_set_frame: bool = msg_send![window, respondsToSelector: sel!(setFrame:)];
                                if !responds_set_frame {
                                    println!("[POSITION] Skipping window {}: does not respond to setFrame:", i);
                                } else {
                                    // Position the mpv window to match parent window frame
                                    let _: () = msg_send![window, setFrame: parent_frame];

                                    // Set window level to be above parent
                                    let _: () = msg_send![window, setLevel: 3u64]; // NSFloatingWindowLevel

                                    // Make window visible
                                    let _: () = msg_send![window, setIsVisible: YES];

                                    println!("[POSITION] Positioned mpv window at ({}, {}, {}, {})", 
                                        parent_frame.origin.x, parent_frame.origin.y,
                                        parent_frame.size.width, parent_frame.size.height);
                                    break;
                                }
                            }
                        }
                    };

                    Ok(mpv)
                })();
                
                let _ = tx.send(res);
            }).map_err(|e| e.to_string())?;
            
            let mpv = rx.recv().map_err(|_| "Failed to receive Mpv instance from main thread")??;
            *lock = Some(mpv);
        }

        if let Some(ref mut mpv) = *lock {
            if let Some(ref sub) = subtitle_url {
                let args: &[&str] = &[sub.as_str(), "select"];
                let _ = Mpv::command(mpv, "sub-add", args);
                println!("[EMBEDDED] Added subtitle: {}", sub);
            }
            
            let args: &[&str] = &[url.as_str(), "replace"];
            let _ = Mpv::command(mpv, "loadfile", args);
            println!("[EMBEDDED] Playing: {} -> {}", title, url);
        }
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, app, title, url);
    }
    Ok(())
}

#[tauri::command]
fn close_native_player(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut lock = state.0.lock().unwrap();
        if let Some(mpv) = lock.take() {
            // Explicitly quit to ensure that core shuts down and clears the layer
            let _ = Mpv::command(&mpv, "quit", &["0"]);
            drop(mpv);
            println!("[EMBEDDED] Player closed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
    }
    Ok(())
}

#[tauri::command]
async fn search_gds(query: String, server_url: String, api_key: String, category: String) -> Result<serde_json::Value, String> {
    println!("[SEARCH] Query: {}, Category: {}", query, category);
    
    // Using a simpler URL construction to avoid urlencoding crate dependency issues for now
    let base_url = format!("{}/gds_dviewer/normal/explorer/search", server_url.trim_end_matches('/'));
    
    let client = reqwest::Client::new();
    let response = client
        .get(&base_url)
        .query(&[
            ("query", &query),
            ("is_dir", &"false".to_string()),
            ("limit", &"50".to_string()),
            ("category", &category),
            ("apikey", &api_key),
        ])
        .send()
        .await
        .map_err(|e: reqwest::Error| format!("Network error: {}", e))?;

    let text = response
        .text()
        .await
        .map_err(|e: reqwest::Error| format!("Read body error: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e: serde_json::Error| format!("JSON error: {} | body: {}", e, text))?;

    Ok(json)
}

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

// run_embedding_tests removed (developer debug helper reverted)


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MpvState(Arc::new(Mutex::new(None))))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .invoke_handler(tauri::generate_handler![
            open_native_player,
            close_native_player,
            search_gds,
            ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
