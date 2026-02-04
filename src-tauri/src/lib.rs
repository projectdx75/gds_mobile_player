use std::ptr;
use std::sync::{Arc, Mutex};
use libmpv2::Mpv;
use cocoa::base::id;
use cocoa::foundation::NSRect; // Imported for frame bounds
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
            
            // 1. Get WID/NSView on main thread using Native GCD (to avoid Tauri deadlock on Intel)
            log_to_file("[INVOKE] Dispatching task to Main Queue via GCD...");
            let res: Result<usize, String> = (|| {
                let (tx, rx) = std::sync::mpsc::channel::<Result<usize, String>>();
                
                // Use dispatch crate to execute on Main Queue synchronously
                // This bypasses Tauri's scheduler which might be deadlocked
                let app_handle = app_handle_for_wid.clone();
                
                dispatch::Queue::main().exec_async(move || {
                     let res: Result<usize, String> = (|| {
                        use tauri::Manager;
                        log_to_file("[DEBUG] Running on Main Thread (GCD)");
                        let window = app_handle.get_webview_window("main").ok_or_else(|| "Main window not found".to_string())?;
                        let ns_window = window.ns_window().map_err(|e| e.to_string())? as id;
                        
                        // Set window background to BLACK and allow transparency
                        unsafe {
                            let _: () = msg_send![ns_window, setOpaque: 0i8]; 
                            let black_color: id = msg_send![class!(NSColor), blackColor];
                            let _: () = msg_send![ns_window, setBackgroundColor: black_color];
                        }
                        
                        // Main content view
                        let content_view: id = unsafe { msg_send![ns_window, contentView] };
                        
                        // FORCE Subviews (WebView) to be transparent
                        unsafe {
                            let subviews: id = msg_send![content_view, subviews];
                            let count: usize = msg_send![subviews, count];
                            log_to_file(&format!("[DEBUG] Found {} subviews in content view", count));
                            
                            for i in 0..count {
                                let view: id = msg_send![subviews, objectAtIndex: i];
                                // Try setting drawsBackground to NO (works for WKWebView/NSScrollView)
                                // We use setValue:forKey: to handle different view types safely
                                let no_obj: id = msg_send![class!(NSNumber), numberWithBool: 0i8];
                                let key: id = msg_send![class!(NSString), stringWithUTF8String: "drawsBackground\0".as_ptr()];
                                
                                // Best effort: try checking if it responds to setDrawsBackground:
                                let sel = sel!(setDrawsBackground:);
                                if msg_send![view, respondsToSelector: sel] {
                                    let _: () = msg_send![view, setDrawsBackground: 0i8];
                                    log_to_file(&format!("[DEBUG] Forced transparency on subview {}", i));
                                } else {
                                     // Try KVC as fallback (e.g. for WKWebView internals)
                                     // Note: WKWebView itself might not, but its scrollview might.
                                     // This is a "Hail Mary" to ensure transparency.
                                     let _: () = msg_send![view, setValue: no_obj forKey: key];
                                     log_to_file(&format!("[DEBUG] Key-Value forced transparency on subview {}", i));
                                }
                            }
                        }

                        // Create a container view for MPV
                        let mpv_container_ptr: usize = unsafe {
                            let mpv_container: id = msg_send![class!(NSView), alloc];
                            
                            // Initialize with Frame of parent
                            let frame: NSRect = msg_send![content_view, bounds];
                            let mpv_container: id = msg_send![mpv_container, initWithFrame: frame];
                            // Create a CAMetalLayer explicitly for vo=gpu-next
                            let metal_layer: id = msg_send![class!(CAMetalLayer), new];
                            let _: () = msg_send![mpv_container, setLayer: metal_layer];
                            let _: () = msg_send![mpv_container, setWantsLayer: 1i8]; 

                            // Insert MPV container at index -1 (Bottom / WindowBelow)
                            // This puts MPV BEHIND the Webview.
                            let _: () = msg_send![content_view, addSubview: mpv_container positioned: -1isize relativeTo: std::ptr::null_mut::<std::ffi::c_void>()];
                            
                            let _: () = msg_send![mpv_container, setTranslatesAutoresizingMaskIntoConstraints: 0i8];
                            
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

                            log_to_file(&format!("[DEBUG] NSView created (Metal Layer-Backed). Returning LAYER Pointer: {:p}", metal_layer));
                            
                            metal_layer as usize
                        };
                        
                        Ok(mpv_container_ptr)
                    })();
                    let _ = tx.send(res);
                });
                
                // Wait for the block to execute
                rx.recv().map_err(|_| "Failed to receive WID from GCD block".to_string())?
            })();

            log_to_file("[INVOKE] Waiting for WID (Layer Pointer)...");
            let mpv_wid_raw = res?;
            
            // Format WID as Hexadecimal. Some libmpv versions on macOS prefer "0x..." strings.
            let mpv_wid_str = format!("0x{:x}", mpv_wid_raw);
            log_to_file(&format!("[INVOKE] Initializing MPV with Hex Layer WID: {}", mpv_wid_str));

            // Initialize MPV
            // Force Vulkan Loader to use the Intel-compatible MoltenVK ICD
            std::env::set_var("VK_ICD_FILENAMES", "/Users/A/Work/tauri_projects/gds_mobile_player/src-tauri/moltenvk_icd.json");
            
            let mpv = Mpv::with_initializer(|init| {
                // 0. Disable Config
                let _ = init.set_option("config", "no");
                let _ = init.set_option("load-scripts", "no");

                // 1. Set WID (Layer Pointer)
                if let Err(e) = init.set_option("wid", mpv_wid_str.as_str()) { 
                    log_to_file(&format!("[ERROR] Init wid: {}", e)); 
                    return Err(e); 
                }
                
                // 2. Set VO and Context (Metal/MoltenVK Path)
                if let Err(e) = init.set_option("vo", "gpu-next") { println!("[ERROR] Init vo: {}", e); }
                if let Err(e) = init.set_option("gpu-api", "vulkan") { println!("[ERROR] Init gpu-api: {}", e); }
                if let Err(e) = init.set_option("gpu-context", "moltenvk") { println!("[ERROR] Init gpu-context: {}", e); }
                
                // Enable HWDEC
                if let Err(e) = init.set_option("hwdec", "auto") { println!("[ERROR] Init hwdec: {}", e); } 
            
            // 3. Behavioral Options
            let _ = init.set_option("keepaspect-window", "no");
            let _ = init.set_option("input-default-bindings", "no");
            let _ = init.set_option("input-vo-keyboard", "no");
            let _ = init.set_option("osc", "no");
            let _ = init.set_option("terminal", "yes");
            let _ = init.set_option("msg-level", "all=debug"); // Verbose logging

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
