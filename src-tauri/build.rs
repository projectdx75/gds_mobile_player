use std::env;
use std::path::PathBuf;

fn main() {
    #[cfg(target_os = "macos")]
    {
        // Prefer local prebuilt Libmpv.framework from src-tauri/lib (extracted xcframework)
        let workspace_framework = std::path::PathBuf::from("src-tauri/lib/Libmpv.xcframework/macos-arm64_x86_64/Libmpv.framework");
        if workspace_framework.exists() {
            println!("cargo:rustc-link-search=framework={}", workspace_framework.display());
            println!("cargo:rustc-link-lib=framework=Libmpv");
            println!("cargo:warning=Using Libmpv.framework from src-tauri/lib (prebuilt)");
        } else {
            // Use brew-installed mpv from deus0ww/tap for embedding
            // This provides optimized libmpv with all dependencies included
            let libmpv_path = env::var("LIBMPV_PATH")
                .unwrap_or_else(|_| "/opt/homebrew/opt/mpv/lib".to_string());
            
            let libmpv_path_buf = std::path::PathBuf::from(&libmpv_path);
            let framework_candidate = libmpv_path_buf.join("Libmpv.framework");
            
            if framework_candidate.exists() {
                // Use framework if available
                println!("cargo:rustc-link-search=framework={}", framework_candidate.display());
                println!("cargo:rustc-link-search=native={}", libmpv_path);
                println!("cargo:rustc-link-lib=framework=Libmpv");
                println!("cargo:warning=Using Libmpv.framework at {}", framework_candidate.display());
            } else if libmpv_path_buf.join("libmpv.2.dylib").exists() || libmpv_path_buf.exists() {
                // Use dynamic library
                println!("cargo:rustc-link-search=native={}", libmpv_path);
                println!("cargo:rustc-link-lib=mpv");
                println!("cargo:rustc-env=PKG_CONFIG_PATH={}/pkgconfig", libmpv_path);
                println!("cargo:warning=Using libmpv from {}", libmpv_path);
            } else {
                println!("cargo:warning=LIBMPV_PATH {} does not contain Libmpv.framework or libmpv.2.dylib", libmpv_path);
            }
        }
        
        // Set rpath to find libmpv in the app bundle
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        
        // Link against additional frameworks that libmpv depends on
        println!("cargo:rustc-link-lib=framework=CoreVideo");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=AudioUnit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=VideoToolbox");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreServices");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
    }
}
