#!/usr/bin/env bash

# צבעים
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

clear
echo "===================================================="
echo -e "      🧹 ${CYAN}ניקוי ואופטימיזציה של פלאפון כורה${NC} 🧹      "
echo "===================================================="

# חיפוש מכשירים מחוברים
echo -e "${YELLOW}[*] מחפש מכשירי אנדרואיד מחוברים ב-USB...${NC}"
devices=$(adb devices | grep -w "device" | awk '{print $1}')
device_count=$(echo "$devices" | grep -c "^")

if [ -z "$devices" ]; then
    echo -e "${RED}[-] לא נמצאו מכשירים מחוברים או שלא אישרת את החיבור במסך הטלפון.${NC}"
    exit 1
fi

device_id=""
if [ "$device_count" -gt 1 ]; then
    echo -e "${YELLOW}[!] נמצאו מספר מכשירים. אנא בחר איזה מכשיר לנקות:${NC}"
    select dev in $devices; do
        if [ -n "$dev" ]; then
            device_id="$dev"
            break
        fi
    done
else
    device_id=$(echo "$devices" | awk '{print $1}')
fi

echo -e "${GREEN}[+] נבחר מכשיר בהצלחה:${NC} $device_id"
echo -e "${YELLOW}[*] מתחיל בהסרת אפליקציות מיותרות שגוזלות סוללה ומעבד...${NC}"
echo -e "פעולה זו בטוחה וניתנת לשחזור (דרך איפוס יצרן), והיא חיונית לקירור המעבד.${NC}\n"

# רשימת האפליקציות להסרה (בטוח להסרה - לא פוגע במערכת ההפעלה)
APPS_TO_REMOVE=(
    # Xiaomi Bloatware and Analytics
    "com.miui.analytics"
    "com.miui.bugreport"
    "com.miui.cleanmaster"
    "com.miui.cloudbackup"
    "com.miui.cloudservice"
    "com.miui.daemon"
    "com.miui.micloudsync"
    "com.miui.miservice"
    "com.miui.msa.global"
    "com.miui.player"
    "com.miui.weather2"
    "com.miui.yellowpage"
    "com.xiaomi.discover"
    "com.xiaomi.glgm"
    "com.xiaomi.joyose"
    "com.xiaomi.midrop"
    "com.xiaomi.mipicks"
    "com.xiaomi.miplay_client"
    "com.xiaomi.payment"
    "com.xiaomi.scanner"
    "com.xiaomi.mipicks"
    
    # Facebook Bloatware (מגיע מותקן מראש במכשירים רבים וזולל סוללה)
    "com.facebook.appmanager"
    "com.facebook.services"
    "com.facebook.system"
    "com.facebook.katana"
    
    # Google/General Bloatware (safe to remove for a dedicated miner)
    "com.google.android.apps.tachyon"
    "com.google.android.music"
    "com.google.android.videos"
    "com.google.android.youtube"
    "com.android.providers.partnerbookmarks"
    "com.android.providers.userdictionary"
    "com.google.android.apps.docs"
    "com.google.android.apps.photos"
    "com.google.android.projection.gearhead" # Android Auto
)

removed_count=0
failed_count=0
skipped_count=0

for app in "${APPS_TO_REMOVE[@]}"; do
    # בדיקה האם האפליקציה קיימת
    if adb -s "$device_id" shell pm list packages | grep -q "$app"; then
        echo -n -e "[-] מסיר את ${CYAN}$app${NC}... "
        # קודם כל מקפיאים/משביתים את האפליקציה כדי למנוע ממנה לרוץ ברקע
        adb -s "$device_id" shell pm disable-user --user 0 "$app" >/dev/null 2>&1
        # מנקים את נתוני המטמון שלה שזוללים מקום
        adb -s "$device_id" shell pm clear "$app" >/dev/null 2>&1
        # לבסוף מסירים אותה עבור המשתמש הנוכחי
        result=$(adb -s "$device_id" shell pm uninstall -k --user 0 "$app" 2>&1)
        
        if echo "$result" | grep -q "Success"; then
            echo -e "${GREEN}הצלחה!${NC}"
            ((removed_count++))
        else
            echo -e "${RED}נכשל/חסום על ידי המערכת.${NC}"
            ((failed_count++))
        fi
    else
        ((skipped_count++))
    fi
done

echo ""
echo "===================================================="
echo -e "${GREEN}🎉 תהליך הניקוי הושלם בהצלחה!${NC}"
echo -e "סה\"כ שירותי רקע ואפליקציות שהוסרו: ${GREEN}$removed_count${NC}"
echo -e "אפליקציות שכבר הוסרו/לא קיימות במכשיר: $skipped_count"
echo "===================================================="
echo -e "${YELLOW}מומלץ לעשות ריסטרט לפלאפון כדי שהניקוי ייכנס לתוקף מלא!${NC}"
