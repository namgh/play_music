#!/bin/sh
# FigCraft "v5 · 19화면" 페이지에 번호 순서로 넣는다: ./push.sh s01-start 1 "01 시작" ...
cd "$(dirname "$0")"
S=/private/tmp/claude-501/-Users-nam-project-ai-music/e6f92354-123e-4dc2-8089-377c1a4307ee/scratchpad/v4/push4.py
while [ $# -ge 3 ]; do
  n=$1; i=$2; t=$3; shift 3
  x=$(( ((i - 1) % 4) * 1540 )); y=$(( ((i - 1) / 4) * 1060 ))
  FC_PAGE="v5 · 19화면" python3 -I $S ../redesign-v5/$n $x $y "$t" "v5-$n" || exit 1
done
