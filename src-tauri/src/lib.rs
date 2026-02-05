use std::ptr;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tauri::Manager;
use libmpv2::Mpv;
use tauri_plugin_http::reqwest;
use serde_json;

struct MpvInstance {
    mpv: Mpv,
    // [INTEL-MAC-FIX] Store view ID for cleanup
    #[cfg(target_os = "macos")]
    ns_view: usize,
}

struct MpvState(Arc<Mutex<Option<MpvInstance>>>);

fn log_to_file(msg: &str) {
    use std::io::Write;
    let timestamp = chrono::Local::now().format("%H:%M:%S");
    println!("[{}] {}", timestamp, msg); // Console output
    
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/tauri_mpv.log")
        .unwrap();
    let _ = writeln!(file, "[{}] {}", timestamp, msg);
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
            
            // Channel to receive the NSView address back
            let (view_tx, view_rx) = mpsc::channel();
            
            let t0 = std::time::Instant::now();
            log_to_file("[PERF] Starting Layer Creation on Main Thread...");

            app.run_on_main_thread(move || {
                let res = (|| -> Result<usize, String> {
                    // ... (keep existing unsafe block)
                    let window = app_ui.get_webview_window("main")
                        .ok_or("Main window not found")?;
                    let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;
                    let content_view: id = unsafe { msg_send![ns_window, contentView] };
                    
                    unsafe {
                        // A. Webview Transparency (Crucial for seeing layer behind)
                        let subviews: id = msg_send![content_view, subviews];
                        let count: usize = msg_send![subviews, count];
                        log_to_file(&format!("[LAYER] Subviews count: {}", count)); // Verbose

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
                        // ...
                        let _: () = msg_send![metal_layer, setContentsScale: 2.0f64];
                        let _: () = msg_send![metal_layer, setOpaque: 1i8];
                        
                        let _: () = msg_send![mpv_container, setLayer: metal_layer];
                        let _: () = msg_send![mpv_container, setWantsLayer: 1i8];
                        
                        let black: id = msg_send![class!(NSColor), blackColor];
                        let _: () = msg_send![mpv_container, setBackgroundColor: black];

                        let _: () = msg_send![content_view, addSubview: mpv_container positioned: -1isize relativeTo: ptr::null_mut::<std::ffi::c_void>()];
                        let _: () = msg_send![mpv_container, setTranslatesAutoresizingMaskIntoConstraints: 0i8];

                        // ... (constraints)
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

                        let _ = view_tx.send(mpv_container as usize);
                        Ok(metal_layer as usize)
                    }
                })();
                let _ = tx.send(res);
            }).map_err(|e| e.to_string())?;

            let mpv_wid_raw = rx.recv().map_err(|_| "Channel recv error".to_string())??;
            let ns_view_addr = view_rx.recv().map_err(|_| "View channel recv error".to_string())?;
            
            log_to_file(&format!("[PERF] Layer Created in {:.2}ms", t0.elapsed().as_millis()));

            let mpv_wid_str = format!("0x{:x}", mpv_wid_raw);

            // 2. Initialize MPV
            let is_x86 = cfg!(target_arch = "x86_64");
            
            if !is_x86 {
                // M1/ARM64: Use Vulkan/MoltenVK for better performance
                std::env::set_var("VK_ICD_FILENAMES", "/Users/A/Work/tauri_projects/gds_mobile_player/src-tauri/moltenvk_icd.json");
            }
            
            let t1 = std::time::Instant::now();
            let mpv = Mpv::with_initializer(|init| {
                let _ = init.set_option("config", "no");
                let _ = init.set_option("wid", mpv_wid_str.as_str());
                
                if is_x86 {
                    // [INTEL-MAC-FIX] Use OpenGL for stability on older Intel chips
                    let _ = init.set_option("vo", "gpu"); 
                    let _ = init.set_option("gpu-api", "opengl");
                } else {
                    // [M1-OPTIMIZATION] Use modern v2 renderer (vulkan)
                    let _ = init.set_option("vo", "gpu-next");
                    let _ = init.set_option("gpu-api", "vulkan");
                }
                
                let _ = init.set_option("hwdec", "auto");
                Ok(())
            }).map_err(|e| e.to_string())?;
            
            log_to_file(&format!("[PERF] MPV Initialized in {:.2}ms", t1.elapsed().as_millis()));

            *lock = Some(MpvInstance { 
                mpv, 
                ns_view: ns_view_addr 
            });

            // Start Event Thread
            let app_events = app.clone();
            let state_events = state.0.clone();
            std::thread::spawn(move || {
                let mut last_p = -1.0;
                let mut last_d = -1.0;
                let mut last_s: Option<bool> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    let l = match state_events.lock() { Ok(i) => i, Err(_) => break };
                    if let Some(ref inst) = *l {
                        let pos = inst.mpv.get_property::<f64>("time-pos").unwrap_or(0.0);
                        let dur = inst.mpv.get_property::<f64>("duration").unwrap_or(0.0);
                        let pause = inst.mpv.get_property::<bool>("pause").unwrap_or(false);

                        // [DEBUG] Log position heartbeat
                        if pos > 0.0 && (pos as i64 % 5 == 0) && (pos - last_p).abs() > 0.8 {
                            log_to_file(&format!("[EVENT] Playback Heartbeat: {:.1}/{:.1} (pause: {})", pos, dur, pause));
                        }

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
                 log_to_file(&format!("[SUB] Adding subtitle: {}", sub));
                 let _ = Mpv::command(&inst.mpv, "sub-add", &[sub.as_str(), "select"]);
            }
            log_to_file(&format!("[PLAY] Loading file: {}", url));
            let res = Mpv::command(&inst.mpv, "loadfile", &[url.as_str(), "replace"]);
            if let Err(e) = res {
                 log_to_file(&format!("[ERROR] loadfile failed: {}", e));
            } else {
                 log_to_file("[PLAY] loadfile sent successfully");
            }
            let _ = inst.mpv.set_property("pause", false).map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    { let _ = (state, app, title, url, subtitle_url); }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn close_native_player(
    state: tauri::State<'_, MpvState>,
    app: tauri::AppHandle
) -> Result<(), String> {
    log_to_file("[INVOKE] close_native_player called");
    let mut lock = state.0.lock().unwrap();
    if let Some(instance) = lock.take() {
        let _ = Mpv::command(&instance.mpv, "quit", &["0"]);
        
        #[cfg(target_os = "macos")]
        {
            use cocoa::base::id;
            use objc::{msg_send, sel, sel_impl};
            
            let view_addr = instance.ns_view;
            app.run_on_main_thread(move || {
                unsafe {
                    let view: id = view_addr as id;
                    let _: () = msg_send![view, removeFromSuperview];
                }
            });
            log_to_file("[CLEANUP] Native view removal requested on main thread");
        }
    } else {
        log_to_file("[WARN] close_native_player called but no instance found");
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_play_pause(state: tauri::State<'_, MpvState>, pause: bool) -> Result<(), String> {
    log_to_file(&format!("[CMD] native_play_pause: {}", pause));
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("pause", pause).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_seek(state: tauri::State<'_, MpvState>, seconds: f64) -> Result<(), String> {
    log_to_file(&format!("[CMD] native_seek: {}", seconds));
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        let _ = Mpv::command(&instance.mpv, "seek", &[&seconds.to_string(), "absolute"]);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_set_volume(state: tauri::State<'_, MpvState>, volume: i64) -> Result<(), String> {
    log_to_file(&format!("[CMD] native_set_volume: {}", volume));
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("volume", volume).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// [NEW] Subtitle Commands
#[tauri::command(rename_all = "snake_case")]
fn get_subtitle_tracks(state: tauri::State<'_, MpvState>) -> Result<serde_json::Value, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        let count = instance.mpv.get_property::<i64>("track-list/count").unwrap_or(0);
        let mut tracks = Vec::new();

        for i in 0..count {
            let type_prop = format!("track-list/{}/type", i);
            let track_type = instance.mpv.get_property::<String>(&type_prop).unwrap_or_default();

            if track_type == "sub" {
                let id_prop = format!("track-list/{}/id", i);
                let id = instance.mpv.get_property::<i64>(&id_prop).unwrap_or(0);

                let lang_prop = format!("track-list/{}/lang", i);
                let lang = instance.mpv.get_property::<String>(&lang_prop).unwrap_or("".to_string());

                let title_prop = format!("track-list/{}/title", i);
                let title = instance.mpv.get_property::<String>(&title_prop).unwrap_or("".to_string());
                
                let selected_prop = format!("track-list/{}/selected", i);
                let selected = instance.mpv.get_property::<bool>(&selected_prop).unwrap_or(false);

                let external_prop = format!("track-list/{}/external", i);
                let external = instance.mpv.get_property::<bool>(&external_prop).unwrap_or(false);

                tracks.push(serde_json::json!({
                    "id": id,
                    "lang": lang,
                    "title": title,
                    "selected": selected,
                    "external": external,
                    "index": i
                }));
            }
        }
        Ok(serde_json::json!(tracks))
    } else {
        log_to_file("[WARN] get_subtitle_tracks: No instance");
        Ok(serde_json::json!([]))
    }
}

#[tauri::command(rename_all = "snake_case")]
fn set_subtitle_track(state: tauri::State<'_, MpvState>, sid: i64) -> Result<(), String> {
    log_to_file(&format!("[CMD] set_subtitle_track: {}", sid));
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        if sid < 0 {
             let _ = instance.mpv.set_property("sid", "no");
        } else {
             let _ = instance.mpv.set_property("sid", sid);
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn set_subtitle_style(state: tauri::State<'_, MpvState>, scale: Option<f64>, pos: Option<i64>) -> Result<(), String> {
    log_to_file(&format!("[CMD] set_subtitle_style: scale={:?}, pos={:?}", scale, pos));
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        if let Some(s) = scale {
            let _ = instance.mpv.set_property("sub-scale", s);
        }
        if let Some(p) = pos {
            let _ = instance.mpv.set_property("sub-pos", p);
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn get_mpv_state(state: tauri::State<'_, MpvState>) -> Result<serde_json::Value, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref inst) = *lock {
        let pos = inst.mpv.get_property::<f64>("time-pos").unwrap_or(0.0);
        let dur = inst.mpv.get_property::<f64>("duration").unwrap_or(0.0);
        let pause = inst.mpv.get_property::<bool>("pause").unwrap_or(false);
        let hwdec: String = inst.mpv.get_property("hwdec-current").unwrap_or("no".to_string());
        Ok(serde_json::json!({ "position": pos, "duration": dur, "pause": pause, "hwdec": hwdec }))
    } else {
        Ok(serde_json::json!({ "position": 0.0, "duration": 0.0, "pause": true, "hwdec": "no" })) 
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn search_gds(query: String, server_url: String, api_key: String, category: String) -> Result<serde_json::Value, String> {
    println!("[SEARCH] Query: {}, Category: {}", query, category);
    
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

#[tauri::command(rename_all = "snake_case")]
fn ping() -> String {
    "pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MpvState(Arc::new(Mutex::new(None))))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .invoke_handler(tauri::generate_handler![
            launch_mpv_player,
            close_native_player,
            native_play_pause,
            native_seek,
            native_set_volume,
            get_subtitle_tracks,
            set_subtitle_track,
            set_subtitle_style,
            search_gds,
            ping,
            get_mpv_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
