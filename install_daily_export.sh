#!/bin/bash
# ============================================================
# تثبيت التصدير اليومي التلقائي — KGC
# يشغّل daily_export.py كل يوم الساعة 4:30 مساءً عبر launchd،
# ويعمل حتى لو كان المتصفح مغلقاً (يحتاج الجهاز أن يكون شغّالاً).
#
# التشغيل:   bash install_daily_export.sh
# الإلغاء:   bash install_daily_export.sh --uninstall
# ============================================================
set -euo pipefail

LABEL="com.kgc.dailyexport"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/daily_export.py"
# لا تُشغَّل من ~/Downloads: نظام الحماية في macOS يمنع المهام التلقائية من قراءته.
# ننسخ السكربت إلى مجلد غير محمي حتى يعمل بدون أي أذونات إضافية.
INSTALL_DIR="$HOME/Library/Application Support/KGC"
SCRIPT="$INSTALL_DIR/daily_export.py"
LOGDIR="$HOME/Library/Logs"
HOUR=16
MINUTE=30

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$INSTALL_DIR"
  echo "تم إلغاء التصدير التلقائي."
  exit 0
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "لم يُعثر على daily_export.py بجانب هذا الملف: $SOURCE" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$SOURCE" "$SCRIPT"
chmod +x "$SCRIPT"

PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" ]]; then
  echo "python3 غير مثبّت. ثبّته ثم أعد المحاولة." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$SCRIPT</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOGDIR/kgc-export.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/kgc-export.log</string>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLISTEOF

# أعد التحميل حتى لو كان مثبّتاً من قبل
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "تم التثبيت."
echo "  الوقت اليومي : $(printf '%02d:%02d' $HOUR $MINUTE) (4:30 مساءً)"
echo "  السكربت      : $SCRIPT"
echo "  مجلد الحفظ   : ~/Documents/KGC_Reports  (بديل: ~/KGC_Reports)"
echo "  ملف السجل    : $LOGDIR/kgc-export.log"
echo
echo "لتجربته الآن فوراً:"
echo "  launchctl kickstart -k gui/$(id -u)/$LABEL"
