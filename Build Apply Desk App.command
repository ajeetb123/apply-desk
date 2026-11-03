#!/bin/zsh
# Builds Apply Desk.app with its local service bundled inside and installs it
# in /Applications (or ~/Applications when /Applications isn't writable).
set -euo pipefail
ROOT="${0:A:h}"
BUNDLE_ID="com.ajeet.applydesk"
APP_NAME="Apply Desk.app"
DATA="$HOME/Library/Application Support/Apply Desk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Python environment for the bundled service.
if [[ ! -x "$ROOT/.venv/bin/python3" ]]; then
  /usr/bin/python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -q -r "$ROOT/requirements.txt"
fi
BASE_PYTHON="$(/usr/bin/readlink "$ROOT/.venv/bin/python3" || echo "$ROOT/.venv/bin/python3")"
SITE_PACKAGES="$("$ROOT/.venv/bin/python3" -c 'import site; print(site.getsitepackages()[0])')"

APP="$WORK/$APP_NAME"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/backend"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Apply Desk</string>
  <key>CFBundleDisplayName</key><string>Apply Desk</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundleExecutable</key><string>ApplyDesk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Your data stays on this Mac.</string>
  <key>NSAppleEventsUsageDescription</key><string>Apply Desk reads the job listing in Chrome's front tab to score it against your resume, and fills applications when you press Control-Option-F. Everything stays on this Mac.</string>
  <key>ApplyDeskPython</key><string>$BASE_PYTHON</string>
</dict></plist>
PLIST

echo "Compiling the Mac app…"
TARGET="$(/usr/bin/uname -m)-apple-macos14.0"
/usr/bin/swiftc -O -target "$TARGET" -framework AppKit -framework WebKit -framework SwiftUI -framework ServiceManagement -framework Carbon \
  "$ROOT"/macos/*.swift -o "$CONTENTS/MacOS/ApplyDesk"

echo "Drawing the icon…"
/usr/bin/swiftc -O -target "$TARGET" "$ROOT/macos/tools/make_icon.swift" -o "$WORK/make_icon"
"$WORK/make_icon" "$WORK/icon.png"
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z $size $size "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  /usr/bin/sips -z $((size * 2)) $((size * 2)) "$WORK/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"

echo "Bundling the local service…"
cp "$ROOT/app.py" "$RESOURCES/backend/"
/usr/bin/ditto "$ROOT/templates" "$RESOURCES/backend/templates"
/usr/bin/ditto "$ROOT/static" "$RESOURCES/backend/static"
/usr/bin/rsync -a --exclude '__pycache__' --exclude 'pip' --exclude 'pip-*' --exclude 'setuptools' --exclude 'setuptools-*' \
  --exclude 'pkg_resources' --exclude '_distutils_hack' --exclude '*.pth' "$SITE_PACKAGES/" "$RESOURCES/backend/site-packages/"
# Precompile so the signed bundle never needs to write bytecode.
"$BASE_PYTHON" -m compileall -q "$RESOURCES/backend" >/dev/null || true

/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null

# Stop the running app and any older Terminal-started service before replacing it.
if /usr/bin/pgrep -qf "$APP_NAME/Contents/MacOS/ApplyDesk"; then
  /usr/bin/osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for attempt in {1..20}; do /usr/bin/pgrep -qf "$APP_NAME/Contents/MacOS/ApplyDesk" || break; /bin/sleep 0.25; done
fi
for pid in $(/usr/sbin/lsof -ti tcp:8787 -sTCP:LISTEN 2>/dev/null); do
  if /bin/ps -o command= -p "$pid" | /usr/bin/grep -q "app.py"; then /bin/kill "$pid" 2>/dev/null || true; fi
done

INSTALL_DIR="/Applications"
[[ -w "$INSTALL_DIR" ]] || INSTALL_DIR="$HOME/Applications"
mkdir -p "$INSTALL_DIR"
TARGET_APP="$INSTALL_DIR/$APP_NAME"
if [[ -d "$TARGET_APP" ]]; then
  EXISTING_ID="$(/usr/bin/defaults read "$TARGET_APP/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [[ "$EXISTING_ID" != "$BUNDLE_ID" ]]; then
    echo "A different app is already installed at $TARGET_APP; leaving it alone." >&2
    exit 1
  fi
  rm -rf "$TARGET_APP"
fi
/usr/bin/ditto "$APP" "$TARGET_APP"
# Builds before version 2 lived in the project folder.
if [[ -d "$ROOT/$APP_NAME" ]]; then rm -rf "$ROOT/$APP_NAME"; fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET_APP" >/dev/null 2>&1 || true

# Carry over data saved by the Terminal-started version.
mkdir -p "$DATA"
if [[ ! -f "$DATA/resume_tailor.sqlite3" && -f "$ROOT/instance/resume_tailor.sqlite3" ]]; then
  cp "$ROOT/instance/resume_tailor.sqlite3" "$DATA/"
  echo "Copied your saved data to $DATA"
fi

echo "Installed $TARGET_APP"
