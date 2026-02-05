use std::env;
use std::path::PathBuf;

fn main() {
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        
        let lib_dir = manifest_dir.join("lib");
        
        // [FIX] Use Universal Framework (ARM64 + x86_64) instead of static lib
        let framework_search_path = lib_dir.join("Libmpv.xcframework/macos-arm64_x86_64");
        
        // [FIX] Link Local Libmpv Framework FIRST
        println!("cargo:warning=Linking against Universal Libmpv.framework at: {}", framework_search_path.display());
        // Use -F to specify framework search path explicitly
        println!("cargo:rustc-link-search=framework={}", framework_search_path.display());
        println!("cargo:rustc-link-lib=framework=Libmpv");
        
        // Ensure runtime finding
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_search_path.display());

        
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
        println!("cargo:rustc-link-lib=dylib=MoltenVK");
        
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
