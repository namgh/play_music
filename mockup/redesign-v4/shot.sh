#!/bin/sh
# Chrome 스크린샷: ./shot.sh s1-start  →  s1-start.png
cd "$(dirname "$0")"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1440,900 --virtual-time-budget=3000 --screenshot="$PWD/$1.png" "file://$PWD/$1.html" 2>/dev/null
