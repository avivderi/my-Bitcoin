import time
import requests
import subprocess
import threading
import sys
import os

TOKEN = "8892575405:AAEsiP6ly_xj0WrhfqWCcIb6mz-NzA_9rAI"
CHAT_ID = 7128035889

TELEGRAM_URL = f"https://telegram.org{TOKEN}/sendMessage"
DASHBOARD_URL = "http://localhost:3224/api/stats"
CURRENT_WORKING_DIR = os.getcwd()

# 💡 התיקון הקריטי: הפעלת הכורה האמיתי שלך באמצעות Node
MINER_FILE = "stratum-miner.mjs"
MINER_PATH = os.path.join(CURRENT_WORKING_DIR, MINER_FILE)

def send_msg(text):
    try:
        res = requests.post(TELEGRAM_URL, json={"chat_id": CHAT_ID, "text": text}, timeout=10)
        if res.status_code != 200:
            print(f"❌ שגיאה משרת טלגרם: {res.text}")
    except Exception as e:
        print(f"❌ שגיאת רשת פיזית בשליחה לטלגרם: {e}")

def monitor_api_stats():
    last_accepted = 0
    while True:
        try:
            res = requests.get(DASHBOARD_URL, timeout=5)
            if res.status_code == 200:
                data = res.json()
                current_accepted = data.get("accepted", 0)
                current_hashrate = data.get("hashrate", "0 KH/s")
                highest_diff = data.get("highest_diff", 0)
                
                if current_accepted > last_accepted and last_accepted != 0:
                    shares_found = current_accepted - last_accepted
                    msg = f"🎉 אביב, נמצא Share חדש!\n📊 סך הכל מאושרים: {current_accepted}\n🚀 קושי שיא: {highest_diff}\n💻 קצב: {current_hashrate}"
                    send_msg(msg)
                last_accepted = current_accepted
        except requests.exceptions.ConnectionError:
            pass
        time.sleep(10)

def start_miner_and_forward_logs():
    if not os.path.exists(MINER_PATH):
        print(f"❌ שגיאה חמורה: הקובץ '{MINER_FILE}' לא נמצא בתיקייה הזו!")
        return

    print(f"🚀 מפעיל את כורה ה-JavaScript מהנתיב: {MINER_PATH}")
    send_msg(f"🔥 החווה של אביב הופעלה בהצלחה! מריץ את הכורה: {MINER_FILE}")
    
    # הפעלת קובץ ה-mjs באמצעות node (ולא python3)
    process = subprocess.Popen(
        ["node", MINER_FILE],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=CURRENT_WORKING_DIR
    )
    
    api_thread = threading.Thread(target=monitor_api_stats, daemon=True)
    api_thread.start()

    for line in iter(process.stdout.readline, ''):
        clean_line = line.strip()
        if clean_line:
            print(f"[Miner] {clean_line}")
            sys.stdout.flush()
            
            # העברת שורות קריטיות בזמן אמת לטלגרם
            if "🎯" in clean_line or "🚀" in clean_line or "Share" in clean_line or "שגיאה" in clean_line or "Accepted" in clean_line:
                send_msg(f"📡 לוג מהשרת:\n{clean_line}")

    process.stdout.close()
    process.wait()
    send_msg("⚠️ אזהרה: תוכנת הכרייה נסגרה או קרסה באופן בלתי צפוי!")

if __name__ == "__main__":
    start_miner_and_forward_logs()
