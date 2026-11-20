# -*- coding: utf-8 -*-
# 화면 다시 짜기 시안 3종 + 추천 조합 (UX_REDESIGN.md). 우리 톤앤매너(흰 몸체·검은 화면·노랑 강조).
import os, html, random
OUT = os.path.expanduser('~/figcraft-work/play_music/redesign')
os.makedirs(OUT, exist_ok=True)
W, H = 1440, 900
BODY, PANEL, RULE, INK, INK2, INK3 = '#FFFFFF', '#F3F3F4', '#DDDDE0', '#111113', '#44444A', '#8A8A92'
SCREEN, GRID, ACC, REC = '#131315', '#26262A', '#FFD400', '#F0463C'
COLS = ['#35C9D6', '#35C9D6', '#FF6B4A', '#3DD68C', '#4D8DF7', '#A46BF5']
NAMES = ['킥', '스네어', '일렉 베이스', '어쿠스틱 기타', '패드', '리드']
F = "font-family='Pretendard, Apple SD Gothic Neo, Helvetica, sans-serif'"

class S:
    def __init__(s, h=H): s.h = h; s.p = [f"<rect width='{W}' height='{h}' fill='{BODY}'/>"]
    def r(s, x, y, w, h, f=PANEL, st=None, rx=0, sw=1, dash=None, op=None):
        a = (f" stroke='{st}' stroke-width='{sw}'" if st else '') + (f" stroke-dasharray='{dash}'" if dash else '') + (f" opacity='{op}'" if op else '')
        s.p.append(f"<rect x='{x}' y='{y}' width='{w}' height='{h}' rx='{rx}' fill='{f}'{a}/>")
    def t(s, x, y, txt, size=12, c=INK, w=400, a='start'):
        s.p.append(f"<text x='{x}' y='{y}' font-size='{size}' fill='{c}' font-weight='{w}' text-anchor='{a}' {F}>{html.escape(txt)}</text>")
    def tw(s, txt, size=12): return sum(size if ord(c) > 255 else size * 0.58 for c in txt)
    def b(s, x, y, label, on=False, h=28, size=12, w=None, round_=False, cta=False):
        w = w or s.tw(label, size) + 18
        f, st, c = (INK, INK, BODY) if on else (BODY, RULE, INK2)
        if cta: f, st, c = ACC, ACC, INK
        s.r(x, y, w, h, f, st, rx=h / 2 if round_ else 7)
        s.t(x + w / 2, y + h / 2 + size * 0.36, label, size, c, 600 if on or cta else 400, 'middle')
        return x + w + 6
    def tag(s, x, y, n):
        s.p.append(f"<circle cx='{x}' cy='{y}' r='12' fill='{REC}'/>"); s.t(x, y + 4.5, str(n), 13, '#FFF', 700, 'middle')
    def callout(s, x, y, txt, w=None):
        w = w or s.tw(txt, 12) + 20
        s.r(x, y, w, 26, '#FFF6C2', '#E5C100', rx=6); s.t(x + 10, y + 17, txt, 12, '#4A3F00', 500)
    def save(s, name):
        open(os.path.join(OUT, name + '.svg'), 'w', encoding='utf-8').write(
            f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}' height='{s.h}' viewBox='0 0 {W} {s.h}'>" + ''.join(s.p) + '</svg>')

def lcd(s, x, y, w=330):
    s.r(x, y, w, 44, SCREEN, rx=10)
    s.t(x + 14, y + 31, '9.1.00', 24, ACC, 600)
    s.t(x + 118, y + 22, '92', 15, '#EEE', 600); s.t(x + 118, y + 36, '템포', 9, '#888')
    s.t(x + 168, y + 22, 'A 단조', 13, '#EEE', 600); s.t(x + 168, y + 36, '조성', 9, '#888')
    s.t(x + 238, y + 22, '4/4', 15, '#EEE', 600); s.t(x + 238, y + 36, '박자', 9, '#888')
    s.t(x + 286, y + 28, '곡 ▾', 11, '#AAA')

def header(s, y=0, views=('편집', '믹서', '루프', '도우미'), extra_left=None, compact=True):
    s.r(0, y, W, 56, BODY); s.r(0, y + 56, W, 1, RULE)
    s.t(20, y + 26, 'RESONA', 15, INK, 700); s.t(20, y + 43, '비 오는 새벽 · 저장됨', 11, INK3)
    x = 170
    for i, v in enumerate(views): x = s.b(x, y + 14, v, on=(i == 0))
    x += 14
    for l, on in [('⏮', 0), ('▶', 1), ('●', 0), ('⟲', 0)]:
        x = s.b(x, y + 12, l, on=on, h=32, w=32, round_=True, size=13)
    lcd(s, x + 10, y + 6); x += 350
    for l in ['메트로놈', '1·2']: x = s.b(x, y + 14, l)
    x = W - 20 - 92; s.b(x, y + 11, '⤓ 내보내기', cta=True, h=34, size=13, w=92, round_=True)
    for l in ['?', '⚙', '파일', '↷', '↶']:
        w = 32 if len(l) == 1 else 44; x -= w + 6; s.b(x, y + 14, l, w=w)

def ruler(s, x, y, w, bars=16):
    s.r(x, y, w, 24, SCREEN)
    for i in range(bars): s.t(x + 6 + i * w / bars, y + 16, str(i + 1), 10, '#999')

def arrange(s, x, y, w, h, headw=230, n=6, slim=True, sel=0, globals_rows=0, gbtn=True, local=None):
    s.r(x, y, w, h, BODY, RULE, rx=12)
    ly = y
    if local:
        s.r(x + 1, y + 1, w - 2, 34, PANEL, rx=11); cx = x + 12
        for it in local:
            if it == '|': s.r(cx + 2, y + 9, 1, 18, RULE); cx += 14; continue
            s.t(cx, y + 22, it, 12, INK2 if not it.startswith('트랙') else INK, 600 if it.startswith('트랙') else 400); cx += s.tw(it) + 16
        ly = y + 36
    ruler(s, x + headw, ly, w - headw)
    s.r(x, ly, headw, 24, PANEL); s.t(x + 12, ly + 16, '＋ 트랙', 11, INK2)
    if gbtn: s.t(x + headw - 62, ly + 16, '글로벌 G', 11, INK3)
    ty = ly + 24
    for g in range(globals_rows):
        s.r(x, ty, headw, 22, '#FAFAFA'); s.t(x + 12, ty + 15, ['구간', '마커', '코드', '템포'][g], 11, INK3)
        s.r(x + headw, ty, w - headw, 22, '#1B1B1E'); ty += 22
    th = 38
    for i in range(n):
        yy = ty + i * th
        if yy + th > y + h: break
        s.r(x + 1, yy, headw - 1, th - 1, '#FFFBE0' if i == sel else BODY); s.r(x, yy + th - 1, w, 1, RULE)
        s.r(x + 8, yy + 7, 5, 24, COLS[i], rx=2)
        s.t(x + 22, yy + 24, NAMES[i], 13, INK, 500)
        bx = x + headw - 8
        for l in (['S', 'M'] if slim else ['✕', 'A', '─●─', 'S', 'M', '기본 ▾']):
            bw = s.tw(l, 10) + 12; bx -= bw + 3
            s.r(bx, yy + 9, bw, 20, BODY, RULE, rx=4); s.t(bx + bw / 2, yy + 23, l, 10, INK2, 500, 'middle')
        if slim: s.r(bx - 58, yy + 17, 50, 4, RULE, rx=2); s.r(bx - 30, yy + 13, 4, 12, INK, rx=2)
        s.r(x + headw, yy, w - headw, th - 1, SCREEN)
        rw = (w - headw) / 16
        for a in (0, 4, 8, 12):
            if (i * 3 + a) % 7 == 4: continue
            on = (i == sel and a == 8)
            s.r(x + headw + a * rw + 2, yy + 4, 4 * rw - 4, th - 9, COLS[i] + '40', ACC if on else COLS[i], rx=4, sw=2 if on else 1)
            s.t(x + headw + a * rw + 8, yy + 17, f'{NAMES[i]} {a // 4 + 1}', 9, '#EEE')
    return ty

def roll(s, x, y, w, h, head=None, lanes=True):
    s.r(x, y, w, h, SCREEN, rx=12)
    ky = y
    if head:
        s.r(x, y, w, 36, '#1D1D20', rx=12); s.r(x, y + 20, w, 16, '#1D1D20'); cx = x + 12
        for it in head:
            if it == '|': s.r(cx + 2, y + 10, 1, 16, '#3A3A40'); cx += 14; continue
            on = it.startswith('*'); it = it.lstrip('*')
            if on: s.r(cx - 6, y + 7, s.tw(it) + 12, 22, '#33333A', rx=5)
            s.t(cx, y + 23, it, 12, '#FFF' if on else '#B5B5BD', 600 if on else 400); cx += s.tw(it) + 16
        ky = y + 36
    lane = 56 if lanes else 0
    rows = int((h - (ky - y) - lane - 22) / 13)
    s.r(x, ky, w, 22, '#19191C')
    for i in range(5): s.t(x + 60 + i * (w - 60) / 4.2, ky + 15, str(i + 1), 10, '#888')
    for i in range(rows):
        blk = i % 12 in (1, 3, 6, 8, 10); yy = ky + 22 + i * 13
        s.r(x, yy, 54, 13, '#111' if blk else '#F2F2F2', '#333')
        s.r(x + 54, yy, w - 54, 13, '#17171A' if blk else '#1E1E22')
    random.seed(7)
    for i in range(26):
        nx = x + 62 + i * (w - 80) / 26; ny = ky + 22 + random.randint(1, max(2, rows - 2)) * 13
        s.r(nx, ny + 1, (w - 80) / 26 - 3, 11, ACC if i in (9, 10) else '#3DD68C', rx=2)
    if lanes:
        ly = y + h - lane; s.r(x, ly, w, 1, '#333'); s.t(x + 10, ly + 16, '세기', 9, '#888')
        for i in range(26):
            hh = random.randint(14, 44); s.r(x + 62 + i * (w - 80) / 26, ly + lane - 4 - hh, 8, hh, '#A8901A')

def inspector(s, x, y, w, h, title='인스펙터'):
    s.r(x, y, w, h, BODY, RULE, rx=12)
    s.t(x + 14, y + 24, title, 13, INK, 700)
    yy = y + 44
    for sec, rows in [('음', ['음정  A2  +0¢', '시작  9.1.000', '길이  1/16', '세기  102']), ('클립 · 킥 2', ['반복  ·  색  ·  뮤트', '퀀타이즈  1/16']), ('트랙 · 킥', ['악기  킥 — 기본', '볼륨 −3.0 dB · 팬 C', '이펙트 2 · 센드 1'])]:
        s.t(x + 14, yy + 6, sec, 11, INK3, 600); yy += 16
        for r_ in rows:
            s.r(x + 12, yy, w - 24, 26, PANEL, rx=6); s.t(x + 22, yy + 17, r_, 11, INK2); yy += 30
        yy += 10

def menu(s, x, y, items, w=220, title=None):
    h = len(items) * 26 + 14 + (22 if title else 0)
    s.r(x + 3, y + 5, w, h, '#000', rx=12, op=0.12); s.r(x, y, w, h, BODY, RULE, rx=12)
    yy = y + 8
    if title: s.t(x + 14, yy + 14, title, 10, INK3, 600); yy += 22
    for it in items:
        if it == '-': s.r(x + 10, yy + 12, w - 20, 1, RULE); yy += 26; continue
        lab, _, key = it.partition('\t')
        s.t(x + 14, yy + 17, lab, 12, INK); 
        if key: s.t(x + w - 14, yy + 17, key, 11, INK3, 400, 'end')
        yy += 26

CLIP_MENU = ['나누기 (커서에서)\t⌘T', '합치기\t⌘J', '끝까지 반복\t⌘R', '에일리어스 만들기\t⌥R', '-', '뮤트\tM', '색 ›', '이름 바꾸기', '-', '복제\t⌘D', '삭제\t⌫']
TRACK_MENU = ['트랙 복제', '위로 · 아래로', '스택에 넣기 ›', '-', '보호', '숨기기\tH', '❄ 프리즈', '바운스 인 플레이스', '-', '트랙 삭제']
HEAD = ['*피아노 롤', '스텝', '목록', '악보', '|', '편집 ▾', '기능 ▾', '보기 ▾', '|', '격자 1/16 ▾', '음 길이 1/16 ▾', '세기 ─●─ 102', 'Q 퀀타이즈']

# ───── 시안 A — Logic 문법 그대로 ─────
s = S(); header(s)
inspector(s, 16, 70, 250, H - 86)
arrange(s, 278, 70, W - 294, 330, slim=True, local=['트랙 영역', '|', '편집 ▾', '기능 ▾', '보기 ▾', '|', '스냅 스마트 ▾', '', '', '', '', '', '', '', '', '', '', '', '', '', '─●─ 확대'])
roll(s, 278, 412, W - 294, H - 428, head=HEAD + ['', '', '', '', '', '', '─●─ 확대'])
menu(s, 900, 190, CLIP_MENU, title='클립 우클릭')
s.tag(140, 60, 1); s.tag(330, 88, 2); s.tag(330, 430, 3); s.tag(1010, 182, 4)
s.callout(290, H - 60, '① 왼쪽 인스펙터 한 곳(음·클립·트랙)  ② 영역마다 편집·기능·보기 메뉴  ③ 격자·세기는 편집기 머리  ④ 대상 동작은 우클릭')
s.save('A-logic-grammar')

# ───── 시안 B — 맥락 막대 ─────
s = S(); header(s)
s.r(0, 57, W, 44, '#FFFBE0'); s.r(0, 101, W, 1, RULE)
s.t(20, 85, '클립  킥 2', 13, INK, 700); x = 110
for l in ['나누기', '합치기', '반복', '에일리어스', '뮤트', '색 ▾', '더보기 ⋯']: x = s.b(x, 65, l)
s.t(W - 20, 85, '고른 것에 따라 이 줄이 바뀝니다 — 클립 / 트랙 / 음 / (아무것도 없으면 사라짐)', 11, INK3, 400, 'end')
arrange(s, 16, 114, W - 32 - 300, 300, slim=True)
roll(s, 16, 426, W - 32 - 300, H - 442, head=['*피아노 롤', '스텝', '목록', '악보', '|', '격자 1/16 ▾', '음 길이 1/16 ▾', '세기 ─●─ 102', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '─●─ 확대'])
inspector(s, W - 16 - 288, 114, 288, H - 130, title='음 편집 · 컨트롤 · 브라우저')
s.tag(60, 80, 1); s.callout(30, H - 60, '① 선택 맥락 막대 — 숨기지 않고 "지금 쓸 수 있는 것만" 보여 준다. 우클릭을 몰라도 되고 터치에서도 된다. 대신 줄 하나를 계속 차지')
s.save('B-context-bar')

# ───── 시안 C — 작업 단계 + 명령 팔레트 ─────
s = S(); header(s, views=('① 작곡', '② 편곡', '③ 믹스', '④ 마무리'))
arrange(s, 16, 70, W - 32, 250, slim=True, n=5)
roll(s, 16, 332, W - 32, H - 348, head=['*피아노 롤', '스텝', '목록', '악보', '|', '격자 1/16 ▾', '음 길이 1/16 ▾', '세기 ─●─ 102', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '─●─ 확대'])
s.r(0, 0, W, H, '#000', op=0.35)
px, py, pw = 420, 150, 600
s.r(px, py, pw, 420, BODY, RULE, rx=16)
s.r(px + 16, py + 16, pw - 32, 44, PANEL, rx=10); s.t(px + 32, py + 44, '⌕  나누', 16, INK); s.t(px + pw - 32, py + 44, '⌘K', 12, INK3, 400, 'end')
for i, (a, b2, k) in enumerate([('클립 나누기', '클립 · 커서 위치에서', '⌘T'), ('성부 나누기 — 윗성부 떼어내기', '음 · 기능', ''), ('트랙 나누어 바운스', '트랙', ''), ('구간 나누기', '편곡 마커', ''), ('코드 쪼개기', '음 · 기능', '')]):
    yy = py + 76 + i * 56
    if i == 0: s.r(px + 12, yy, pw - 24, 50, '#FFFBE0', rx=10)
    s.t(px + 28, yy + 22, a, 14, INK, 600); s.t(px + 28, yy + 40, b2, 11, INK3); 
    if k: s.t(px + pw - 28, yy + 30, k, 12, INK2, 400, 'end')
s.t(px + 28, py + 396, '↑↓ 고르기 · Enter 실행 · 모든 기능을 이름으로 찾는다 — 화면에는 단추를 거의 안 둔다', 11, INK3)
s.tag(250, 60, 1); s.tag(px + pw - 10, py + 10, 2)
s.callout(30, H - 60, '① 화면 고르기 = 작업 단계(단계마다 패널 배치가 바뀜)  ② ⌘K 명령 팔레트 — 가장 깨끗하지만, 이름을 모르면 못 찾고 Logic 손버릇과 다르다')
s.save('C-stages-palette')

# ───── 추천 — A 뼈대 + B 발견성 + C 팔레트 ─────
s = S(); header(s)
ay = 70
arrange(s, 16, ay, W - 32 - 300, 300, slim=True, local=['트랙 영역', '|', '클립 ▾', '트랙 ▾', '보기 ▾', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '─●─ 확대'])
roll(s, 16, ay + 312, W - 32 - 300, H - ay - 328, head=HEAD[:8] + ['|', '격자 1/16 ▾', '음 길이 1/16 ▾', '세기 ─●─ 102', '', '', '', '', '─●─ 확대'])
inspector(s, W - 16 - 288, ay, 288, H - ay - 16, title='음 편집 · 컨트롤 · 브라우저')
menu(s, 150, ay + 34, CLIP_MENU, title='클립 ▾  (= 클립 우클릭과 같은 목록)')
menu(s, 700, ay + 150, TRACK_MENU[:6], w=190, title='트랙 헤더 우클릭')
s.tag(104, ay + 4, 1); s.tag(470, ay + 314, 2); s.tag(1035, 28, 3); s.tag(W - 160, ay + 12, 4); s.tag(890, ay + 142, 5)
s.r(380, H - 150, 640, 96, '#FFF6C2', '#E5C100', rx=10)
for i, l in enumerate(['① 메뉴 단추(클립▾·트랙▾·보기▾) = 우클릭과 같은 목록 — 숨기되 찾을 수 있게 (A+B)',
                       '② 격자·음 길이·세기·퀀타이즈·기능은 편집기 머리로 (A)   ③ ? 빠른 도움말 · ⌘K 명령 찾기 (C)',
                       '④ 오른쪽 칸은 I 로 접고 편다   ⑤ 대상 위 우클릭 (A) — 글로벌 트랙은 G, 기본 숨김',
                       '위쪽 3줄·단추 55개 → 1줄·20개. 기능은 하나도 빼지 않는다']):
    s.t(396, H - 126 + i * 21, l, 12, '#4A3F00', 600 if i == 3 else 400)
s.save('D-recommended')

# ───── 비교표 ─────
s = S(h=760)
s.t(30, 50, '시안 3종 비교와 추천', 22, INK, 700)
cols = [('', 200), ('A · Logic 문법', 290), ('B · 맥락 막대', 290), ('C · 단계 + 명령 팔레트', 290), ('추천 (조합)', 310)]
rows = [
    ('늘 보이는 단추', '약 20', '약 28 (막대 포함)', '약 14', '약 20'),
    ('위쪽 줄 수', '1', '2', '1', '1'),
    ('처음 쓰는 사람이 기능 찾기', '△ 우클릭을 알아야', '◎ 눈앞에 나옴', '△ 이름을 알아야', '○ 메뉴 단추 + ? + ⌘K'),
    ('Logic 쓰던 사람', '◎ 손버릇 그대로', '○', '△ 다름', '◎'),
    ('터치·트랙패드', '△ 우클릭 의존', '◎', '○', '○ 메뉴 단추가 우클릭 대신'),
    ('편집 화면 넓이', '○ 인스펙터가 폭 차지', '△ 줄 하나 더', '◎', '◎ 오른쪽 칸 접기'),
    ('바꿔야 하는 양', '큼 (인스펙터 이사)', '중간', '큼 (화면 구조)', '중간 — 자리만 옮김'),
    ('브라우저 점검 깨짐', '많음', '적음', '많음', '적음 (재생·화면 단추 그대로)'),
]
x0, y0 = 30, 90; x = x0
s.r(x0, y0, 1380, 36, PANEL)
for name, w in cols: s.t(x + 12, y0 + 23, name, 13, INK, 700); x += w
for i, row in enumerate(rows):
    yy = y0 + 36 + i * 44; x = x0
    if i % 2: s.r(x0, yy, 1380, 44, '#FAFAFB')
    for j, (cell, (_, w)) in enumerate(zip(row, cols)):
        if j == 4: s.r(x, yy, w, 44, '#FFFBE0')
        s.t(x + 12, yy + 27, cell, 13, INK if j in (0, 4) else INK2, 600 if j in (0, 4) else 400); x += w
for i, l in enumerate(['추천 = A 의 뼈대(1줄 · 편집기 머리 · 우클릭) + B 의 발견성(메뉴 단추로 같은 목록) + C 의 ⌘K·빠른 도움말.',
                       'A 의 왼쪽 인스펙터 이사와 C 의 단계 화면은 채택하지 않는다 — 얻는 것에 비해 바뀌는 양이 크고, 지금 오른쪽 칸이 이미 그 일을 한다.']):
    s.t(30, 520 + i * 26, l, 14, INK, 600 if i == 0 else 400)
s.save('E-compare')
print('ok')
