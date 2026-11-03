#!/bin/zsh
set -e
ROOT="${0:A:h}"
APP="$ROOT/Apply Desk.app"
CONTENTS="$APP/Contents"
/usr/bin/osascript -e 'tell application id "com.ajeet.applydesk" to quit' >/dev/null 2>&1 || true
/bin/sleep 0.25
mkdir -p "$CONTENTS/MacOS"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Apply Desk</string>
  <key>CFBundleDisplayName</key><string>Apply Desk</string>
  <key>CFBundleIdentifier</key><string>com.ajeet.applydesk</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>ApplyDesk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSAppleEventsUsageDescription</key><string>Apply Desk reads the active job listing in Chrome so it can match the role against your resume locally.</string>
</dict></plist>
PLIST
/usr/bin/swiftc -O -framework AppKit -framework Foundation -framework WebKit "$ROOT/macos/main.swift" "$ROOT/macos/ApplyDeskMenuBar.swift" -o "$CONTENTS/MacOS/ApplyDesk"
/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null
echo "Built $APP"
