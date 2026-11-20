# -*- coding: utf-8 -*-
# Logic Pro 11 화면 구조 와이어프레임 (기억 기반 — 실제 스크린샷 아님)
import os, html
OUT = os.path.expanduser('~/figcraft-work/play_music/logic')
os.makedirs(OUT, exist_ok=True)
W, H = 1440, 900
BG, PANEL, PANEL2, LINE, TXT, MUTED = '#2B2B2E', '#38383C', '#323236', '#4A4A50', '#E8E8EA', '#9A9AA2'
ACC, NOTE, RED = '#F5C518', '#FF6B4A', '#E5484D'
FONT = "font-family='Pretendard, Apple SD Gothic Neo, Helvetica, sans-serif'"

class S:
    def __init__(s, w=W, h=H, bg=BG): s.w, s.h, s.p = w, h, [f"<rect width='{w}' height='{h}' fill='{bg}'/>"]
    def r(s, x, y, w, h, f=PANEL, st=None, rx=0, sw=1, dash=None):
        a = f" stroke='{st}' stroke-width='{sw}'" if st else ''
        if dash: a += f" stroke-dasharray='{dash}'"
        s.p.append(f"<rect x='{x}' y='{y}' width='{w}' height='{h}' rx='{rx}' fill='{f}'{a}/>")
    def t(s, x, y, txt, size=12, c=TXT, w=400, anchor='start'):
        s.p.append(f"<text x='{x}' y='{y}' font-size='{size}' fill='{c}' font-weight='{w}' text-anchor='{anchor}' {FONT}>{html.escape(txt)}</text>")
    def b(s, x, y, w, label, on=False, h=22, size=11):
        s.r(x, y, w, h, '#55555C' if on else '#46464C', rx=5)
        s.t(x + w / 2, y + h / 2 + 4, label, size, TXT if not on else ACC, 500, 'middle')
        return x + w + 4
    def note(s, x, y, txt, c=ACC):
        s.r(x, y, 9 * len(txt) * 0.0 + 14 + len(txt) * 11.5, 24, c, rx=12)
        s.t(x + 8, y + 16, txt, 12, '#1A1A1A', 600)
    def tag(s, x, y, n, c=ACC):
        s.p.append(f"<circle cx='{x}' cy='{y}' r='11' fill='{c}'/>")
        s.t(x, y + 4, str(n), 12, '#1A1A1A', 700, 'middle')
    def save(s, name):
        open(os.path.join(OUT, name + '.svg'), 'w', encoding='utf-8').write(
            f"<svg xmlns='http://www.w3.org/2000/svg' width='{s.w}' height='{s.h}' viewBox='0 0 {s.w} {s.h}'>" + ''.join(s.p) + '</svg>')

def menubar(s):
    s.r(0, 0, W, 24, '#1E1E20')
    x = 14
    for m in ['', 'Logic Pro', '파일', '편집', '트랙', '탐색', '녹음', '믹스', '보기', '윈도우', '1', '도움말']:
        s.t(x, 16, m, 12, TXT, 600 if m == 'Logic Pro' else 400); x += 14 + len(m) * 11 if m else 22

def controlbar(s, y=24):
    s.r(0, y, W, 52, '#3A3A3F')
    x = 12
    for l in ['라이브러리', '인스펙터', '툴바', '스마트', '믹서', '편집기']:
        x = s.b(x, y + 15, 58, l, l in ('인스펙터',))
    x += 30
    for l in ['⏪', '⏩', '■', '▶', '●', '⟲']:
        x = s.b(x, y + 13, 34, l, l == '⟲', h=26, size=13)
    # LCD
    s.r(x + 10, y + 7, 300, 38, '#1A1A1C', rx=6)
    s.t(x + 24, y + 33, '9  1', 22, ACC, 600); s.t(x + 104, y + 22, '92', 12, TXT, 600); s.t(x + 104, y + 38, '유지', 9, MUTED)
    s.t(x + 150, y + 22, '4/4', 12, TXT, 600); s.t(x + 150, y + 38, 'A 단조', 9, MUTED); s.t(x + 220, y + 30, '마디·박 / 템포 / 박자·조', 9, MUTED)
    x += 330
    for l in ['튜너', '바꿔', '솔로', '1234', '메트로놈']:
        x = s.b(x, y + 15, 44 if len(l) < 3 else 56, l, l == '메트로놈')
    x = W - 4 * 62 - 12
    for l in ['목록', '메모', '루프', '브라우저']:
        x = s.b(x, y + 15, 58, l)

def localbar(s, x, y, w, items, right=()):
    s.r(x, y, w, 28, PANEL2)
    cx = x + 8
    for it in items:
        s.t(cx, y + 18, it + ' ▾' if it in ('편집', '기능', '보기', '스냅: 스마트', '끌기: 겹침 없음', '시간 퀀타이즈') else it, 11, MUTED if it.startswith('·') else TXT); cx += 18 + len(it) * 9.5
    cx = x + w - 8
    for it in reversed(right):
        cx -= 18 + len(it) * 8; s.t(cx, y + 18, it, 11, MUTED)

def tracks(s, x, y, w, h, n=8, headw=210, globals_open=False):
    s.r(x, y, w, h, '#262628')
    localbar(s, x, y, w, ['편집', '기능', '보기', '·', '▸ 포인터', '✎ 연필', '스냅: 스마트', '끌기: 겹침 없음'], ['캐치', '오토메이션', 'Flex', '─◯── 확대'])
    gy = y + 28
    # 트랙 헤더 위 줄
    s.r(x, gy, headw, 28, PANEL2); s.t(x + 10, gy + 18, '+   ▣ G   ⌸', 12, TXT)
    s.r(x + headw, gy, w - headw, 28, '#303034')
    for i in range(16):
        s.t(x + headw + 6 + i * (w - headw) / 16, gy + 18, str(i + 1), 10, MUTED)
    gy += 28
    if globals_open:
        for g in ['편곡', '마커', '템포', '박자·조', '코드']:
            s.r(x, gy, headw, 22, '#2F2F33'); s.t(x + 12, gy + 15, g, 11, MUTED)
            s.r(x + headw, gy, w - headw, 22, '#2A2A2D', st='#3A3A3F')
            gy += 22
    names = ['킥', '스네어', '하이햇', '베이스', '어쿠스틱', '패드', '리드', '보컬', '코러스', '스트링']
    cols = ['#4FB3BF', '#4FB3BF', '#4FB3BF', '#E8734A', '#5BC27A', '#5B8DEF', '#B072E8', '#E85A8C', '#E85A8C', '#5B8DEF']
    th = 40
    for i in range(n):
        ty = gy + i * th
        if ty + th > y + h: break
        s.r(x, ty, headw, th - 1, '#333337')
        s.r(x + 6, ty + 6, 26, 26, '#46464C', rx=4)
        s.t(x + 40, ty + 24, f'{i + 1}  {names[i % 10]}', 12, TXT, 500)
        bx = x + headw - 4 * 22 - 6
        for l in ['M', 'S', 'R', 'I']:
            s.r(bx, ty + 9, 19, 19, '#46464C', rx=3); s.t(bx + 9.5, ty + 23, l, 10, TXT, 600, 'middle'); bx += 22
        rw = (w - headw) / 16
        for a, bb in [(0, 4), (4, 8), (8, 12), (12, 16)]:
            if (i + a) % 5 == 3: continue
            s.r(x + headw + a * rw + 1, ty + 3, (bb - a) * rw - 2, th - 7, cols[i % 10] + '55', st=cols[i % 10], rx=3)
            s.t(x + headw + a * rw + 6, ty + 15, names[i % 10], 9, TXT)

def inspector(s, x, y, w, h):
    s.r(x, y, w, h, '#2E2E32')
    s.t(x + 10, y + 18, '▾ 리전: 킥 2', 11, TXT, 600)
    for j, l in enumerate(['반복', '퀀타이즈  1/16', 'Q-스윙', '전조', '세기']):
        s.t(x + 16, y + 40 + j * 18, l, 10, MUTED)
    s.t(x + 10, y + 150, '▸ 트랙: 킥', 11, TXT, 600)
    # 채널 스트립 2개
    for k, lab in enumerate(['킥', '스테레오 출력']):
        cx = x + 8 + k * (w / 2)
        cw = w / 2 - 14
        s.r(cx, y + 170, cw, h - 180, '#36363A', rx=4)
        for j, l in enumerate(['설정', '게인', 'EQ', '입력', '오디오 FX', '센드', '출력', '읽기']):
            s.r(cx + 6, y + 180 + j * 26, cw - 12, 20, '#46464C', rx=3); s.t(cx + cw / 2, y + 194 + j * 26, l, 9, TXT, 400, 'middle')
        fy = y + 180 + 8 * 26 + 10
        s.r(cx + cw / 2 - 3, fy, 6, h - 180 - (fy - y - 170) - 70, '#1E1E20')
        s.r(cx + cw / 2 - 12, fy + 80, 24, 12, '#9A9AA2', rx=2)
        s.t(cx + cw / 2, y + h - 30, lab, 9, TXT, 500, 'middle')

def pianoroll(s, x, y, w, h):
    s.r(x, y, w, h, '#232325')
    s.r(x, y, w, 26, '#2E2E32')
    tx = x + 10
    for l, on in [('트랙', 0), ('피아노 롤', 1), ('악보', 0), ('스텝 시퀀서', 0)]:
        tx = s.b(tx, y + 3, 14 + len(l) * 11, l, on, h=20)
    localbar(s, x, y + 26, w, ['편집', '기능', '보기', '·', '▸ 포인터', '✎', '시간 퀀타이즈', '1/16', 'Q', '·', '세기 ─◯─'], ['스냅: 스마트', '─◯── 확대'])
    ky = y + 54
    for i in range(int((h - 54) / 12)):
        black = i % 12 in (1, 3, 6, 8, 10)
        s.r(x, ky + i * 12, 46, 12, '#111' if black else '#EEE', st='#555')
        s.r(x + 46, ky + i * 12, w - 46, 12, '#2A2A2D' if black else '#303034')
    import random; random.seed(3)
    for i in range(22):
        nx = x + 60 + i * (w - 80) / 22; ny = ky + random.randint(2, int((h - 70) / 12) - 2) * 12
        s.r(nx, ny + 1, (w - 80) / 22 - 4, 10, '#5BC27A', rx=2)

def library(s, x, y, w, h):
    s.r(x, y, w, h, '#2E2E32'); s.t(x + 10, y + 20, '라이브러리', 12, TXT, 600)
    s.r(x + 8, y + 32, w - 16, 22, '#1E1E20', rx=5); s.t(x + 16, y + 47, '⌕ 검색', 10, MUTED)
    for j, l in enumerate(['베이스', '드럼 키트', '일렉 피아노', '기타', '신시사이저', '오케스트라', '보컬', '패치 병합']):
        s.t(x + 14, y + 76 + j * 22, l + '  ›', 11, TXT)

def browser(s, x, y, w, h):
    s.r(x, y, w, h, '#2E2E32')
    tx = x + 8
    for l, on in [('프로젝트', 0), ('미디어', 0), ('모두 파일', 0)]:
        tx = s.b(tx, y + 8, 14 + len(l) * 10, l, on, h=20)
    s.t(x + 10, y + 52, '(루프 브라우저도 같은 자리)', 10, MUTED)
    for j in range(10):
        s.r(x + 8, y + 64 + j * 24, w - 16, 20, '#36363A', rx=3)

# ---------- 1. 기본 창 (새 프로젝트 직후 상태에 가깝게) ----------
s = S(); menubar(s); controlbar(s)
inspector(s, 0, 76, 230, H - 76)
tracks(s, 230, 76, W - 230, H - 76, n=10)
s.note(240, 640, '보이는 단추: 컨트롤 막대 ~25개 + 트랙마다 M S R I 4개 — 나머지는 전부 메뉴·우클릭·단축키')
s.save('L01-main-default')

# ---------- 2. 패널을 다 연 창 ----------
s = S(); menubar(s); controlbar(s)
library(s, 0, 76, 190, H - 76)
inspector(s, 190, 76, 200, H - 76)
tracks(s, 390, 76, W - 390 - 260, 470, n=10, headw=170, globals_open=True)
browser(s, W - 260, 76, 260, H - 76)
pianoroll(s, 390, 546, W - 390 - 260, H - 546)
s.tag(95, 96, 1); s.tag(290, 96, 2); s.tag(700, 140, 3); s.tag(W - 130, 96, 4); s.tag(700, 560, 5)
s.save('L02-main-all-panels')

# ---------- 3. 컨트롤 막대 해부 ----------
s = S(h=640)
controlbar(s, 20)
s.r(0, 72, W, 52, '#34343A')
x = 12
for l in ['나누기', '합치기', '반복', '퀀타이즈', '루프', '자동 펀치', '바꿔', '캐치', '튜너', '바운스', '노멀라이즈', '…']:
    x = s.b(x, 87, 14 + len(l) * 11, l)
s.t(x + 20, 102, '← 툴바 (기본은 꺼짐, "툴바" 단추로 켬)', 11, MUTED)
rows = [
    ('1', '보기 단추 6개', '라이브러리·인스펙터·툴바·스마트 컨트롤·믹서·편집기 — 패널을 켜고 끄기만 한다. 기능이 아니라 "어디를 볼지"'),
    ('2', '트랜스포트 6개', '되감기·빨리감기·정지·재생·녹음·사이클. 녹음 방식(펀치·테이크·바꿔)은 녹음 메뉴와 단추 우클릭 안'),
    ('3', 'LCD 하나', '위치·템포·박자·조를 한 칸에. 숫자를 끌거나 두 번 눌러 고친다 — 별도 입력칸이 없다'),
    ('4', '모드 단추 4~5개', '튜너·바꿔·솔로·카운트인·메트로놈. 우클릭하면 그 설정이 나온다'),
    ('5', '창 단추 4개', '목록 편집기·메모장·루프·브라우저 — 오른쪽 패널 토글'),
    ('·', '사용자화', '컨트롤 막대 우클릭 → "컨트롤 막대 및 표시 사용자화" 로 단추를 넣고 뺀다. 기본값은 적게'),
]
for i, (n, a, b2) in enumerate(rows):
    yy = 170 + i * 66
    s.tag(30, yy + 10, n); s.t(52, yy + 15, a, 15, TXT, 700); s.t(52, yy + 40, b2, 13, MUTED)
s.save('L03-control-bar')

# ---------- 4. 기능이 숨어 있는 곳 ----------
s = S()
cols4 = [
    ('트랙 영역 로컬 메뉴 — 편집', ['되돌리기 / 다시', '자르기·복사·붙이기', '나누기 (재생 위치에서)', '합치기', '반복 (⌘R)', '루프 켜기', '에일리어스 만들기', '뮤트 (M)', '잠그기', '색 (⌥C)', '퀀타이즈']),
    ('트랙 메뉴 (메뉴 막대)', ['새 트랙… (⌥⌘N)', '트랙 복제', '트랙 스택 만들기', '트랙 숨기기 (H)', '트랙 보호', '프리즈', '바운스 인 플레이스', '트랙 색', '트랙 삭제']),
    ('리전 우클릭', ['자르기·복사·붙이기', '나누기·합치기', '루프·에일리어스', '뮤트·잠금', '색', '이름 바꾸기', 'MIDI 변환 ›', '바운스 인 플레이스', '오토메이션 ›']),
    ('보기 메뉴 / 단축키', ['글로벌 트랙 보기 (G)', '글로벌 트랙 고르기 (⌥G)', '인스펙터 (I)', '라이브러리 (Y)', '편집기 (E)', '믹서 (X)', '스마트 컨트롤 (B)', '오토메이션 (A)', '확대 (⌘←→↑↓)']),
]
for i, (title, items) in enumerate(cols4):
    x = 30 + i * 352
    s.r(x, 40, 330, 60 + len(items) * 30, PANEL, rx=10)
    s.t(x + 16, 72, title, 14, ACC, 700)
    for j, it in enumerate(items):
        s.t(x + 20, 112 + j * 30, it, 13, TXT)
s.t(30, 520, 'Logic 의 원칙', 18, TXT, 700)
for j, l in enumerate([
    '1. 화면에 늘 보이는 것은 "지금 무엇을 볼지"(패널 토글)와 재생뿐이다',
    '2. 대상에 하는 일(나누기·색·잠금…)은 대상 위에서 — 우클릭과 그 영역의 로컬 메뉴(편집·기능·보기)',
    '3. 편집기 설정(격자·퀀타이즈·세기)은 그 편집기 머리에만 — 트랙 영역에는 없다',
    '4. 글로벌 트랙(구간·마커·템포·코드)은 기본 숨김, G 하나로 켠다',
    '5. 고른 대상의 속성은 왼쪽 인스펙터 한 곳 — 리전 / 트랙 / 채널 스트립 순으로 쌓인다',
    '6. 거의 모든 것에 단축키 — 단축키 안내는 화면에 깔지 않고 빠른 도움말(?)로',
]):
    s.t(30, 556 + j * 30, l, 14, TXT)
s.save('L04-where-functions-live')

# ---------- 5. 믹서 ----------
s = S(); menubar(s); controlbar(s)
s.r(0, 76, W, H - 76, '#262628')
localbar(s, 0, 76, W, ['편집', '기능', '보기', '·', '단일', '트랙', '전체', '·', '오디오', '인스트루먼트', 'Aux', '버스', '입력', '출력', '마스터', 'MIDI'])
for i in range(14):
    cx = 8 + i * 101
    s.r(cx, 110, 95, H - 120, '#333337', rx=4)
    for j, l in enumerate(['설정', '게인', 'EQ ▭', 'MIDI FX', '입력', '오디오 FX', 'FX 2', '센드', '출력', '그룹', '읽기']):
        s.r(cx + 5, 118 + j * 24, 85, 19, '#46464C', rx=3); s.t(cx + 47, 131 + j * 24, l, 9, TXT, 400, 'middle')
    py = 118 + 11 * 24 + 8
    s.p.append(f"<circle cx='{cx + 47}' cy='{py + 14}' r='12' fill='none' stroke='#9A9AA2' stroke-width='2'/>")
    s.r(cx + 44, py + 36, 6, 300, '#1E1E20'); s.r(cx + 60, py + 36, 6, 300, '#1E1E20')
    s.r(cx + 30, py + 150, 36, 14, '#9A9AA2', rx=2)
    s.b(cx + 14, H - 70, 30, 'M', h=18); s.b(cx + 50, H - 70, 30, 'S', h=18)
    s.t(cx + 47, H - 22, ['킥', '스네어', '하이햇', '베이스', '어쿠', '패드', '리드', '보컬', '코러스', '스트링', 'Aux 1', 'Aux 2', '출력', '마스터'][i], 10, TXT, 500, 'middle')
s.save('L05-mixer')
print('ok')

# ---------- 6. 우리 단추 → Logic 에서의 자리 ----------
s = S(h=1000, bg='#FFFFFF')
s.t(30, 50, '지금 우리 화면 위쪽 단추가 Logic 에서는 어디 있나', 22, '#111', 700)
s.t(30, 80, '우리: 위 3줄 + 글로벌 4줄에 단추·입력 약 55개  /  Logic 기본: 컨트롤 막대 1줄 약 25개', 14, '#555')
rows = [
    ('머리 줄', '편집기·믹서·스텝·라이브루프·오토 보기 단추', '컨트롤 막대 왼쪽 보기 단추 (같음)', '유지'),
    ('머리 줄', '바꿔 · 펀치 · 담기', '녹음 메뉴 / 녹음 단추 우클릭', '숨김'),
    ('머리 줄', '건반 · 설정 · 폴더 · 마스터링', '윈도우 메뉴 · Logic Pro 설정 · 파일 메뉴', '메뉴로'),
    ('둘째 줄', '격자 · 음 길이 · 스윙 · 세기 · 퀀타이즈 · 색', '피아노 롤 머리 (편집기 안)', '편집기 안으로'),
    ('둘째 줄', '마디 수', '파일 › 프로젝트 설정 / 끝 표시 끌기', '메뉴로'),
    ('둘째 줄', '템포 변화', '글로벌 템포 트랙 (G)', '숨김'),
    ('둘째 줄', '복사 · 붙여넣기', '편집 메뉴 · ⌘C/⌘V', '메뉴로'),
    ('둘째 줄', '기능…', '기능 로컬 메뉴', '로컬 메뉴'),
    ('둘째 줄', '확대 가로/세로 ±', '오른쪽 위 확대 막대 하나 · ⌘화살표', '막대 하나'),
    ('트랙 줄', '나누기 · 합치기 · 반복 · 에일리어스 · 클립 뮤트', '리전 우클릭 · 편집 로컬 메뉴', '우클릭'),
    ('트랙 줄', '트랙 색 · 보호 · 숨기기 · 스택 · 트랙 복제', '트랙 메뉴 · 트랙 헤더 우클릭', '우클릭'),
    ('트랙 줄', '+ 트랙 · + 오디오', '트랙 헤더 위 + 하나 (종류는 대화창)', '하나로'),
    ('트랙 줄', '글로벌', 'G 단추 (기본 꺼짐)', '기본 꺼짐'),
    ('글로벌', '구간 · 마커 · 코드 · 템포 줄의 단추들', '각 글로벌 트랙 헤더 안, 우클릭', '숨김'),
    ('트랙 헤더', '악기 · 프리셋 선택 · 볼륨·팬 · A · ✕', 'M S R I 만. 악기·볼륨은 인스펙터/믹서, 삭제는 메뉴', '줄이기'),
    ('오른쪽', '음 편집 · 컨트롤 · 브라우저 탭', '왼쪽 인스펙터 + 오른쪽 브라우저 각자 토글', '나누기'),
    ('바닥', '단축키 안내 줄', '빠른 도움말(?) — 기본 꺼짐', '숨김'),
]
y = 120
s.r(30, y, 1380, 32, '#F2F2F4'); 
for xx, h in [(40, '자리'), (150, '우리 지금'), (640, 'Logic'), (1230, '제안')]:
    s.t(xx, y + 21, h, 13, '#111', 700)
for i, (a, b2, c, d) in enumerate(rows):
    yy = y + 32 + i * 46
    s.r(30, yy, 1380, 46, '#FFFFFF' if i % 2 else '#FAFAFB')
    s.t(40, yy + 28, a, 13, '#777'); s.t(150, yy + 28, b2, 14, '#111'); s.t(640, yy + 28, c, 14, '#333')
    col = '#1F8A4C' if d == '유지' else '#B5520A'
    s.t(1230, yy + 28, d, 14, col, 700)
s.save('L06-ours-vs-logic')
