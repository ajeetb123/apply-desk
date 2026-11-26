#!/bin/zsh
# Builds Apply Desk.app with its local service bundled inside and installs it
# in /Applications (or ~/Applications when /Applications isn't writable).
# With --package it builds the downloadable copy instead: its own Python
# inside (no developer tools needed), zipped into dist/ for a GitHub release,
# and nothing installed.
set -euo pipefail
ROOT="${0:A:h}"
PACKAGE=0
[[ "${1:-}" == "--package" ]] && PACKAGE=1
VERSION="2.8"
BUILD="12"
BUNDLE_ID="com.ajeet.applydesk"
APP_NAME="Apply Desk.app"
DATA="$HOME/Library/Application Support/Apply Desk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if (( PACKAGE )); then
  # A standalone Python (astral-sh/python-build-standalone), pinned and checked
  # against its published SHA-256, so the app runs on Macs without developer tools.
  PY_NAME="cpython-3.12.16+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz"
  PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-aarch64-apple-darwin-install_only_stripped.tar.gz"
  PY_SHA256="353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e"
  CACHE="$ROOT/.cache"
  mkdir -p "$CACHE"
  if [[ ! -f "$CACHE/$PY_NAME" ]]; then
    echo "Downloading Python…"
    /usr/bin/curl -fsSL -o "$CACHE/$PY_NAME.part" "$PY_URL"
    mv "$CACHE/$PY_NAME.part" "$CACHE/$PY_NAME"
  fi
  if ! echo "$PY_SHA256  $CACHE/$PY_NAME" | /usr/bin/shasum -a 256 -c - >/dev/null 2>&1; then
    rm -f "$CACHE/$PY_NAME"
    echo "The Python download doesn't match its checksum; nothing was built." >&2
    exit 1
  fi
  PYTHON_KEY=""
else
  # Python environment for the bundled service.
  if [[ ! -x "$ROOT/.venv/bin/python3" ]]; then
    /usr/bin/python3 -m venv "$ROOT/.venv"
    "$ROOT/.venv/bin/pip" install -q -r "$ROOT/requirements.txt"
  fi
  BASE_PYTHON="$(/usr/bin/readlink "$ROOT/.venv/bin/python3" || echo "$ROOT/.venv/bin/python3")"
  SITE_PACKAGES="$("$ROOT/.venv/bin/python3" -c 'import site; print(site.getsitepackages()[0])')"
  PYTHON_KEY="<key>ApplyDeskPython</key><string>$BASE_PYTHON</string>"
fi

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
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>ApplyDesk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Your data stays on this Mac.</string>
  <key>NSAppleEventsUsageDescription</key><string>Apply Desk reads the job listing in Chrome's front tab to score it against your resume, and fills applications when you press the \` key (under Esc). Everything stays on this Mac.</string>
  $PYTHON_KEY
</dict></plist>
PLIST

echo "Compiling the Mac app…"
# The downloadable copy is for Apple Silicon, like the Python inside it.
TARGET="$( (( PACKAGE )) && echo arm64 || /usr/bin/uname -m)-apple-macos14.0"
/usr/bin/swiftc -O -target "$TARGET" -framework AppKit -framework WebKit -framework SwiftUI -framework ServiceManagement -framework Carbon \
  "$ROOT"/macos/*.swift -o "$CONTENTS/MacOS/ApplyDesk"
/usr/bin/swiftc -O -target "$TARGET" "$ROOT/macos/tools/pdftext.swift" -o "$CONTENTS/MacOS/pdftext"

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
cp "$ROOT/app.py" "$ROOT/tailoring.py" "$ROOT/applying.py" "$RESOURCES/backend/"
cp "$ROOT/macos/autofill.js" "$ROOT/macos/batch.js" "$ROOT/macos/account.js" "$RESOURCES/"
/usr/bin/ditto "$ROOT/templates" "$RESOURCES/backend/templates"
/usr/bin/ditto "$ROOT/static" "$RESOURCES/backend/static"
if (( PACKAGE )); then
  /usr/bin/tar -xzf "$CACHE/$PY_NAME" -C "$RESOURCES"   # → Resources/python
  "$RESOURCES/python/bin/python3" -m pip install --quiet --no-cache-dir --disable-pip-version-check --only-binary=:all: \
    --target "$RESOURCES/backend/site-packages" -r "$ROOT/requirements.txt"
  # What the service never uses: pip, the test suite, and Tk.
  STDLIB="$RESOURCES/python/lib/python3.12"
  setopt null_glob   # a pattern that matches nothing is simply skipped
  rm -rf "$RESOURCES/backend/site-packages/bin" "$STDLIB/site-packages/"pip* "$STDLIB/ensurepip" "$STDLIB/idlelib" "$STDLIB/tkinter" \
    "$STDLIB/turtledemo" "$STDLIB/test" "$STDLIB/lib-dynload/"_tkinter* "$RESOURCES/python/lib/"{tcl,tk,itcl,thread,libtcl,libtk}* "$RESOURCES/python/share"
  /usr/bin/find "$RESOURCES" -name '__pycache__' -type d -prune -exec rm -rf {} +
else
  /usr/bin/rsync -a --exclude '__pycache__' --exclude 'pip' --exclude 'pip-*' --exclude 'setuptools' --exclude 'setuptools-*' \
    --exclude 'pkg_resources' --exclude '_distutils_hack' --exclude '*.pth' "$SITE_PACKAGES/" "$RESOURCES/backend/site-packages/"
fi

# Ad-hoc signatures change with every build, which makes macOS forget (or
# silently refuse) Automation access to Chrome. Pinning the designated
# requirement to the bundle ID keeps that permission across rebuilds.
# The PDF helper is signed on its own first, so the app's seal records its final form.
/usr/bin/codesign --force --sign - --identifier "$BUNDLE_ID.pdftext" "$CONTENTS/MacOS/pdftext" >/dev/null
if (( PACKAGE )); then
  # Every program and library inside gets its own signature before the app's seal.
  /usr/bin/find "$RESOURCES" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 |
    while IFS= read -r -d '' file; do
      if /usr/bin/file -b "$file" | /usr/bin/grep -q 'Mach-O'; then /usr/bin/codesign --force --sign - "$file" >/dev/null 2>&1; fi
    done
fi
/usr/bin/codesign --force --sign - -r="designated => identifier \"$BUNDLE_ID\"" "$APP" >/dev/null

if (( PACKAGE )); then
  DIST="$ROOT/dist"
  ZIP="$DIST/Apply-Desk-$VERSION-mac-arm64.zip"
  mkdir -p "$DIST"
  rm -f "$ZIP" "$ZIP.sha256"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  (cd "$DIST" && /usr/bin/shasum -a 256 "${ZIP:t}" > "${ZIP:t}.sha256")
  echo "Packaged $ZIP ($(/usr/bin/du -h "$ZIP" | /usr/bin/cut -f1))"
  exit 0
fi

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
