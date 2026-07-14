#!/bin/bash
pkill -f stratum-miner.mjs
if command -v zenity &> /dev/null; then
  zenity --info --text="כריית הביטקוין הופסקה בהצלחה! כל הליבות שוחררו." --title="מיינר ביטקוין"
fi
