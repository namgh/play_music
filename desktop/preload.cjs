// 화면에 주는 것은 **"여기는 설치형이다"** 라는 사실뿐이다 — Node 는 넘기지 않는다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resona', {
  kind: 'desktop',
  os: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  // 구글 로그인 — 시스템 브라우저에서 하고, 돌아온 한 번짜리 코드만 화면에 준다 (세션은 화면이 서버에서 받는다)
  googleLogin: () => ipcRenderer.invoke('resona:google-login'),
  // 곡 보관 — 디스크의 파일 (브라우저 저장소의 5MB 제한이 없다). 동기라서 화면 코드는 웹과 같다
  store: {
    get: (key) => ipcRenderer.sendSync('resona:store-get', key),
    set: (key, value) => { const err = ipcRenderer.sendSync('resona:store-set', key, value); if (err) throw new Error(err); },
    remove: (key) => { ipcRenderer.sendSync('resona:store-remove', key); },
    keys: () => ipcRenderer.sendSync('resona:store-keys'),
    reveal: () => ipcRenderer.invoke('resona:store-reveal'),
  },
  // AI 도우미 — 키는 메인 프로세스만 안다. 화면은 물어보고 답만 받는다
  ai: {
    status: () => ipcRenderer.invoke('resona:ai-status'),
    setKey: (key) => ipcRenderer.invoke('resona:ai-set-key', key),
    ask: (request) => ipcRenderer.invoke('resona:ai-ask', request),
  },
});
