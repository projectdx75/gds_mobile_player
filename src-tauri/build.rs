use std::env;
use std::path::PathBuf;

fn main() {
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        
        // Target specific architecture inside xcframework
        // Adjust this path if you are on x86_64, but typically macos-arm64_x86_64 covers both.
        let framework_path = manifest_dir.join("lib/Libmpv.xcframework/macos-arm64_x86_64");
        
        if framework_path.exists() {
            println!("cargo:warning=Forcing Local Libmpv Framework from: {}", framework_path.display());
            println!("cargo:rustc-link-search=framework={}", framework_path.display());
            println!("cargo:rustc-link-lib=framework=Libmpv");
            
            // ALSO add native search path for the 'lib' dir where libmpv.dylib might be, to satisfy -lmpv
            let lib_dir = manifest_dir.join("lib");
            if lib_dir.join("libmpv.dylib").exists() {
                 println!("cargo:warning=Found libmpv.dylib in lib dir, adding to native search path to satisfy -lmpv");
                 println!("cargo:rustc-link-search=native={}", lib_dir.display());
            }

            // Allow @rpath to find it at runtime
            println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks");
             // Also add the build dir to rpath so cargo run works
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", framework_path.display());

        } else {
             println!("cargo:warning=LOCAL FRAMEWORK NOT FOUND AT: {}", framework_path.display());
             panic!("Local Libmpv.xcframework is missing! Cannot proceed with embedding fix.");
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
        println!("cargo:rustc-link-lib=framework=Metal"); // For Metal
        println!("cargo:rustc-link-lib=framework=QuartzCore"); // For CAMetalLayer
        println!("cargo:rustc-link-lib=c++");
        
        // Resolve Undefined Vulkan Symbols (MoltenVK from Homebrew)
        println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
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
        println!("cargo:rustc-link-lib=dylib=jpeg");
        
        println!("cargo:rustc-link-lib=dylib=z");
        println!("cargo:rustc-link-lib=dylib=iconv");
        println!("cargo:rustc-link-lib=dylib=bz2");
        
        // Resolve Swift Runtime (required by Libmpv if built with Swift)
        println!("cargo:rustc-link-search=native=/usr/lib/swift");
        // Add custom Xcode toolchain path for static compatibility libs
        println!("cargo:rustc-link-search=native=/Volumes/WD/Users/Applications/Xcode-26.2.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx");
    }
}
