use std::ptr;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tauri::Manager;
use libmpv2::Mpv;

struct MpvInstance {
    mpv: Mpv,
}

struct MpvState(Arc<Mutex<Option<MpvInstance>>>);

fn log_to_file(msg: &str) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/tauri_mpv.log")
        .unwrap();
    let _ = writeln!(file, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg);
}

#[tauri::command(rename_all = "snake_case")]
fn launch_mpv_player(
    state: tauri::State<'_, MpvState>,
    app: tauri::AppHandle,
    title: String,
    url: String,
    subtitle_url: Option<String>
) -> Result<(), String> {
    log_to_file(&format!("[INVOKE] launch_mpv_player: {}", title));

    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        use cocoa::foundation::NSRect;
        use objc::{msg_send, sel, sel_impl, class};
        use std::sync::mpsc;

        let mut lock = state.0.lock().unwrap();
        
        // 1. Initialize if not already present
        if lock.is_none() {
            log_to_file("[INVOKE] Initializing MPV and Layer...");
            
            let (tx, rx) = mpsc::channel();
            let app_ui = app.clone();
            app.run_on_main_thread(move || {
                let res = (|| -> Result<usize, String> {
                    let window = app_ui.get_webview_window("main")
                        .ok_or("Main window not found")?;
                    let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;
                    let content_view: id = unsafe { msg_send![ns_window, contentView] };
                    
                    unsafe {
                        // A. Webview Transparency (Crucial for seeing layer behind)
                        let subviews: id = msg_send![content_view, subviews];
                        let count: usize = msg_send![subviews, count];
                        for i in 0..count {
                            let view: id = msg_send![subviews, objectAtIndex: i];
                            let no_obj: id = msg_send![class!(NSNumber), numberWithBool: 0i8];
                            let key: id = msg_send![class!(NSString), stringWithUTF8String: "drawsBackground\0".as_ptr()];
                            if msg_send![view, respondsToSelector: sel!(setDrawsBackground:)] {
                                let _: () = msg_send![view, setDrawsBackground: 0i8];
                            } else {
                                 let _: () = msg_send![view, setValue: no_obj forKey: key];
                            }
                        }

                        // B. Create Container & Layer
                        let mpv_container: id = msg_send![class!(NSView), alloc];
                        let frame: NSRect = msg_send![content_view, bounds];
                        let mpv_container: id = msg_send![mpv_container, initWithFrame: frame];
                        
                        let metal_layer: id = msg_send![class!(CAMetalLayer), new];
                        let _: () = msg_send![metal_layer, setFrame: frame];
                        let _: () = msg_send![metal_layer, setContentsScale: 2.0f64];
                        
                        let _: () = msg_send![metal_layer, setOpaque: 1i8];
                        
                        let _: () = msg_send![mpv_container, setLayer: metal_layer];
                        let _: () = msg_send![mpv_container, setWantsLayer: 1i8];
                        
                        // Set black background to container to prevent desktop bleed
                        let black: id = msg_send![class!(NSColor), blackColor];
                        let _: () = msg_send![mpv_container, setBackgroundColor: black];

                        // Insert at bottom
                        let _: () = msg_send![content_view, addSubview: mpv_container positioned: -1isize relativeTo: ptr::null_mut::<std::ffi::c_void>()];
                        let _: () = msg_send![mpv_container, setTranslatesAutoresizingMaskIntoConstraints: 0i8];

                        let t_a: id = msg_send![mpv_container, topAnchor];
                        let b_a: id = msg_send![mpv_container, bottomAnchor];
                        let l_a: id = msg_send![mpv_container, leadingAnchor];
                        let r_a: id = msg_send![mpv_container, trailingAnchor];

                        let pt: id = msg_send![content_view, topAnchor];
                        let pb: id = msg_send![content_view, bottomAnchor];
                        let pl: id = msg_send![content_view, leadingAnchor];
                        let pr: id = msg_send![content_view, trailingAnchor];

                        let c_t: id = msg_send![t_a, constraintEqualToAnchor: pt];
                        let c_b: id = msg_send![b_a, constraintEqualToAnchor: pb];
                        let c_l: id = msg_send![l_a, constraintEqualToAnchor: pl];
                        let c_r: id = msg_send![r_a, constraintEqualToAnchor: pr];

                        let _: () = msg_send![c_t, setActive: 1i8];
                        let _: () = msg_send![c_b, setActive: 1i8];
                        let _: () = msg_send![c_l, setActive: 1i8];
                        let _: () = msg_send![c_r, setActive: 1i8];

                        Ok(metal_layer as usize)
                    }
                })();
                let _ = tx.send(res);
            }).map_err(|e| e.to_string())?;

            let mpv_wid_raw = rx.recv().map_err(|_| "Channel recv error".to_string())??;
            let mpv_wid_str = format!("0x{:x}", mpv_wid_raw);

            // 2. Initialize MPV
            std::env::set_var("VK_ICD_FILENAMES", "/Users/A/Work/tauri_projects/gds_mobile_player/src-tauri/moltenvk_icd.json");
            let mpv = Mpv::with_initializer(|init| {
                let _ = init.set_option("config", "no");
                let _ = init.set_option("wid", mpv_wid_str.as_str());
                let _ = init.set_option("vo", "gpu-next");
                let _ = init.set_option("gpu-api", "vulkan");
                let _ = init.set_option("gpu-context", "moltenvk");
                let _ = init.set_option("hwdec", "auto");
                Ok(())
            }).map_err(|e| e.to_string())?;

            *lock = Some(MpvInstance { mpv });

            // Start Event Thread
            let app_events = app.clone();
            let state_events = state.0.clone();
            std::thread::spawn(move || {
                let mut last_p = -1.0;
                let mut last_d = -1.0;
                let mut last_s: Option<bool> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let l = match state_events.lock() { Ok(i) => i, Err(_) => break };
                    if let Some(ref inst) = *l {
                        let pos = inst.mpv.get_property::<f64>("time-pos").unwrap_or(0.0);
                        let dur = inst.mpv.get_property::<f64>("duration").unwrap_or(0.0);
                        let pause = inst.mpv.get_property::<bool>("pause").unwrap_or(false);

                        if (pos - last_p).abs() > 0.4 || (dur - last_d).abs() > 0.1 || Some(pause) != last_s {
                            let _ = app_events.emit("mpv-state", serde_json::json!({
                                "position": pos, "duration": dur, "pause": pause
                            }));
                            last_p = pos; last_d = dur; last_s = Some(pause);
                        }
                    } else { break; }
                }
            });
        }

        // 3. Load File
        if let Some(ref mut inst) = *lock {
            // Check if URL is actually a media file (not a subtitle or something else)
            let lower_url = url.to_lowercase();
            if lower_url.contains(".srt") || lower_url.contains(".vtt") {
                log_to_file(&format!("[SKIP] Skipping loadfile for subtitle: {}", url));
                return Ok(());
            }

            if let Some(ref sub) = subtitle_url {
                let _ = Mpv::command(&inst.mpv, "sub-add", &[sub.as_str(), "select"]);
            }
            log_to_file(&format!("[PLAY] Loading file: {}", url));
            let _ = Mpv::command(&inst.mpv, "loadfile", &[url.as_str(), "replace"]);
            let _ = inst.mpv.set_property("pause", false).map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    { let _ = (state, app, title, url, subtitle_url); }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn close_native_player(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    let mut lock = state.0.lock().unwrap();
    if let Some(instance) = lock.take() {
        let _ = Mpv::command(&instance.mpv, "quit", &["0"]);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_play_pause(state: tauri::State<'_, MpvState>, pause: bool) -> Result<(), String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("pause", pause).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_seek(state: tauri::State<'_, MpvState>, seconds: f64) -> Result<(), String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        let _ = Mpv::command(&instance.mpv, "seek", &[&seconds.to_string(), "absolute"]);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_set_volume(state: tauri::State<'_, MpvState>, volume: i64) -> Result<(), String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("volume", volume).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn search_gds(query: String, server_url: String, api_key: String, category: String) -> Result<serde_json::Value, String> {
    let b_url = format!("{}/gds_dviewer/normal/explorer/search", server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client.get(&b_url).query(&[
            ("query", &query), ("is_dir", &"false".to_string()), ("limit", &"50".to_string()),
            ("category", &category), ("apikey", &api_key),
        ]).send().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[tauri::command(rename_all = "snake_case")]
fn ping() -> String { "pong".to_string() }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MpvState(Arc::new(Mutex::new(None))))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .invoke_handler(tauri::generate_handler![
            launch_mpv_player, close_native_player, native_play_pause, native_seek, native_set_volume, search_gds, ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
