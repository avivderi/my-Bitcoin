#!/usr/bin/env bash

# setup-phone.sh
# סקריפט להתקנה והגדרת וורקר כריית ביטקוין אוטומטית על מכשירי אנדרואיד באמצעות חיבור USB (ADB)

# צבעים לעיצוב הטרמינל
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # ללא צבע

clear
echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}      ⛏️  התקנה והגדרת וורקר כרייה לטלפון הנייד  📱      ${NC}"
echo -e "${BLUE}====================================================${NC}"
echo ""

# 1. טעינת הגדרות מקובץ .env
TOKEN=""
PORT="3224"

if [ -f .env ]; then
    echo -e "${GREEN}[+] טוען הגדרות קיימות מקובץ .env...${NC}"
    # קריאת משתנים ספציפיים
    TOKEN=$(grep -E "^DASHBOARD_TOKEN=" .env | cut -d'=' -f2 | tr -d '\r' | tr -d '"')
    ENV_PORT=$(grep -E "^HTTP_PORT=" .env | cut -d'=' -f2 | tr -d '\r' | tr -d '"')
    if [ ! -z "$ENV_PORT" ]; then
        PORT="$ENV_PORT"
    fi
else
    echo -e "${YELLOW}[!] קובץ .env לא נמצא. נשתמש בהגדרות ברירת מחדל.${NC}"
fi

# 2. זיהוי כתובת ה-IP של המחשב ברשת המקומית
IP_DETECTED=$(ip route get 1 2>/dev/null | awk '{print $(NF-2);exit}')
if [ -z "$IP_DETECTED" ]; then
    IP_DETECTED=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$IP_DETECTED" ]; then
    IP_DETECTED="192.168.1.100"
fi

echo -e "${GREEN}[+] כתובת ה-IP של המחשב שזוהתה ברשת:${NC} $IP_DETECTED"
read -p "הקש Enter לאישור או הקלד כתובת IP אחרת של המחשב: " user_ip
if [ ! -z "$user_ip" ]; then
    IP_DETECTED="$user_ip"
fi

# 3. קביעת שם המכשיר (וורקר)
default_name="redmi-1"
read -p "הקלד שם ייחודי לטלפון הזה (ברירת מחדל: $default_name): " worker_name
if [ -z "$worker_name" ]; then
    worker_name="$default_name"
fi

# 4. בדיקה ש-ADB מותקן על המחשב
if ! command -v adb &> /dev/null; then
    echo -e "${RED}[-] כלי ה-ADB אינו מותקן על המחשב.${NC}"
    echo -e "נא להתקין אותו באמצעות הפקודה הבאה בטרמינל חדש:"
    echo -e "👉 ${YELLOW}sudo apt update && sudo apt install -y adb${NC}"
    echo ""
    read -p "הקש Enter לאחר שהתקנת את ADB כדי להמשיך..."
    if ! command -v adb &> /dev/null; then
        echo -e "${RED}[-] ADB עדיין לא מותקן. התקנה הופסקה.${NC}"
        exit 1
    fi
fi

# 5. חיבור למכשיר וזיהוי
echo -e "${YELLOW}[*] מחפש מכשירי אנדרואיד מחוברים ב-USB...${NC}"
while true; do
    devices=$(adb devices | grep -v "List of devices" | grep -v "^$")
    if [ -z "$devices" ]; then
        echo -e "${RED}[-] לא נמצאו מכשירים מחוברים.${NC}"
        echo -e "אנא בצע את השלבים הבאים בטלפון:"
        echo -e "  1. חבר את הטלפון למחשב עם כבל USB איכותי."
        echo -e "  2. כנס להגדרות -> אודות הטלפון -> לחץ 7 פעמים על 'Build Number' (או גרסת MIUI) כדי להפעיל אפשרויות מפתח."
        echo -e "  3. כנס לאפשרויות מפתח -> הפעל 'USB Debugging' (ניפוי באגים של USB)."
        echo -e "  4. אשר את חלונית הגישה שקופצת על מסך הטלפון (סמן 'אפשר תמיד ממחשב זה')."
        echo ""
        read -p "הקש Enter כדי לנסות לזהות שוב..."
    else
        # בדיקה אם יש מכשיר שמחובר אך אינו מאושר (unauthorized)
        if echo "$devices" | grep -q "unauthorized"; then
            echo -e "${YELLOW}[!] נמצא מכשיר, אך הוא דורש אישור על מסך הטלפון.${NC}"
            echo -e "אנא הבט במסך הטלפון ואשר את החיבור למחשב (התרת ניפוי באגים במכשיר זה)."
            read -p "הקש Enter לאחר האישור בטלפון כדי להמשיך..."
        else
            break
        fi
    fi
done

# בחירת מזהה מכשיר (Device ID) במקרה שיש יותר מאחד
device_count=$(echo "$devices" | wc -l)
if [ "$device_count" -gt 1 ]; then
    echo -e "${YELLOW}[!] נמצאו מספר מכשירים מחוברים:${NC}"
    echo "$devices" | awk '{print NR ") " $1 " (" $2 ")"}'
    read -p "בחר את מספר המכשיר להתקנה (למשל 1): " device_num
    device_id=$(echo "$devices" | sed -n "${device_num}p" | awk '{print $1}')
else
    device_id=$(echo "$devices" | awk '{print $1}')
fi

echo -e "${GREEN}[+] נבחר מכשיר בהצלחה:${NC} $device_id"

# 6. עירור מסך הטלפון
echo -e "${YELLOW}[*] מעורר את מסך הטלפון...${NC}"
adb -s "$device_id" shell input keyevent 224
echo -e "${YELLOW}[!] שים לב: ודא שמסך הטלפון פתוח לחלוטין (UNLOCKED) כדי שההתקנה תעבור בהצלחה.${NC}"
sleep 1.5

# 7. בדיקה והתקנה של Termux
echo -e "${YELLOW}[*] בודק אם אפליקציית Termux מותקנת בטלפון...${NC}"
if adb -s "$device_id" shell pm list packages | grep -q "com.termux"; then
    echo -e "${GREEN}[+] Termux כבר מותקן בטלפון.${NC}"
else
    echo -e "${YELLOW}[!] Termux אינו מותקן בטלפון. מתחיל בהורדה והתקנה...${NC}"
    termux_apk="termux-app_v0.118.0.apk"
    if [ ! -f "$termux_apk" ]; then
        echo -e "${YELLOW}[*] מוריד את קובץ ההתקנה של Termux מ-F-Droid...${NC}"
        curl -L -# -o "$termux_apk" "https://f-droid.org/repo/com.termux_118.apk"
    fi
    if [ -f "$termux_apk" ]; then
        echo -e "${YELLOW}[*] מתקין את Termux בטלפון (זה עלול לקחת כחצי דקה)...${NC}"
        adb -s "$device_id" install -r "$termux_apk"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}[+] Termux הותקן בהצלחה בטלפון!${NC}"
        else
            echo -e "${RED}[-] התקנת האפליקציה נכשלה. נסה להתקין את Termux ידנית ולאחר מכן הרץ שוב את הסקריפט.${NC}"
            exit 1
        fi
    else
        echo -e "${RED}[-] הורדת קובץ ה-APK נכשלה. אנא בדוק את חיבור האינטרנט שלך.${NC}"
        exit 1
    fi
fi

# 8. יצירת תיקיית קבצים משותפת והעברת phone-worker.py לטלפון
echo -e "${YELLOW}[*] מייצר תיקייה משותפת ומעביר את קוד ה-Worker לטלפון...${NC}"
adb -s "$device_id" shell mkdir -p /sdcard/Android/data/com.termux/files/

# העברת phone-worker.py
adb -s "$device_id" push phone-worker.py /sdcard/Android/data/com.termux/files/phone-worker.py
if [ $? -ne 0 ]; then
    echo -e "${RED}[-] שגיאה בהעברת קובץ phone-worker.py לטלפון.${NC}"
    exit 1
fi
echo -e "${GREEN}[+] קוד המיינר הועבר בהצלחה.${NC}"

# 9. יצירת סקריפט התקנה פנימי מותאם אישית (bootstrap_tmp.sh)
echo -e "${YELLOW}[*] מכין סקריפט התקנה והפעלה ייעודי למכשיר...${NC}"
cat << 'EOF' > bootstrap_tmp.sh
#!/usr/bin/env bash
# סקריפט זה מופעל בתוך Termux בטלפון

clear
echo "===================================================="
echo "    🚀  אתחול הגדרות המיינר בתוך Termux  📱    "
echo "===================================================="
echo "[*] מעדכן את מאגרי החבילות של Termux..."

# עדכון החבילות והתקנת פייתון
pkg update -y -o Dpkg::Options::="--force-confold"
echo "[*] מתקין את Python3 בטלפון..."
pkg install python -y

echo "[*] מעתיק את קובץ המיינר לתיקיית הבית בטלפון..."
cp /sdcard/Android/data/com.termux/files/phone-worker.py ~/phone-worker.py
chmod +x ~/phone-worker.py

echo "[*] יוצר סקריפט הפעלה עם מנגנון מניעת שינה (Wake Lock) ועדכון אוטומטי..."
cat << 'INNER_EOF' > ~/start-miner.sh
#!/usr/bin/env bash
echo "----------------------------------------------------"
echo "  Acquiring Termux Wake Lock to prevent sleep...   "
echo "----------------------------------------------------"
# הפעלת מניעת שינה כדי שהמעבד לא יאט או יכבה כשהמסך סגור
termux-wake-lock 2>/dev/null || true

# עדכון אוטומטי של קוד המיינר מהמחשב במידה והוא זמין ברשת
echo "[*] Checking for worker script updates from PC Master Server..."
curl -s -f -o ~/phone-worker.py.tmp http://PC_IP_PLACEHOLDER/phone-worker.py
if [ $? -eq 0 ] && [ -s ~/phone-worker.py.tmp ]; then
    mv ~/phone-worker.py.tmp ~/phone-worker.py
    chmod +x ~/phone-worker.py
    echo "[+] Mining script updated successfully from PC!"
else
    echo "[!] PC Server offline or update failed. Running cached version."
    rm -f ~/phone-worker.py.tmp
fi

echo "Starting Bitcoin Miner Phone Daemon..."
python ~/phone-worker.py --name=WORKER_NAME_PLACEHOLDER --ip=PC_IP_PLACEHOLDER --token=TOKEN_PLACEHOLDER
INNER_EOF
chmod +x ~/start-miner.sh

# הוספת הרצה אוטומטית בכל פעם שהאפליקציה נפתחת
if ! grep -q "start-miner.sh" ~/.bashrc 2>/dev/null; then
    echo "~/start-miner.sh" >> ~/.bashrc
    echo "[+] המיינר הוגדר להפעלה אוטומטית בכל פתיחה של אפליקציית Termux!"
fi

echo "===================================================="
echo "🎉 ההתקנה הסתיימה בהצלחה! מפעיל את המיינר כעת..."
echo "===================================================="
~/start-miner.sh
EOF

# החלפת הערכים בסקריפט ההתקנה לפני העברתו
sed -i "s/WORKER_NAME_PLACEHOLDER/$worker_name/g" bootstrap_tmp.sh
sed -i "s/PC_IP_PLACEHOLDER/$IP_DETECTED:$PORT/g" bootstrap_tmp.sh
sed -i "s/TOKEN_PLACEHOLDER/$TOKEN/g" bootstrap_tmp.sh

# העברת ה-bootstrap המותאם לטלפון
adb -s "$device_id" push bootstrap_tmp.sh /sdcard/Android/data/com.termux/files/bootstrap.sh
rm bootstrap_tmp.sh

# 10. פתיחת אפליקציית Termux בטלפון
echo -e "${YELLOW}[*] פותח את אפליקציית Termux בטלפון...${NC}"
adb -s "$device_id" shell am start -n com.termux/.app.TermuxActivity
echo -e "${YELLOW}[*] ממתין 4 שניות לעליית האפליקציה ומיקוד המקלדת...${NC}"
sleep 4

# 11. הקלדה אוטומטית של פקודת ההרצה בתוך Termux
echo -e "${YELLOW}[*] שולח פקודת התקנה לתוך הטרמינל בטלפון...${NC}"
# הקלדת הפקודה (מחליפים רווחים ב-%s עבור פקודת input text של אנדרואיד)
adb -s "$device_id" shell input text "sh%s/sdcard/Android/data/com.termux/files/bootstrap.sh"
sleep 1.5
adb -s "$device_id" shell input keyevent 66 # מקש Enter

echo ""
echo -e "${GREEN}====================================================${NC}"
echo -e "${GREEN}🎉 התקנת הוורקר בטלפון הסתיימה בהצלחה!${NC}"
echo -e "שים לב לנעשה במסך הטלפון - Termux כעת יתקין את Python ויחל לכרות."
echo -e "הוורקר יופיע בלוח הבקרה של המחשב תחת השם: ${CYAN}$worker_name${NC}"
echo ""
echo -e "${YELLOW}💡 טיפ לעבודה רציפה ונקייה מבעיות (Set-and-Forget):${NC}"
echo -e "1. כנס בהגדרות הטלפון לפרטי אפליקציית Termux (App Info)."
echo -e "2. תחת הגדרות סוללה / חיסכון בסוללה (Battery Saver) -> בחר ${GREEN}'ללא הגבלות' (No Restrictions)${NC}."
echo -e "3. נעל/הצמד (Pin) את אפליקציית Termux בתפריט האפליקציות האחרונות (Recent Apps)."
echo -e "${GREEN}====================================================${NC}"
