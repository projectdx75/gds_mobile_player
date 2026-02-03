#!/bin/bash

# Bundle Libmpv framework into the app bundle
# This script is called by Tauri's afterBundleCommand

set -e

CONFIG="$1"
BUNDLE_PATH="$2"

# Get the workspace directory (parent of src-tauri)
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
XCFRAMEWORK_PATH="$WORKSPACE_DIR/Libmpv-GPL.xcframework/Libmpv.xcframework"
MACOS_FRAMEWORK_PATH="$XCFRAMEWORK_PATH/macos-arm64_x86_64/Libmpv.framework"

echo "[BUNDLE] Config: $CONFIG"
echo "[BUNDLE] Bundle path: $BUNDLE_PATH"
echo "[BUNDLE] Workspace: $WORKSPACE_DIR"

if [ ! -d "$MACOS_FRAMEWORK_PATH" ]; then
    echo "[BUNDLE] ERROR: Libmpv.framework not found at $MACOS_FRAMEWORK_PATH"
    exit 1
fi

# Create Frameworks directory in the app bundle
FRAMEWORKS_DIR="$BUNDLE_PATH/Contents/Frameworks"
mkdir -p "$FRAMEWORKS_DIR"

echo "[BUNDLE] Copying Libmpv.framework to $FRAMEWORKS_DIR"

# Copy the framework
cp -R "$MACOS_FRAMEWORK_PATH" "$FRAMEWORKS_DIR/"

# Fix the framework's Info.plist to remove any absolute paths
INFO_PLIST="$FRAMEWORKS_DIR/Libmpv.framework/Versions/A/Resources/Info.plist"
if [ -f "$INFO_PLIST" ]; then
    # Remove absolute paths from Info.plist if present
    sed -i '' 's|'"$WORKSPACE_DIR"'||g' "$INFO_PLIST"
fi

echo "[BUNDLE] Libmpv.framework bundled successfully"
