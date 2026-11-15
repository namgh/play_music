#!/bin/sh
cd "$(dirname "$0")"
for n in "$@"; do "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1440,900 --virtual-time-budget=8000 --screenshot="$PWD/$n.png" "file://$PWD/$n.html" 2>/dev/null & done; wait
