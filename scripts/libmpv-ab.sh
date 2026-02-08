#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="$ROOT_DIR/src-tauri/lib"
TARGET_XCFRAMEWORK="$LIB_DIR/Libmpv.xcframework"
BACKUP_DIR="$LIB_DIR/.ab_libmpv_backups"
SNAPSHOT_DIR="$BACKUP_DIR/snapshots"

usage() {
  cat <<USAGE
Usage:
  scripts/libmpv-ab.sh register <all|gpl> <zip_or_xcframework_path>
  scripts/libmpv-ab.sh switch <orig|all|gpl>
  scripts/libmpv-ab.sh status
  scripts/libmpv-ab.sh check

Examples:
  scripts/libmpv-ab.sh register all ~/Downloads/libmpv-all.zip
  scripts/libmpv-ab.sh register gpl ~/Downloads/libmpv-GPL-all.zip
  scripts/libmpv-ab.sh switch all
  scripts/libmpv-ab.sh check
USAGE
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

ensure_dirs() {
  mkdir -p "$SNAPSHOT_DIR"
}

current_binary_path() {
  local p1="$TARGET_XCFRAMEWORK/macos-arm64_x86_64/Libmpv.framework/Versions/A/Libmpv"
  local p2="$TARGET_XCFRAMEWORK/macos-arm64_x86_64/Libmpv.framework/Libmpv"
  if [[ -f "$p1" ]]; then
    echo "$p1"
    return 0
  fi
  if [[ -f "$p2" ]]; then
    echo "$p2"
    return 0
  fi
  return 1
}

snapshot_binary_path() {
  local name="$1"
  local base="$SNAPSHOT_DIR/$name/Libmpv.xcframework/macos-arm64_x86_64/Libmpv.framework"
  if [[ -f "$base/Versions/A/Libmpv" ]]; then
    echo "$base/Versions/A/Libmpv"
    return 0
  fi
  if [[ -f "$base/Libmpv" ]]; then
    echo "$base/Libmpv"
    return 0
  fi
  return 1
}

snapshot_exists() {
  local name="$1"
  [[ -d "$SNAPSHOT_DIR/$name/Libmpv.xcframework" ]]
}

save_orig_if_missing() {
  if ! snapshot_exists orig; then
    echo "[INFO] Capturing current Libmpv.xcframework as snapshot: orig"
    mkdir -p "$SNAPSHOT_DIR/orig"
    rm -rf "$SNAPSHOT_DIR/orig/Libmpv.xcframework"
    cp -R "$TARGET_XCFRAMEWORK" "$SNAPSHOT_DIR/orig/Libmpv.xcframework"
  fi
}

extract_xcframework_to() {
  local src="$1"
  local outdir="$2"

  if [[ -d "$src" && "$(basename "$src")" == "Libmpv.xcframework" ]]; then
    cp -R "$src" "$outdir/Libmpv.xcframework"
    return 0
  fi

  if [[ -f "$src" ]]; then
    local tmp
    tmp="$(mktemp -d)"

    if [[ "$src" == *.zip ]]; then
      unzip -q "$src" -d "$tmp"
    else
      rm -rf "$tmp"
      fail "Unsupported input file: $src (expected .zip or Libmpv.xcframework directory)"
    fi

    local found
    found="$(find "$tmp" -type d -name 'Libmpv.xcframework' | head -n 1 || true)"
    if [[ -z "$found" ]]; then
      if find "$tmp" -type f | rg -q '/lib/macos/thin/.*/lib/libmpv\.a$'; then
        rm -rf "$tmp"
        fail "This archive appears to be static lib bundle (libmpv-all/libmpv-GPL-all), not Libmpv.xcframework. Use release asset 'Libmpv.xcframework.zip' (or 'Libmpv-GPL.xcframework.zip')."
      fi
      rm -rf "$tmp"
      fail "Could not find Libmpv.xcframework inside: $src"
    fi

    cp -R "$found" "$outdir/Libmpv.xcframework"
    rm -rf "$tmp"
    return 0
  fi

  fail "Input not found: $src"
}

cmd_register() {
  local variant="${1:-}"
  local src="${2:-}"

  [[ "$variant" == "all" || "$variant" == "gpl" ]] || fail "register variant must be all|gpl"
  [[ -n "$src" ]] || fail "register requires <zip_or_xcframework_path>"

  ensure_dirs
  save_orig_if_missing

  local dst="$SNAPSHOT_DIR/$variant"
  rm -rf "$dst"
  mkdir -p "$dst"

  echo "[INFO] Registering snapshot '$variant' from: $src"
  extract_xcframework_to "$src" "$dst"

  local bin
  bin="$(snapshot_binary_path "$variant")" || fail "Registered snapshot '$variant' is missing macOS Libmpv binary"
  echo "[INFO] Snapshot '$variant' binary: $bin"
  file "$bin"
}

cmd_switch() {
  local variant="${1:-}"
  [[ "$variant" == "orig" || "$variant" == "all" || "$variant" == "gpl" ]] || fail "switch variant must be orig|all|gpl"

  ensure_dirs
  snapshot_exists "$variant" || fail "Snapshot '$variant' not found. Run register first."

  echo "[INFO] Switching active Libmpv.xcframework -> $variant"
  rm -rf "$TARGET_XCFRAMEWORK"
  cp -R "$SNAPSHOT_DIR/$variant/Libmpv.xcframework" "$TARGET_XCFRAMEWORK"

  local bin
  bin="$(current_binary_path)" || fail "Active Libmpv binary not found after switch"
  echo "[INFO] Active binary: $bin"
  file "$bin"
}

cmd_status() {
  ensure_dirs

  echo "[INFO] Project: $ROOT_DIR"
  echo "[INFO] Target:  $TARGET_XCFRAMEWORK"

  if [[ -d "$TARGET_XCFRAMEWORK" ]]; then
    local bin
    if bin="$(current_binary_path)"; then
      echo "[INFO] Active binary:"
      echo "  $bin"
      file "$bin"
    else
      echo "[WARN] Active Libmpv binary not found under macos-arm64_x86_64"
    fi
  else
    echo "[WARN] Target Libmpv.xcframework does not exist"
  fi

  echo "[INFO] Snapshots:"
  for n in orig all gpl; do
    if snapshot_exists "$n"; then
      echo "  - $n (ready)"
    else
      echo "  - $n (missing)"
    fi
  done
}

cmd_check() {
  echo "[INFO] Running cargo check"
  (cd "$ROOT_DIR/src-tauri" && cargo check)
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    register)
      shift
      cmd_register "$@"
      ;;
    switch)
      shift
      cmd_switch "$@"
      ;;
    status)
      cmd_status
      ;;
    check)
      cmd_check
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      fail "Unknown command: $cmd"
      ;;
  esac
}

main "$@"
