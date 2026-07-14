#!/bin/bash

# סקריפט התקנה והגדרה עבור כריית RandomX (Monero) ותשלום בביטקוין
# הסקריפט יוצר תיקייה נפרדת לחלוטין בשולחן העבודה ומגדיר את כל הדרוש.

echo "=================================================="
echo "🔧 מתחיל בהתקנת כריית מעבד חכמה (RandomX -> BTC)"
echo "=================================================="

DESKTOP_DIR="/home/avivderi/שולחן העבודה"
TARGET_DIR="$(cd "$(dirname "$0")" && pwd)/xmrig-miner"
BTC_ADDRESS="bc1qwm58u3zaf63f0dx63qk5p867kps26ykf3uylcs"
WORKER_NAME="nodejs-worker"

# 1. יצירת תיקייה ייעודית
echo "📂 יוצר תיקייה חדשה: $TARGET_DIR..."
mkdir -p "$TARGET_DIR"

# 2. הורדת XMRig
echo "📥 מוריד את תוכנת הכרייה XMRig (v6.26.0)..."
TEMP_TAR="$TARGET_DIR/xmrig.tar.gz"
wget -O "$TEMP_TAR" "https://github.com/xmrig/xmrig/releases/download/v6.26.0/xmrig-6.26.0-linux-static-x64.tar.gz"

if [ ! -f "$TEMP_TAR" ]; then
    echo "❌ שגיאה בהורדת XMRig. אנא ודא שיש חיבור לאינטרנט."
    exit 1
fi

# 3. חילוץ התוכנה
echo "📦 מחלץ קבצים..."
tar -xvf "$TEMP_TAR" -C "$TARGET_DIR" --strip-components=1
rm "$TEMP_TAR"

# 4. כתיבת קובץ הגדרות config.json
echo "⚙️ מגדיר קובץ קונפיגורציה..."
cat <<EOF > "$TARGET_DIR/config.json"
{
    "api": {
        "id": null,
        "worker-id": null
    },
    "http": {
        "enabled": false,
        "host": "127.0.0.1",
        "port": 0,
        "access-token": null,
        "restricted": true
    },
    "autosave": true,
    "background": false,
    "colors": true,
    "title": true,
    "randomx": {
        "init": -1,
        "init-avx2": -1,
        "mode": "auto",
        "1gb-pages": false,
        "rdmsr": true,
        "wrmsr": true,
        "cache_qos": false,
        "numa": true,
        "scratchpad-prefetch-mode": 1
    },
    "cpu": {
        "enabled": true,
        "huge-pages": true,
        "huge-pages-jit": false,
        "hw-aes": null,
        "priority": null,
        "memory-pool": false,
        "yield": true,
        "asm": true
    },
    "pools": [
        {
            "algo": "rx/0",
            "coin": null,
            "url": "rx.unmineable.com:3333",
            "user": "BTC:$BTC_ADDRESS.$WORKER_NAME",
            "pass": "x",
            "rig-id": null,
            "nicehash": false,
            "keepalive": true,
            "enabled": true,
            "tls": false,
            "tls-fingerprint": null,
            "daemon": false,
            "socks5": null,
            "self-select": null,
            "submit-to-origin": false
        }
    ]
}
EOF

# 5. יצירת סקריפט הפעלה start-xmrig.sh
echo "📜 יוצר סקריפט הרצה עם הרשאות מנהל (בשביל ביצועים מקסימליים)..."
cat <<'EOF' > "$TARGET_DIR/start-xmrig.sh"
#!/bin/bash
cd "$(dirname "$0")"

echo "========================================================="
echo "⛏️  מתחיל כריית RandomX (תשלום בביטקוין לכתובת שלך)"
echo "========================================================="
echo ""

# הרצה עם sudo מאפשרת ל-XMRig להפעיל Huge Pages ו-MSR, מה שמעלה את קצב הגיבוב בכ-20%
if [ "$EUID" -ne 0 ]; then
    echo "🔑 נדרשת סיסמת מנהל (sudo) כדי להפעיל שיפורי מהירות למעבד (MSR & Huge Pages)."
    echo "אם תבחר לא להקליד סיסמה, הכרייה תפעל בקצב רגיל."
    echo ""
    sudo ./xmrig
    if [ $? -ne 0 ]; then
        echo "⚠️ מריץ ללא הרשאות מנהל..."
        ./xmrig
    fi
else
    ./xmrig
fi
EOF
chmod +x "$TARGET_DIR/start-xmrig.sh"

# 6. יצירת קיצור דרך בשולחן העבודה
echo "🖥️  יוצר קיצור דרך בשולחן העבודה..."
DESKTOP_SHORTCUT="$DESKTOP_DIR/הפעל כריית מעבד (BTC).desktop"
cat <<EOF > "$DESKTOP_SHORTCUT"
[Desktop Entry]
Version=1.0
Type=Application
Terminal=true
Name=הפעל כריית מעבד (BTC)
Comment=Mine RandomX and get paid in Bitcoin via unMineable
Exec=gnome-terminal -- bash -c '$TARGET_DIR/start-xmrig.sh; read -p "Press Enter to close..."'
Icon=utilities-terminal
Categories=Application;
EOF
chmod +x "$DESKTOP_SHORTCUT"

# סימון קיצור הדרך כבטוח להרצה בלינוקס (Ubuntu Trusted desktop file)
gio set "$DESKTOP_SHORTCUT" metadata::trusted true 2>/dev/null || true

echo "=================================================="
echo "✅ ההתקנה הסתיימה בהצלחה!"
echo "📂 התיקייה נוצרה בכתובת: $TARGET_DIR"
echo "🖥️  קיצור הדרך 'הפעל כריית מעבד (BTC)' נוסף לשולחן העבודה שלך."
echo "=================================================="
echo "להפעלת התהליך, הרץ בטרמינל:"
echo "bash $TARGET_DIR/start-xmrig.sh"
echo "=================================================="
