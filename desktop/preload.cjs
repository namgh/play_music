// 화면에 주는 것은 **"여기는 설치형이다"** 라는 사실뿐이다 — Node 는 넘기지 않는다
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('resona', {
  kind: 'desktop',
  os: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
});
