use std::ptr;
use std::sync::{Arc, Mutex};
use libmpv2::Mpv;
use cocoa::base::id;
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
    }

        if let Some(ref mut instance) = *lock {
             if let Some(ref sub) = subtitle_url {
                let args: &[&str] = &[sub.as_str(), "select"];
                let _ = Mpv::command(&instance.mpv, "sub-add", args);
                println!("[EMBEDDED] Added subtitle: {}", sub);
            }
            
            let args: &[&str] = &[url.as_str(), "replace"];
            let _ = Mpv::command(&instance.mpv, "loadfile", args);
            println!("[EMBEDDED] Playing: {} -> {}", title, url);
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
            search_gds,
            ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
