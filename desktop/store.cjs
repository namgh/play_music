// 곡 보관 — 브라우저 저장소(5MB) 대신 **디스크의 파일**에 둔다.
//
// 화면은 `Kv`(get/set/remove) 하나만 본다 (`src/editor/library.ts`). 설치형에서는 그 뒤가 이 파일이다:
// 열쇠 하나 = 파일 하나, `userData/store/` 아래. 동기 IPC 라 화면 쪽 코드는 웹과 같다.
// 쓰기는 임시 파일에 쓰고 이름을 바꾼다 — 쓰다가 꺼져도 반쪽짜리 곡 파일이 남지 않는다.
const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

function dir() {
  const d = path.join(app.getPath('userData'), 'store');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 열쇠는 우리 코드가 만들지만, 파일 이름으로 쓰기 전에 그래도 막는다 (경로 탈출·긴 이름)
const fileOf = (key) => path.join(dir(), encodeURIComponent(String(key)).slice(0, 180) + '.json');

function register() {
  ipcMain.on('resona:store-get', (event, key) => {
    try { event.returnValue = fs.readFileSync(fileOf(key), 'utf8'); } catch { event.returnValue = null; }
  });
  ipcMain.on('resona:store-set', (event, key, value) => {
    try {
      const file = fileOf(key);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, String(value));
      fs.renameSync(tmp, file);
      event.returnValue = null;
    } catch (err) { event.returnValue = String(err && err.message || err); }
  });
  ipcMain.on('resona:store-remove', (event, key) => {
    try { fs.rmSync(fileOf(key), { force: true }); } catch { /* 없으면 된 것 */ }
    event.returnValue = null;
  });
  ipcMain.on('resona:store-keys', (event) => {
    try { event.returnValue = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => decodeURIComponent(f.slice(0, -5))); } catch { event.returnValue = []; }
  });
  ipcMain.handle('resona:store-reveal', () => require('electron').shell.openPath(dir()));
}

module.exports = { register, dir };
