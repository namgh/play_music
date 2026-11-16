# design — 앱 화면 시안 (FigCraft)

`LOGIC_PARITY.md` 의 영역을 채우면서 **새로 만들거나 고친 화면**을 여기 남긴다.
톤앤매너는 지금 앱(v4 "기기")을 그대로 따른다 — `studio-app.figcraft` 의
"00 · 톤앤매너" 페이지가 그 토큰(`src/index.css`)이다.

| 파일 | 내용 |
|---|---|
| `studio-app.figcraft` | FigCraft 문서. 영역마다 페이지 하나 (`01 · 편곡·글로벌 트랙` …) |
| `screens/<이름>.svg` | **고칠 수 있는 SVG** — 상자·글자·아이콘이 레이어로 살아 있다. FigCraft 가 이걸 가져온다. 글로 된 파일이라 git diff 로 화면 변화를 볼 수 있다 |
| `screens/<이름>.png` | 같은 화면의 실제 캡처 (대조용) |
| `screens/index.json` | 화면 목록 — 이름 · 영역 번호 · 제목 |

`mockup/studio-redesign.figcraft` 는 이전 시안(v1–v5)과 Logic 분석이다. 이미지가 많아
20MB 라서, 계속 바뀌는 앱 시안은 작은 이 파일로 따로 둔다.

## 만드는 법

화면은 손으로 그리지 않고 **실제 앱을 원하는 상태로 만든 뒤 떠 온다.** 손으로 그린
시안은 코드와 금방 어긋나고, 떠 온 시안은 언제든 다시 만들 수 있다.

```
npm run dev                      # 다른 터미널
npm run design:capture [이름…]   # design/screens/ 에 svg·png
```

화면 상태(무엇을 누른 상태인가)는 `tools/capture-screens.mjs` 의 `SCREENS` 에 코드로
적는다. 곡은 `tools/lib/demo-project.ts` 의 데모 곡("비 오는 새벽")으로 매번 같다.

그다음 FigCraft 에서 `screens/*.svg` 를 영역 페이지로 가져온다(`file.import`, 화면당
1540px 간격). FigCraft 는 `~/figcraft-work` 밖을 못 읽어서 거기로 복사해 가져오고,
저장한 문서를 다시 여기로 복사한다.
