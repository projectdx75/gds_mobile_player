use std::env;
use std::path::PathBuf;

fn push_unique(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.iter().any(|p| p == &candidate) {
        paths.push(candidate);
    }
}

fn preferred_homebrew_prefixes() -> Vec<PathBuf> {
    if env::consts::ARCH == "x86_64" {
        vec![PathBuf::from("/usr/local"), PathBuf::from("/opt/homebrew")]
    } else {
        vec![PathBuf::from("/opt/homebrew"), PathBuf::from("/usr/local")]
    }
}

fn detect_homebrew_lib_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(prefix) = env::var_os("HOMEBREW_PREFIX") {
        let lib_dir = PathBuf::from(prefix).join("lib");
        if lib_dir.exists() {
            push_unique(&mut dirs, lib_dir);
        }
    }

    for prefix in preferred_homebrew_prefixes() {
        let lib_dir = prefix.join("lib");
        if lib_dir.exists() {
            push_unique(&mut dirs, lib_dir);
        }
    }

    if dirs.is_empty() {
        for prefix in preferred_homebrew_prefixes() {
            push_unique(&mut dirs, prefix.join("lib"));
        }
    }

    dirs
}

fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-env-changed=MPV_LINK_MODE");
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let link_mode = env::var("MPV_LINK_MODE").unwrap_or_else(|_| "framework".to_string());
        println!("cargo:warning=MPV_LINK_MODE={}", link_mode);
        let lib_dir = manifest_dir.join("lib");
        let framework_search_path = lib_dir.join("Libmpv.xcframework/macos-arm64_x86_64");
        let brew_lib_dirs = detect_homebrew_lib_dirs();

        if link_mode == "system" {
            // Quick diagnostic mode: link against Homebrew libmpv dylib.
            let homebrew_lib = brew_lib_dirs
                .first()
                .cloned()
                .unwrap_or_else(|| PathBuf::from("/opt/homebrew/lib"));
            println!("cargo:warning=Linking against system libmpv from: {}", homebrew_lib.display());
            println!("cargo:rustc-link-search=native={}", homebrew_lib.display());
            println!("cargo:rustc-link-lib=dylib=mpv");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", homebrew_lib.display());
        } else {
            // Default: project-local framework
            println!("cargo:warning=Linking against Universal Libmpv.framework at: {}", framework_search_path.display());
            println!("cargo:rustc-link-search=framework={}", framework_search_path.display());
            println!("cargo:rustc-link-lib=framework=Libmpv");
            println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_search_path.display());
        }

        
        // Link system frameworks required by libmpv
        println!("cargo:rustc-link-lib=framework=CoreVideo");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=AudioUnit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=VideoToolbox");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreServices");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=Metal");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rustc-link-lib=c++");
        
        // Resolve Undefined Vulkan Symbols (MoltenVK) - LOCAL LINK ONLY
        // [FIX] Removed system search paths (/opt/homebrew/lib) preventing system libmpv linkage
        // [FIX] Added 'lib_deps' for selective linking of other Homebrew libs (ffmpeg, etc.) without exposing libmpv
        let lib_deps_dir = manifest_dir.join("lib_deps");
        println!("cargo:rustc-link-search=native={}", lib_deps_dir.display());
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        for path in &brew_lib_dirs {
            println!("cargo:warning=Using Homebrew lib search path: {}", path.display());
            println!("cargo:rustc-link-search=native={}", path.display());
        }
        if link_mode != "system" {
            // Link Vulkan loader first (libvulkan), then MoltenVK ICD.
            // On Intel macOS this resolves vk* symbols referenced by Libmpv.
            println!("cargo:rustc-link-lib=dylib=vulkan");
            println!("cargo:rustc-link-lib=dylib=MoltenVK");
        }
        
        // Resolve other dependencies referenced by Libmpv (Homebrew)
        println!("cargo:rustc-link-lib=dylib=uchardet");
        println!("cargo:rustc-link-lib=dylib=ass");
        
        // Resolve FFmpeg dependencies
        println!("cargo:rustc-link-lib=dylib=avcodec");
        println!("cargo:rustc-link-lib=dylib=avdevice");
        println!("cargo:rustc-link-lib=dylib=avfilter");
        println!("cargo:rustc-link-lib=dylib=avformat");
        println!("cargo:rustc-link-lib=dylib=avutil");
        println!("cargo:rustc-link-lib=dylib=swresample");
        println!("cargo:rustc-link-lib=dylib=swscale");
        
        // Resolve libplacebo (gpu-next) dependencies
        println!("cargo:rustc-link-lib=dylib=placebo");
        println!("cargo:rustc-link-lib=dylib=lcms2");
        println!("cargo:rustc-link-lib=dylib=shaderc_shared"); // often needed by placebo
        
        // Resolve Scripting & Subtitles & Formats
        println!("cargo:rustc-link-lib=dylib=luajit-5.1");
        println!("cargo:rustc-link-lib=dylib=fribidi");
        println!("cargo:rustc-link-lib=dylib=harfbuzz");
        println!("cargo:rustc-link-lib=dylib=freetype");
        println!("cargo:rustc-link-lib=dylib=bluray");
        println!("cargo:rustc-link-lib=dylib=z");
        println!("cargo:rustc-link-lib=dylib=iconv");
        println!("cargo:rustc-link-lib=dylib=bz2");

        // Explicitly link Foundation for os.Logger and others
        println!("cargo:rustc-link-lib=framework=Foundation");

        // Resolve Swift Runtime
        println!("cargo:rustc-link-search=native=/usr/lib/swift");
        // Only use Xcode toolchain for linker search if absolutely necessary, but DO NOT add it to RPATH to avoid runtime crash
        println!("cargo:rustc-link-search=native=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.0/macosx");
        
        // Add rpath so the binary can find libswiftCore.dylib at runtime
        // ONLY use system path for runtime to avoid "requires an OS version prior to 10.14.4" error
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        
        // Add custom Xcode toolchain path for static compatibility libs if needed
        println!("cargo:rustc-link-search=native=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx");
        // [FIX] Add CommandLineTools path found on user system
        println!("cargo:rustc-link-search=native=/Library/Developer/CommandLineTools/usr/lib/swift/macosx");
        
        // [FIX] Explicitly link Swift Compatibility libraries required by Libmpv.framework
        println!("cargo:rustc-link-lib=static=swiftCompatibility56");
        println!("cargo:rustc-link-lib=static=swiftCompatibilityConcurrency");
    }
}
