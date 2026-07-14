#!/bin/bash
# בדיקה אם zenity מותקן
if ! command -v zenity &> /dev/null; then
  exit 0
fi

# המתנה קלה כדי לוודא שסביבת שולחן העבודה עלתה לגמרי
sleep 5

# שאלה אם להפעיל את הכרייה
zenity --question --text="האם ברצונך להפעיל את כריית הביטקוין כעת?" --title="מיינר ביטקוין" --ok-label="כן, תפעיל" --cancel-label="לא כרגע"
if [ $? -eq 0 ]; then
  # קבלת כמות הליבות במחשב
  CORES=$(nproc)
  
  # בחירת כמות ליבות
  CHOICE=$(zenity --scale --text="בחר כמה ליבות מעבד להקצות לכרייה (מתוך $CORES):" --title="רמת מאמץ מעבד" --min-value=1 --max-value=$CORES --value=2)
  
  if [ $? -eq 0 ]; then
    cd "/home/avivderi/שולחן העבודה/my-Bitcoin"
    
    # עדכון קובץ ה-.env
    if grep -q "MAX_CORES" .env; then
      sed -i "s/MAX_CORES=.*/MAX_CORES=$CHOICE/" .env
    else
      echo "MAX_CORES=$CHOICE" >> .env
    fi
    
    # עצירת תהליך קיים אם יש
    pkill -f stratum-miner.mjs
    
    # הרצת המיינר ברקע
    node stratum-miner.mjs > /dev/null 2>&1 &
    
    # הודעת אישור
    zenity --info --text="הכרייה הופעלה ברקע בהצלחה!\nמנוצלות: $CHOICE ליבות מתוך $CORES.\nלוח הבקרה זמין בכתובת http://localhost:3224" --title="הכרייה התחילה"
  fi
fi
