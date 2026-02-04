use std::ptr;
use std::sync::{Arc, Mutex};
use libmpv2::Mpv;
use cocoa::base::id;
use tauri::Emitter;
// use cocoa::foundation::NSRect; // Removed unused
use objc::{msg_send, sel, sel_impl, class};
use serde_json;
use tauri_plugin_http::reqwest;

// Helper struct to hold Mpv instance
struct MpvInstance {
    mpv: Mpv,
}

unsafe impl Send for MpvInstance {}
unsafe impl Sync for MpvInstance {}

#[allow(dead_code)]
struct MpvState(Arc<Mutex<Option<MpvInstance>>>);

use std::io::Write;

fn log_to_file(msg: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/mpv_debug.log") {
        let _ = writeln!(file, "{}", msg);
    }
}

#[tauri::command]
async fn launch_mpv_player(
    state: tauri::State<'_, MpvState>,
    app: tauri::AppHandle,
    title: String,
    url: String,
    subtitle_url: Option<String>
) -> Result<(), String> {
    log_to_file(&format!("[INVOKE] launch_mpv_player: title={}, url={}", title, url));
    println!("[INVOKE] launch_mpv_player: title={}, url={}", title, url);
    #[cfg(target_os = "macos")]
    {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        if lock.is_none() {
            log_to_file("[INVOKE] Lock acquired, initializing MPV...");
            let (tx_wid, rx_wid) = std::sync::mpsc::channel::<Result<usize, String>>();
            let app_handle_for_wid = app.clone();
            
            // 1. Get WID/NSView on main thread
            app.run_on_main_thread(move || {
                let res: Result<usize, String> = (|| {
                    use tauri::Manager;
                    let window = app_handle_for_wid.get_webview_window("main").ok_or_else(|| "Main window not found".to_string())?;
                    let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;
                    
                    // Set window background to BLACK
                    unsafe {
                        let _: () = msg_send![ns_window, setOpaque: 1i8]; 
                        let black_color: id = msg_send![class!(NSColor), blackColor];
                        let _: () = msg_send![ns_window, setBackgroundColor: black_color];
                    }
                    
                    // Main content view
                    let content_view: id = unsafe { msg_send![ns_window, contentView] };
                    
                    // Create CAMetalLayer (Plezy Strategy)
                    let metal_layer_ptr: usize = unsafe {
                        // Ensure parent has a layer backing
                        let _: () = msg_send![content_view, setWantsLayer: 1i8];
                        let _: () = msg_send![content_view, layer]; // Ensure root layer exists
                        
                        // Create Metal Layer
                        let layer: id = msg_send![class!(CAMetalLayer), layer];
                        
                        // Create a container view for MPV
                        let mpv_container: id = msg_send![class!(NSView), alloc];
                        let mpv_container: id = msg_send![mpv_container, init];
                        
                        // Enable Layer-Hosting View
                        let _: () = msg_send![mpv_container, setWantsLayer: 1i8];
                        let _: () = msg_send![mpv_container, setLayer: layer];
                        
                        // Add container to window content view
                        // Position BELOW everything (at the bottom) to allow WebView (on top) to capture drag events
                        let _: () = msg_send![content_view, addSubview: mpv_container positioned: -1isize relativeTo: std::ptr::null_mut::<std::ffi::c_void>()];
                        
                        // Disable Autoresizing Mask Translation for Auto Layout
                        let _: () = msg_send![mpv_container, setTranslatesAutoresizingMaskIntoConstraints: 0i8];
                        
                        // Apply Constraints to Pin to Edges
                        let top_anchor: id = msg_send![mpv_container, topAnchor];
                        let parent_top: id = msg_send![content_view, topAnchor];
                        let constraint: id = msg_send![top_anchor, constraintEqualToAnchor: parent_top];
                        let _: () = msg_send![constraint, setActive: 1i8];
                        
                        let bottom_anchor: id = msg_send![mpv_container, bottomAnchor];
                        let parent_bottom: id = msg_send![content_view, bottomAnchor];
                        let constraint: id = msg_send![bottom_anchor, constraintEqualToAnchor: parent_bottom];
                        let _: () = msg_send![constraint, setActive: 1i8];
                        
                        let left_anchor: id = msg_send![mpv_container, leadingAnchor];
                        let parent_left: id = msg_send![content_view, leadingAnchor];
                        let constraint: id = msg_send![left_anchor, constraintEqualToAnchor: parent_left];
                        let _: () = msg_send![constraint, setActive: 1i8];
                        
                        let right_anchor: id = msg_send![mpv_container, trailingAnchor];
                        let parent_right: id = msg_send![content_view, trailingAnchor];
                        let constraint: id = msg_send![right_anchor, constraintEqualToAnchor: parent_right];
                        let _: () = msg_send![constraint, setActive: 1i8];

                        // Get the layer POINTER from the container (should be same as `layer`)
                        let backing_layer: id = msg_send![mpv_container, layer];
                        
                        // Visual properties (moved from original layer setup)
                        let ns_black: id = msg_send![class!(NSColor), blackColor];
                        let black_cg: id = msg_send![ns_black, CGColor];
                        let _: () = msg_send![layer, setBackgroundColor: black_cg];

                        println!("[DEBUG] CAMetalLayer created and attached via NSView container. Returning LAYER Pointer: {:p}", backing_layer);
                        
                        backing_layer as usize // Return LAYER pointer as WID (Plezy usage)
                    };
                    
                    Ok(metal_layer_ptr)
                })();
            let _ = tx_wid.send(res);
        }).map_err(|e| e.to_string())?;

        println!("[INVOKE] Waiting for WID (Layer Pointer)...");
        let mpv_wid_raw = rx_wid.recv().map_err(|_| "Failed to receive WID")??;
        
        let mpv_wid_str = mpv_wid_raw.to_string();
        println!("[INVOKE] Initializing MPV with Layer WID: {}", mpv_wid_str);

        // Initialize MPV
        // Force Vulkan Loader to use MoltenVK ICD found in Homebrew
        std::env::set_var("VK_ICD_FILENAMES", "/Volumes/WD/Users/yommi/Work/tauri_projects/gds_mobile_player/src-tauri/moltenvk_icd.json");
        
        let mpv = Mpv::with_initializer(|init| {
            // 0. Disable Config
            let _ = init.set_option("config", "no");
            let _ = init.set_option("load-scripts", "no");

            // 1. Set WID (Layer Pointer)
            if let Err(e) = init.set_option("wid", mpv_wid_str.as_str()) { 
                println!("[ERROR] Init wid: {}", e); 
                return Err(e); 
            }
            
            // 2. Set VO and Context (Plezy Config)
            if let Err(e) = init.set_option("vo", "gpu-next") { println!("[ERROR] Init vo: {}", e); }
            if let Err(e) = init.set_option("gpu-api", "vulkan") { println!("[ERROR] Init gpu-api: {}", e); }
            if let Err(e) = init.set_option("gpu-context", "moltenvk") { println!("[ERROR] Init gpu-context: {}", e); } // Plezy uses 'moltenvk'
            // Enable HWDEC (Plezy uses videotoolbox)
            if let Err(e) = init.set_option("hwdec", "videotoolbox") { println!("[ERROR] Init hwdec: {}", e); } 
            
            // 3. Behavioral Options
            let _ = init.set_option("keepaspect-window", "no");
            let _ = init.set_option("input-default-bindings", "no");
            let _ = init.set_option("input-vo-keyboard", "no");
            let _ = init.set_option("osc", "no");
            let _ = init.set_option("terminal", "yes");
            // let _ = init.set_option("msg-level", "all=debug"); // Verbose logging

            Ok(())
        }).map_err(|e| {
            println!("[ERROR] MPV init failed: {}", e);
            e.to_string()
        })?;

        println!("[INVOKE] MPV initialized (MacVK/Metal).");
        *lock = Some(MpvInstance { mpv });

    } // End Init Block

        if let Some(ref mut instance) = *lock {
            // 1. Load File First (Reset playlist)
            let args: &[&str] = &[url.as_str(), "replace"];
            let _ = Mpv::command(&instance.mpv, "loadfile", args);
            // println!("[EMBEDDED] Playing: {} -> {}", title, url);

            // 2. Add Subtitle After loading
             if let Some(ref sub) = subtitle_url {
                // Determine if it was loaded. Ideally we wait for 'start-file' event, 
                // but strictly sending commands sequentially usually works if MPV buffers commands.
                let args: &[&str] = &[sub.as_str(), "select"];
                let _ = Mpv::command(&instance.mpv, "sub-add", args);
                println!("[LIB] Added subtitle: {}", sub);
            }
        }
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, app, title, url);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn close_native_player(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut lock = state.0.lock().unwrap();
        if let Some(instance) = lock.take() {
            // Explicitly quit to ensure that core shuts down
            let _ = Mpv::command(&instance.mpv, "quit", &["0"]);
            drop(instance);
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
                    "index": i // useful for debug
                }));
            }
        }
        Ok(serde_json::json!(tracks))
    } else {
        Ok(serde_json::json!([]))
    }
}

#[tauri::command(rename_all = "snake_case")]
fn set_subtitle_track(state: tauri::State<'_, MpvState>, sid: i64) -> Result<(), String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        // sid=0 usually means disabled in some contexts, but MPV uses specific IDs.
        // If sid is passed as 0 and we want to disable, we might send "no".
        // But assuming the frontend passes the correct info.
        // Usually MPV IDs start at 1. 
        // If frontend passes -1 for 'off', handle it.
        /* 
           NOTE: MPV 'sid' property:
           Input: integer ID (1-based usually), or 'no', 'auto'.
        */
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
fn native_set_volume(state: tauri::State<'_, MpvState>, volume: i64) -> Result<(), String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("volume", volume).map_err(|e| e.to_string())?;
    }
    Ok(())
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
            // [NEW] Subtitle Commands
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
