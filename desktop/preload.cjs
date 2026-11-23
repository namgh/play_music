// 화면에 주는 것은 **"여기는 설치형이다"** 라는 사실뿐이다 — Node 는 넘기지 않는다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resona', {
  kind: 'desktop',
  os: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  // 구글 로그인 — 시스템 브라우저에서 하고, 돌아온 한 번짜리 코드만 화면에 준다 (세션은 화면이 서버에서 받는다)
  googleLogin: () => ipcRenderer.invoke('resona:google-login'),
});
