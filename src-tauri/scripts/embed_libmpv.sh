#!/bin/bash

# Embed libmpv into the app bundle
# This script copies libmpv from homebrew into the app bundle and updates the dylib paths

set -e

APP_PATH="$1"

if [ -z "$APP_PATH" ]; then
    echo "Usage: $0 <path to .app>"
    exit 1
fi

echo "[EMBED] Embedding libmpv into $APP_PATH"

# Create Frameworks directory if it doesn't exist
FRAMEWORKS_DIR="$APP_PATH/Contents/Frameworks"
mkdir -p "$FRAMEWORKS_DIR"

# Find libmpv in homebrew
LIBMPV_SOURCE="/opt/homebrew/opt/mpv/lib/libmpv.2.dylib"

if [ ! -f "$LIBMPV_SOURCE" ]; then
    echo "[EMBED] ERROR: libmpv not found at $LIBMPV_SOURCE"
    echo "[EMBED] Please install mpv using: brew install mpv"
    exit 1
fi

# Copy libmpv to Frameworks directory
LIBMPV_DEST="$FRAMEWORKS_DIR/libmpv.2.dylib"
echo "[EMBED] Copying $LIBMPV_SOURCE to $LIBMPV_DEST"

# Remove existing file if present
if [ -f "$LIBMPV_DEST" ]; then
    rm -f "$LIBMPV_DEST"
fi

cp "$LIBMPV_SOURCE" "$LIBMPV_DEST"

# Copy all dependencies of libmpv
echo "[EMBED] Copying dependencies..."

# Get list of dependencies (excluding libmpv itself)
DEPS=$(otool -L "$LIBMPV_SOURCE" | awk '/opt\/homebrew/ && !/libmpv/ {print $1}')

for dep in $DEPS; do
    if [ -f "$dep" ]; then
        dep_name=$(basename "$dep")
        dep_dest="$FRAMEWORKS_DIR/$dep_name"
        
        # Remove existing file if present
        if [ -f "$dep_dest" ]; then
            rm -f "$dep_dest"
        fi
        
        echo "[EMBED] Copying dependency: $dep_name"
        cp "$dep" "$dep_dest"
    fi
done

# Strip debug symbols to reduce size
echo "[EMBED] Stripping debug symbols..."
strip -x "$LIBMPV_DEST"
for dep in $DEPS; do
    if [ -f "$dep" ]; then
        dep_name=$(basename "$dep")
        dep_dest="$FRAMEWORKS_DIR/$dep_name"
        if [ -f "$dep_dest" ]; then
            strip -x "$dep_dest"
        fi
    fi
done

# Update main binary's libmpv reference
BINARY="$APP_PATH/Contents/MacOS/flashplex"
echo "[EMBED] Updating dylib references in $BINARY"

# Change libmpv reference to use @executable_path
install_name_tool -change \
    "/opt/homebrew/opt/mpv/lib/libmpv.2.dylib" \
    "@executable_path/../Frameworks/libmpv.2.dylib" \
    "$BINARY"

# Update dependencies in libmpv.dylib
for dep in $DEPS; do
    if [ -f "$dep" ]; then
        dep_name=$(basename "$dep")
        install_name_tool -change \
            "$dep" \
            "@executable_path/../Frameworks/$dep_name" \
            "$LIBMPV_DEST"
    fi
done

echo "[EMBED] libmpv embedded successfully"
