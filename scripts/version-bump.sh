#!/bin/bash
# Auto-increment patch version before Android build
# Usage: ./scripts/version-bump.sh

CONF_FILE="src-tauri/tauri.conf.json"
PKG_FILE="package.json"

# Extract current version from tauri.conf.json
CURRENT_VERSION=$(grep '"version":' "$CONF_FILE" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')

# Split version into parts
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Increment patch
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

echo "📦 Version bump: $CURRENT_VERSION → $NEW_VERSION"

# Update tauri.conf.json
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$CONF_FILE"

# Update package.json
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PKG_FILE"

# Update Cargo.toml
CARGO_FILE="src-tauri/Cargo.toml"
if [ -f "$CARGO_FILE" ]; then
  sed -i '' "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" "$CARGO_FILE"
  echo "✅ Updated Cargo.toml to v$NEW_VERSION"
fi

echo "✅ Updated all to v$NEW_VERSION"
