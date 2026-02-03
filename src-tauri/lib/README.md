Place a libmpv dynamic library here for macOS packaging.

Steps (macOS, Intel / Apple Silicon):

1. Install mpv on your system (Homebrew):

   brew install mpv

2. Download the appropriate libmpv wrapper (prebuilt dylib) for your architecture:
   - Apple Silicon (aarch64): libmpv-wrapper-macos-aarch64.zip
   - Intel (x86_64): libmpv-wrapper-macos-x86_64.zip

   The zip should contain a dylib (e.g., libmpv-wrapper.dylib).

3. Rename/copy the dylib into this folder as `libmpv.dylib` (this is the filename the build expects for dynamic linking):

   mv libmpv-wrapper.dylib src-tauri/lib/libmpv.dylib

4. Packaging: `tauri build` will include `src-tauri/lib/libmpv.dylib` in the macOS app bundle (Frameworks). The build script (`build.rs`) will also pick up your system libmpv at link time if `LIBMPV_PATH` is set or Homebrew installed libmpv is available.

Notes:

- If you get link errors during `cargo build`, make sure Homebrew's mpv is installed and accessible (`/opt/homebrew/lib` on Apple Silicon, `/usr/local/lib` on Intel). You can also set LIBMPV_PATH to point to a directory containing the libmpv.dylib:

  export LIBMPV_PATH=/opt/homebrew/lib

- This repository doesn't ship any prebuilt dylibs for licensing reasons — obtain them from the `libmpv-wrapper` project or build libmpv yourself.
