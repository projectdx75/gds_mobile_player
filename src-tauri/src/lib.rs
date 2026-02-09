use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use libmpv2::Mpv;
#[cfg(target_os = "macos")]
use cocoa::base::id;
#[cfg(target_os = "macos")]
use cocoa::foundation::NSRect;
#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl, class};
use serde_json;
use tauri_plugin_http::reqwest;

// Helper struct to hold Mpv instance
#[cfg(target_os = "macos")]
struct MpvInstance {
    mpv: Mpv,
    container_view: usize, // Store container to remove on close
    using_layer_wid: bool, // true: CAMetalLayer wid, false: NSView wid
}

#[cfg(target_os = "macos")]
unsafe impl Send for MpvInstance {}
#[cfg(target_os = "macos")]
unsafe impl Sync for MpvInstance {}

#[allow(dead_code)]
#[cfg(target_os = "macos")]
struct MpvState(Arc<Mutex<Option<MpvInstance>>>);
#[allow(dead_code)]
#[cfg(not(target_os = "macos"))]
struct MpvState(Arc<Mutex<Option<()>>>);

use std::io::Write;

fn log_to_file(msg: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/mpv_debug.log") {
        let _ = writeln!(file, "{}", msg);
    }
}

#[cfg(target_os = "macos")]
fn apply_quality_profile(mpv: &Mpv, profile: &str) -> String {
    let normalized = match profile {
        "quality" => "quality",
        "smooth" => "smooth",
        _ => "balanced",
    };

    // Common baseline options.
    let _ = mpv.set_property("deband", "yes");
    let _ = mpv.set_property("dscale", "mitchell");
    let _ = mpv.set_property("scale", "ewa_lanczossharp");
    let _ = mpv.set_property("cscale", "spline36");
    let _ = mpv.set_property("sigmoid-upscaling", "yes");

    match normalized {
        "quality" => {
            let _ = mpv.set_property("deband-iterations", 3);
            let _ = mpv.set_property("interpolation", "yes");
            let _ = mpv.set_property("video-sync", "display-resample");
            let _ = mpv.set_property("tscale", "oversample");
        }
        "smooth" => {
            let _ = mpv.set_property("scale", "bilinear");
            let _ = mpv.set_property("cscale", "bilinear");
            let _ = mpv.set_property("deband", "no");
            let _ = mpv.set_property("interpolation", "yes");
            let _ = mpv.set_property("video-sync", "display-resample");
            let _ = mpv.set_property("tscale", "oversample");
        }
        _ => {
            let _ = mpv.set_property("deband-iterations", 2);
            let _ = mpv.set_property("interpolation", "no");
            let _ = mpv.set_property("video-sync", "audio");
        }
    }

    println!("[QUALITY] Applied profile: {}", normalized);
    normalized.to_string()
}

#[tauri::command]
async fn launch_mpv_player(
    state: tauri::State<'_, MpvState>,
    app: tauri::AppHandle,
    title: String,
    url: String,
    subtitle_url: Option<String>,
    start_pos: Option<f64>,
    start_paused: Option<bool>,
) -> Result<(), String> {
    log_to_file(&format!("[INVOKE] launch_mpv_player: title={}, url={}", title, url));
    println!("[INVOKE] launch_mpv_player: title={}, url={}", title, url);
    #[cfg(target_os = "macos")]
    {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        if lock.is_none() {
            log_to_file("[INVOKE] Lock acquired, initializing MPV...");
            let (tx_wid, rx_wid) = std::sync::mpsc::channel::<Result<(usize, usize, usize), String>>();
            let app_handle_for_wid = app.clone();
            
            // 1. Get WID/NSView on main thread
            app.run_on_main_thread(move || {
                let res: Result<(usize, usize, usize), String> = (|| {
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
                    
                    // Create embedding NSView for mpv.
                    // Keep CAMetalLayer* as the primary WID candidate.
                    let (layer_wid_ptr, mpv_container_ptr): (usize, usize) = unsafe {
                        // Ensure parent has a layer backing
                        let _: () = msg_send![content_view, setWantsLayer: 1i8];
                        let _: () = msg_send![content_view, layer]; // Ensure root layer exists

                        // Create explicit CAMetalLayer
                        let layer: id = msg_send![class!(CAMetalLayer), layer];

                        // Create a container view for MPV
                        let mpv_container: id = msg_send![class!(NSView), alloc];
                        let mpv_container: id = msg_send![mpv_container, init];
                        
                        // Host the explicit CAMetalLayer
                        let _: () = msg_send![mpv_container, setWantsLayer: 1i8];
                        let _: () = msg_send![mpv_container, setLayer: layer];
                        
                        // Add container to window content view
                        // Position BELOW everything (at the bottom) to allow WebView (on top) to capture drag events
                        let _: () = msg_send![content_view, addSubview: mpv_container positioned: -1isize relativeTo: std::ptr::null_mut::<std::ffi::c_void>()];
                        
                        // [FIX] Use Old-School Autoresizing Mask (More reliable for fullscreen transitions)
                        // This allows the OS to handle resizing automatically as the parent view grows
                        let _: () = msg_send![mpv_container, setTranslatesAutoresizingMaskIntoConstraints: 1i8];
                        let _: () = msg_send![mpv_container, setAutoresizingMask: 18usize];
                        
                        // Set initial frame to match parent bounds
                        let bounds: NSRect = msg_send![content_view, bounds];
                        let _: () = msg_send![mpv_container, setFrame: bounds];
                        let _: () = msg_send![layer, setFrame: bounds];
                        let _: () = msg_send![layer, setAutoresizingMask: 18usize];
                        
                        // Visual properties (moved from original layer setup)
                        let ns_black: id = msg_send![class!(NSColor), blackColor];
                        let black_cg: id = msg_send![ns_black, CGColor];
                        let _: () = msg_send![layer, setBackgroundColor: black_cg];

                        println!("[DEBUG] MPV container created. LAYER ptr: {:p}", layer);
                        
                        (layer as usize, mpv_container as usize)
                    };
                    
                    // Return both candidates:
                    //   1) CAMetalLayer* for Layer WID path
                    //   2) NSView*      for NSView WID path
                    Ok((layer_wid_ptr, mpv_container_ptr, mpv_container_ptr))
                })();
            let _ = tx_wid.send(res);
        }).map_err(|e| e.to_string())?;

        println!("[INVOKE] Waiting for WID pointers...");
        let (layer_wid_raw, nsview_wid_raw, container_view_ptr) = rx_wid.recv().map_err(|_| "Failed to receive WID")??;

        // --- Dynamic MoltenVK ICD Detection ---
        let m1_lib = "/opt/homebrew/lib/libMoltenVK.dylib";
        let intel_lib = "/usr/local/lib/libMoltenVK.dylib";
        let lib_candidates = if std::env::consts::ARCH == "x86_64" {
            [intel_lib, m1_lib]
        } else {
            [m1_lib, intel_lib]
        };

        // Pick an existing library path, preferring the current CPU architecture.
        let actual_lib = lib_candidates
            .iter()
            .copied()
            .find(|path| std::path::Path::new(path).exists())
            .unwrap_or_else(|| {
                println!(
                    "[WARN] libMoltenVK.dylib not found in standard Homebrew paths for arch {}.",
                    std::env::consts::ARCH
                );
                lib_candidates[0]
            });

        // Create a temporary ICD JSON content
        let icd_json = serde_json::json!({
            "file_format_version": "1.0.0",
            "ICD": {
                "library_path": actual_lib,
                "api_version": "1.2"
            }
        });

        // Write to a temporary file in the app's executable directory or /tmp
        let icd_temp_path = "/tmp/moltenvk_icd_auto.json";
        if let Ok(mut file) = std::fs::File::create(icd_temp_path) {
            let _ = file.write_all(icd_json.to_string().as_bytes());
        }

        // Set the environment variable to our dynamic ICD only on Apple Silicon path.
        // Intel path is forced to OpenGL and should not touch Vulkan/MoltenVK.
        if std::env::consts::ARCH != "x86_64" {
            std::env::set_var("VK_ICD_FILENAMES", icd_temp_path);
            println!("[INVOKE] Using Dynamic ICD: {} -> {}", icd_temp_path, actual_lib);
        } else {
            std::env::remove_var("VK_ICD_FILENAMES");
            println!("[INVOKE] Intel path: VK_ICD_FILENAMES cleared (OpenGL-only)");
        }
        // --------------------------------------
        
        let try_init_mpv = |wid_raw: usize, wid_kind: &str, profile: &str| -> Result<Mpv, String> {
            let wid_i64 = wid_raw as i64;
            println!("[INVOKE] Initializing MPV with {} WID ({}): {}", wid_kind, profile, wid_i64);

            Mpv::with_initializer(|init| {
                // 0. Disable Config
                let _ = init.set_option("config", "no");
                let _ = init.set_option("load-scripts", "no");

                // 1. Set WID
                if let Err(e) = init.set_option("wid", wid_i64) {
                    println!("[ERROR] Init wid ({}) failed: {}", wid_kind, e);
                    return Err(e);
                }

                // Intel safety path: hard-force OpenGL/cocoa and avoid Vulkan/MoltenVK.
                // This prevents NSView delegate crash from vkCreateMetalSurfaceEXT.
                if std::env::consts::ARCH == "x86_64" {
                    if let Err(e) = init.set_option("vo", "gpu") {
                        println!("[ERROR] Init vo: {}", e);
                        return Err(e);
                    }
                    if let Err(e) = init.set_option("gpu-context", "cocoa") {
                        println!("[WARN] Init gpu-context=cocoa failed: {}", e);
                        // For NSView path, require cocoa context to avoid Vulkan route.
                        if profile.starts_with("nsview") {
                            return Err(e);
                        }
                    }
                    if let Err(e) = init.set_option("hwdec", "videotoolbox") { println!("[ERROR] Init hwdec: {}", e); }
                    let _ = init.set_option("keepaspect-window", "no");
                    let _ = init.set_option("input-default-bindings", "no");
                    let _ = init.set_option("input-vo-keyboard", "no");
                    let _ = init.set_option("osc", "no");
                    let _ = init.set_option("terminal", "yes");
                    println!("[INVOKE] Intel forced MPV profile: vo=gpu + opengl/cocoa (no Vulkan)");
                    return Ok(());
                }
                
                // 2. Set VO and Context profile
                match profile {
                    "nsview-metal" => {
                        if let Err(e) = init.set_option("vo", "gpu-next") { println!("[ERROR] Init vo: {}", e); }
                        let metal_api_res = init.set_option("gpu-api", "metal");
                        let metal_ctx_res = init.set_option("gpu-context", "cocoa");
                        let metal_ok = metal_api_res.is_ok() && metal_ctx_res.is_ok();
                        if metal_ok {
                            println!("[INVOKE] MPV GPU profile: gpu-next + metal/cocoa");
                        } else {
                            println!("[ERROR] gpu-next + metal/cocoa init path failed");
                            if let Err(e) = metal_api_res {
                                return Err(e);
                            }
                            if let Err(e) = metal_ctx_res {
                                return Err(e);
                            }
                        }
                    }
                    "nsview-gpu" => {
                        if let Err(e) = init.set_option("vo", "gpu") { println!("[ERROR] Init vo: {}", e); }
                        if std::env::consts::ARCH == "x86_64" {
                            let _ = init.set_option("gpu-api", "opengl");
                        }
                        let _ = init.set_option("gpu-context", "cocoa");
                        println!("[INVOKE] MPV GPU profile: gpu + cocoa (legacy fallback)");
                    }
                    "nsview-opengl" => {
                        if let Err(e) = init.set_option("vo", "gpu") { println!("[ERROR] Init vo: {}", e); }
                        // Force OpenGL path to avoid MoltenVK/Metal surface selector issues on NSView.
                        let _ = init.set_option("gpu-api", "opengl");
                        let _ = init.set_option("gpu-context", "cocoa");
                        println!("[INVOKE] MPV GPU profile: gpu + opengl/cocoa (experimental)");
                    }
                    _ => {
                        let layer_legacy_vo = std::env::var("MPV_LAYER_VO_LEGACY")
                            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                            .unwrap_or(false);
                        if layer_legacy_vo {
                            let _ = init.set_option("vo", "gpu");
                            let _ = init.set_option("gpu-api", "vulkan");
                            let _ = init.set_option("gpu-context", "moltenvk");
                            println!("[INVOKE] MPV GPU profile: gpu + vulkan/moltenvk (layer-legacy)");
                        } else {
                            if let Err(e) = init.set_option("vo", "gpu-next") { println!("[ERROR] Init vo: {}", e); }
                            let metal_ok = init.set_option("gpu-api", "metal").is_ok()
                                && init.set_option("gpu-context", "cocoa").is_ok();
                            if metal_ok {
                                println!("[INVOKE] MPV GPU profile: gpu-next + metal/cocoa");
                            } else {
                                println!("[WARN] gpu-api=metal failed, fallback to vulkan/moltenvk");
                                let _ = init.set_option("gpu-api", "vulkan");
                                let _ = init.set_option("gpu-context", "moltenvk");
                                println!("[INVOKE] MPV GPU profile: gpu-next + vulkan/moltenvk");
                            }
                        }
                    }
                }
                if let Err(e) = init.set_option("hwdec", "videotoolbox") { println!("[ERROR] Init hwdec: {}", e); }
                
                // 3. Behavioral Options
                let _ = init.set_option("keepaspect-window", "no");
                let _ = init.set_option("input-default-bindings", "no");
                let _ = init.set_option("input-vo-keyboard", "no");
                let _ = init.set_option("osc", "no");
                let _ = init.set_option("terminal", "yes");

                Ok(())
            })
            .map_err(|e| {
                println!("[ERROR] MPV init failed with {} WID: {}", wid_kind, e);
                e.to_string()
            })
        };

        // Default behavior:
        // - Intel(x86_64): prefer NSView path (OpenGL/cocoa), fallback to Layer.
        // - Apple Silicon: default Layer path, NSView only when explicitly requested.
        // Override behavior with:
        //   MPV_WID_EXPERIMENT=nsview  -> force NSView path
        //   MPV_WID_EXPERIMENT=layer   -> force Layer path
        let wid_experiment = std::env::var("MPV_WID_EXPERIMENT")
            .unwrap_or_default()
            .to_lowercase();
        let arch = std::env::consts::ARCH;
        let prefer_nsview = if wid_experiment == "layer" {
            false
        } else if wid_experiment == "nsview" {
            true
        } else {
            arch == "x86_64"
        };

        let (mpv, using_layer_wid) = if prefer_nsview {
            if arch == "x86_64" {
                // Intel: avoid MoltenVK path on NSView to prevent NSView delegate crash.
                if let Ok(m) = try_init_mpv(nsview_wid_raw, "NSView", "nsview-opengl") {
                    println!("[INVOKE] Selected WID path: NSView + opengl/cocoa (intel)");
                    (m, false)
                } else if let Ok(m) = try_init_mpv(nsview_wid_raw, "NSView", "nsview-gpu") {
                    println!("[INVOKE] Selected WID path: NSView + gpu/cocoa (intel fallback)");
                    (m, false)
                } else {
                    let m = try_init_mpv(layer_wid_raw, "Layer", "layer-fallback")?;
                    println!("[INVOKE] Intel NSView path failed -> fallback Layer");
                    (m, true)
                }
            } else if let Ok(m) = try_init_mpv(nsview_wid_raw, "NSView", "nsview-metal") {
                println!("[INVOKE] Selected WID path: NSView + metal/cocoa (experimental)");
                (m, false)
            } else if let Ok(m) = try_init_mpv(nsview_wid_raw, "NSView", "nsview-opengl") {
                println!("[INVOKE] Selected WID path: NSView + opengl/cocoa (experimental)");
                (m, false)
            } else if let Ok(m) = try_init_mpv(nsview_wid_raw, "NSView", "nsview-gpu") {
                println!("[INVOKE] Selected WID path: NSView + gpu/cocoa (experimental)");
                (m, false)
            } else {
                let m = try_init_mpv(layer_wid_raw, "Layer", "layer-fallback")?;
                println!("[INVOKE] NSView preferred path failed -> fallback Layer");
                (m, true)
            }
        } else {
            let m = try_init_mpv(layer_wid_raw, "Layer", "layer-fallback")?;
            println!("[INVOKE] Selected WID path: Layer (default)");
            (m, true)
        };

        println!("[INVOKE] MPV initialized (MacVK/Metal).");
        *lock = Some(MpvInstance { mpv, container_view: container_view_ptr, using_layer_wid });

        } // End Init Block

        if let Some(ref mut instance) = *lock {
            // 1. Load File First (Reset playlist)
            let mut load_args_owned: Vec<String> = vec![url.clone(), "replace".to_string()];
            if let Some(pos) = start_pos {
                if pos > 0.2 {
                    load_args_owned.push(format!("start={:.3}", pos));
                }
            }
            if start_paused.unwrap_or(false) {
                load_args_owned.push("pause=yes".to_string());
            }
            let load_args: Vec<&str> = load_args_owned.iter().map(|s| s.as_str()).collect();
            let _ = Mpv::command(&instance.mpv, "loadfile", &load_args);
            // println!("[EMBEDDED] Playing: {} -> {}", title, url);

            // 2. Add Subtitle After loading
            // 2. Add Subtitle After loading
             if let Some(ref sub) = subtitle_url {
                if !sub.is_empty() {
                    let args: &[&str] = &[sub.as_str(), "select"];
                    let _ = Mpv::command(&instance.mpv, "sub-add", args);
                    println!("[LIB] Added primary subtitle: {}", sub);
                }
            }
        }
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, app, title, url, subtitle_url);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn native_sub_add(state: tauri::State<'_, MpvState>, url: String, title: Option<String>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, url, title);
        return Err("native_sub_add is only supported on macOS/mpv".to_string());
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        let args: &[&str] = if let Some(ref t) = title {
            &[url.as_str(), "auto", t.as_str()]
        } else {
            &[url.as_str(), "auto"]
        };
        let _ = Mpv::command(&instance.mpv, "sub-add", args);
        println!("[LIB] Added track: {}", url);
        Ok(())
    } else {
        Err("Player not active".to_string())
    }
    }
}

#[tauri::command(rename_all = "snake_case")]
fn native_sub_reload(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        return Err("native_sub_reload is only supported on macOS/mpv".to_string());
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        // Re-scan tracks by toggling or just let frontend re-fetch
        let _ = Mpv::command(&instance.mpv, "sub-reload", &[]);
        Ok(())
    } else {
        Err("Player not active".to_string())
    }
    }
}

#[tauri::command(rename_all = "snake_case")]
fn close_native_player(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut lock = state.0.lock().unwrap();
        if let Some(instance) = lock.take() {
            // 1. Explicitly quit to ensure that core shuts down
            let _ = libmpv2::Mpv::command(&instance.mpv, "quit", &["0"]);
            
            // 2. Remove the container view from superview (Prevent layer leak)
            let container_ptr = instance.container_view as id;
            unsafe {
                let _: () = msg_send![container_ptr, removeFromSuperview];
            }
            
            drop(instance);
            println!("[EMBEDDED] Player closed and view removed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn resize_native_player(state: tauri::State<'_, MpvState>, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // Global NSRect and id are now used

        let (container_ptr_opt, using_layer_wid) = {
            let lock = state.0.lock().map_err(|e| e.to_string())?;
            (
                lock.as_ref().map(|inst| inst.container_view),
                lock.as_ref().map(|inst| inst.using_layer_wid).unwrap_or(false),
            )
        };

        if let Some(container_view_addr) = container_ptr_opt {
            let app_handle = app.clone();
            
            let _ = app.run_on_main_thread(move || {
                let window = match app_handle.get_webview_window("main") {
                    Some(w) => w,
                    None => return,
                };
                
                let ns_window_ptr = match window.ns_window() {
                    Ok(ptr) => ptr as id,
                    Err(_) => return,
                };

                unsafe {
                    let container_ptr = container_view_addr as id;
                    let content_view: id = msg_send![ns_window_ptr, contentView];
                    let bounds: NSRect = msg_send![content_view, bounds];
                    let scale: f64 = msg_send![ns_window_ptr, backingScaleFactor];

                    // Force Match Parent Bounds
                    let _: () = msg_send![container_ptr, setTranslatesAutoresizingMaskIntoConstraints: 1i8];
                    let _: () = msg_send![container_ptr, setAutoresizingMask: 18usize];
                    let _: () = msg_send![container_ptr, setFrame: bounds];

                    if using_layer_wid {
                        // Keep CAMetalLayer bounds aligned with container bounds
                        // when mpv renders against layer pointer (`wid`).
                        let layer: id = msg_send![container_ptr, layer];
                        if !layer.is_null() {
                            let _: () = msg_send![layer, setFrame: bounds];
                            let _: () = msg_send![layer, setContentsScale: scale];
                            let supports_drawable_size: bool = msg_send![layer, respondsToSelector: sel!(setDrawableSize:)];
                            if supports_drawable_size {
                                let drawable_size = cocoa::foundation::NSSize::new(
                                    bounds.size.width * scale,
                                    bounds.size.height * scale,
                                );
                                let _: () = msg_send![layer, setDrawableSize: drawable_size];
                            }
                            let _: () = msg_send![layer, setNeedsDisplay];
                        }
                    } else {
                        // NSView-wid path: force layout/display updates on container view.
                        let _: () = msg_send![container_ptr, setNeedsLayout: 1i8];
                        let _: () = msg_send![container_ptr, setNeedsDisplay: 1i8];
                    }
                    
                    let _: () = msg_send![container_ptr, layoutSubtreeIfNeeded];

                    println!(
                        "[RESIZE] Container/{} -> {}x{} (scale: {}, drawable: {}x{})",
                        if using_layer_wid { "LAYER" } else { "NSVIEW" },
                        bounds.size.width,
                        bounds.size.height,
                        scale,
                        bounds.size.width * scale,
                        bounds.size.height * scale
                    );
                }
            });

            // Trigger mpv VO refresh after host view resize.
            // Some Layer-wid paths keep rendering at the initial size until a VO-side update occurs.
            {
                let lock = state.0.lock().map_err(|e| e.to_string())?;
                if let Some(ref instance) = *lock {
                    let zoom = instance.mpv.get_property::<f64>("video-zoom").unwrap_or(0.0);
                    let _ = instance.mpv.set_property("video-zoom", zoom + 0.0001f64);
                    let _ = instance.mpv.set_property("video-zoom", zoom);
                    let _ = Mpv::command(&instance.mpv, "seek", &["+0", "relative"]);
                    let osd_w = instance.mpv.get_property::<i64>("osd-width").unwrap_or(-1);
                    let osd_h = instance.mpv.get_property::<i64>("osd-height").unwrap_or(-1);
                    let out_dw = instance.mpv.get_property::<i64>("video-out-params/dw").unwrap_or(-1);
                    let out_dh = instance.mpv.get_property::<i64>("video-out-params/dh").unwrap_or(-1);
                    println!(
                        "[RESIZE] MPV reconfigure poke sent (osd={}x{}, out={}x{})",
                        osd_w, osd_h, out_dw, out_dh
                    );
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, app);
    }
    Ok(())
}

#[tauri::command]
async fn search_gds(query: String, server_url: String, api_key: String, category: String) -> Result<serde_json::Value, String> {
    println!("[SEARCH] Query: {}, Category: {}", query, category);
    
    // Using a simpler URL construction to avoid urlencoding crate dependency issues for now
    let base_url = format!("{}/gds_dviewer/normal/search", server_url.trim_end_matches('/'));
    
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
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        return Ok(serde_json::json!({
            "position": 0.0,
            "duration": 0.0,
            "pause": true,
            "hwdec": "no",
            "sid": -1,
            "volume": 100,
            "osd_width": -1,
            "osd_height": -1,
            "out_width": -1,
            "out_height": -1
        }));
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref inst) = *lock {
        let pos = inst.mpv.get_property::<f64>("time-pos").unwrap_or(0.0);
        let dur = inst.mpv.get_property::<f64>("duration").unwrap_or(0.0);
        let pause = inst.mpv.get_property::<bool>("pause").unwrap_or(false);
        let hwdec: String = inst.mpv.get_property("hwdec-current").unwrap_or("no".to_string());
        let sid = inst.mpv.get_property::<i64>("sid").unwrap_or(-1);
        let volume = inst.mpv.get_property::<i64>("volume").unwrap_or(100);
        let osd_w = inst.mpv.get_property::<i64>("osd-width").unwrap_or(-1);
        let osd_h = inst.mpv.get_property::<i64>("osd-height").unwrap_or(-1);
        let out_w = inst.mpv.get_property::<i64>("video-out-params/dw").unwrap_or(-1);
        let out_h = inst.mpv.get_property::<i64>("video-out-params/dh").unwrap_or(-1);
        Ok(serde_json::json!({
            "position": pos,
            "duration": dur,
            "pause": pause,
            "hwdec": hwdec,
            "sid": sid,
            "volume": volume,
            "osd_width": osd_w,
            "osd_height": osd_h,
            "out_width": out_w,
            "out_height": out_h
        }))
    } else {
        Ok(serde_json::json!({
            "position": 0.0,
            "duration": 0.0,
            "pause": true,
            "hwdec": "no",
            "sid": -1,
            "volume": 100,
            "osd_width": -1,
            "osd_height": -1,
            "out_width": -1,
            "out_height": -1
        }))
    }
    }
}

#[tauri::command(rename_all = "snake_case")]
fn native_play_pause(state: tauri::State<'_, MpvState>, pause: bool) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, pause);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("pause", pause).map_err(|e| e.to_string())?;
    }
    Ok(())
    }
}

#[tauri::command(rename_all = "snake_case")]
fn native_seek(state: tauri::State<'_, MpvState>, seconds: f64) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, seconds);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        let _ = Mpv::command(&instance.mpv, "seek", &[&seconds.to_string(), "absolute"]);
    }
    Ok(())
    }
}



#[tauri::command(rename_all = "snake_case")]
fn get_subtitle_tracks(state: tauri::State<'_, MpvState>) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        return Ok(serde_json::json!([]));
    }

    #[cfg(target_os = "macos")]
    {
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
}

#[tauri::command(rename_all = "snake_case")]
fn set_subtitle_track(state: tauri::State<'_, MpvState>, sid: i64) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, sid);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
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
}

#[tauri::command(rename_all = "snake_case")]
fn set_subtitle_style(state: tauri::State<'_, MpvState>, scale: Option<f64>, pos: Option<i64>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, scale, pos);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
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
}

#[tauri::command(rename_all = "snake_case")]
fn native_set_volume(state: tauri::State<'_, MpvState>, volume: i64) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, volume);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        instance.mpv.set_property("volume", volume).map_err(|e| e.to_string())?;
    }
    Ok(())
    }
}

#[tauri::command(rename_all = "snake_case")]
fn set_quality_profile(state: tauri::State<'_, MpvState>, profile: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        return Ok(match profile.as_str() {
            "quality" => "quality".to_string(),
            "smooth" => "smooth".to_string(),
            _ => "balanced".to_string(),
        });
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        Ok(apply_quality_profile(&instance.mpv, profile.as_str()))
    } else {
        Ok(match profile.as_str() {
            "quality" => "quality".to_string(),
            "smooth" => "smooth".to_string(),
            _ => "balanced".to_string(),
        })
    }
    }
}

#[tauri::command(rename_all = "snake_case")]
fn native_set_mpv_fullscreen(state: tauri::State<'_, MpvState>, fullscreen: bool) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, fullscreen);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref instance) = *lock {
        let _ = instance.mpv.set_property("fullscreen", fullscreen);
    }
    Ok(())
    }
}

#[tauri::command(rename_all = "snake_case")]
fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
fn native_log(msg: String) {
    println!("[JS-LOG] {}", msg);
}

#[tauri::command(rename_all = "snake_case")]
fn native_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Err("native_toggle_fullscreen is only supported on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
    use tauri::Manager;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = app_for_main.get_webview_window("main").ok_or("Window not found".to_string())?;
            let is_fs = window.is_fullscreen().map_err(|e| e.to_string())?;
            window.set_fullscreen(!is_fs).map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "fullscreen result channel closed".to_string())?
    }
}

#[tauri::command(rename_all = "snake_case")]
fn native_get_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;
    let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = app_for_main.get_webview_window("main").ok_or("Window not found".to_string())?;
            window.is_fullscreen().map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "fullscreen state channel closed".to_string())?
}

#[tauri::command(rename_all = "snake_case")]
fn native_set_fullscreen(app: tauri::AppHandle, fullscreen: bool) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = fullscreen;
        return Err("native_set_fullscreen is only supported on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
    use tauri::Manager;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = app_for_main.get_webview_window("main").ok_or("Window not found".to_string())?;
            window.set_fullscreen(fullscreen).map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "set fullscreen channel closed".to_string())?
    }
}

#[tauri::command(rename_all = "snake_case")]
fn native_get_arch() -> String {
    std::env::consts::ARCH.to_string()
}

#[tauri::command(rename_all = "snake_case")]
fn native_start_drag(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        return Err("native_start_drag is not supported on this platform".to_string());
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
    use tauri::Manager;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = app_for_main.get_webview_window("main").ok_or("Window not found".to_string())?;
            window.start_dragging().map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "drag result channel closed".to_string())?
    }
}

#[cfg_attr(any(target_os = "android", target_os = "ios"), tauri::mobile_entry_point)]
pub fn run() {
    println!("\n\n!!! GDS MOBILE PLAYER - NEW BUILD LOADED !!!\n\n");
    let mut builder = tauri::Builder::default()
        .manage(MpvState(Arc::new(Mutex::new(None))))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            launch_mpv_player,
            close_native_player,
            resize_native_player,
            native_toggle_fullscreen,
            native_get_fullscreen,
            native_set_fullscreen,
            native_get_arch,
            native_start_drag,
            native_play_pause,
            native_seek,
            native_set_volume,
            native_set_mpv_fullscreen,
            set_quality_profile,
            // [NEW] Subtitle Commands
            get_subtitle_tracks,
            set_subtitle_track,
            set_subtitle_style,
            native_sub_add,
            native_sub_reload,
            native_log,
            search_gds,
            ping,
            get_mpv_state
        ]);

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_drag::init());
    }

    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}
