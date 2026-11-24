// 설치형 껍데기 (Electron). **화면과 엔진은 웹과 같은 한 벌이다** — 여기는 창·파일·장치만 맡는다.
//
// - 개발: `npm run desktop:dev` → 개발 서버(5173)를 그대로 띄운다
// - 배포: `dist/` 를 `app://resona/` 로 내준다. `/v1/*` 는 여기서 서버로 넘긴다 —
//   화면이 보기에는 같은 오리진이라 웹과 같은 코드(`credentials: 'include'`)가 그대로 돈다.
//   리프레시 쿠키는 이 프로세스의 쿠키 저장소에 남고, 그 저장소는 OS 보관함의 키로 잠긴다
//   (맥 키체인 · 윈도우 DPAPI). 화면(렌더러) 쪽 스크립트는 쿠키를 읽을 수 없다
const { app, BrowserWindow, protocol, net, shell, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const crypto = require('node:crypto');

const DEV_URL = process.env.RESONA_DEV_URL || '';
const API = (process.env.RESONA_API || 'http://localhost:8000').replace(/\/$/, '');
const DIST = path.join(__dirname, '..', 'dist');
const APP_ORIGIN = 'app://resona';
const SMOKE = !!process.env.RESONA_SMOKE;
// 시험은 진짜 사용자 자료와 섞이지 않게 따로 둔 폴더에서 돈다
if (process.env.RESONA_USER_DATA) app.setPath('userData', process.env.RESONA_USER_DATA);

// 다채널 출력 — 장치가 5.1·7.1 을 받으면 그대로 연다 (윈도우는 이 스위치가 있어야 스테레오로 안 접힌다)
app.commandLine.appendSwitch('try-supported-channel-layouts');
// 재생 단추를 누르기 전에도 소리 엔진을 깨울 수 있게 (설치형은 광고가 없으니 막을 이유가 없다)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// 한 번에 한 창 — 두 번째로 켜면 (딥링크로 돌아올 때도) 이미 뜬 창을 앞으로
if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;

/** 파일 경로가 dist 밖으로 나가지 못하게 한다 */
function distFile(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const full = path.join(DIST, clean);
  if (!full.startsWith(DIST)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

function serveApp() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // 서버로 가는 요청 — 같은 오리진처럼 보이게 여기서 넘긴다. 쿠키는 기본 세션 저장소가 맡는다
    if (url.pathname.startsWith('/v1/')) {
      const headers = new Headers(request.headers);
      headers.delete('origin');
      headers.delete('referer');
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      try {
        // credentials: 'include' — 이 프로세스의 쿠키 저장소에서 리프레시 쿠키를 싣고, 받은 Set-Cookie 를 거기 담는다
        return await net.fetch(API + url.pathname + url.search, { method: request.method, headers, body, redirect: 'manual', credentials: 'include' });
      } catch (err) {
        return new Response(JSON.stringify({ error: { code: 'network', message: String(err && err.message || err) } }),
          { status: 502, headers: { 'content-type': 'application/json' } });
      }
    }
    // 화면 파일. 없는 경로는 index.html (주소로 화면을 고르는 앱이다 — /login, /verify…)
    const file = distFile(url.pathname) || path.join(DIST, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#ffffff',
    show: !SMOKE,
    title: 'RESONA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  const home = DEV_URL || `${APP_ORIGIN}/`;
  const homeOrigin = new URL(home).origin === 'null' ? APP_ORIGIN : new URL(home).origin;

  // 바깥 링크는 브라우저로 — 앱 창이 남의 사이트가 되지 않게
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    const to = new URL(url);
    const inside = to.origin === homeOrigin || url.startsWith(APP_ORIGIN) || to.origin === new URL(API).origin
      || to.hostname === 'accounts.google.com';
    if (!inside) { event.preventDefault(); void shell.openExternal(url); }
  });
  // 구글 로그인은 서버 → 구글 → 서버 → "웹 주소" 로 돌아온다. 그 마지막 걸음을 앱 화면으로 바꾼다
  const webOrigin = process.env.RESONA_WEB_ORIGIN || '';
  win.webContents.on('will-redirect', (event, url) => {
    if (webOrigin && url.startsWith(webOrigin) && !DEV_URL) {
      event.preventDefault();
      const to = new URL(url);
      void win.loadURL(`${APP_ORIGIN}${to.pathname}${to.search}`);
    }
  });

  void win.loadURL(home);
  if (SMOKE) win.webContents.once('did-finish-load', () => { const m = process.env.RESONA_SMOKE; void (m === 'signup' || m === 'session' ? smokeLogin(m) : smoke()); });
  win.on('closed', () => { win = null; });
}

/**
 * 로그인 시험 — `signup` 은 새 계정으로 가입하고, `session` 은 **껐다 켠 뒤에도** 로그인이 남았는지 본다.
 * 화면 스크립트가 쿠키를 읽을 수 없는지도 같이 본다
 */
async function smokeLogin(mode) {
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const email = process.env.RESONA_SMOKE_EMAIL;
    const report = await win.webContents.executeJavaScript(`(async () => {
      const out = { mode: ${JSON.stringify(mode)} };
      if (out.mode === 'signup') {
        const r = await fetch('/v1/auth/signup', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(email)}, password: 'desktop-smoke-pw-1' }) });
        out.signup = r.status;
      }
      const r2 = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' });
      out.refresh = r2.status;
      const token = r2.ok ? (await r2.json()).access_token : null;
      if (token) { const me = await fetch('/v1/me', { headers: { authorization: 'Bearer ' + token } }); out.me = me.status; out.email = me.ok ? (await me.json()).email : null; }
      out.cookieVisibleToPage = document.cookie.includes('resona_refresh');
      out.profile = document.querySelector('[aria-label="계정"]')?.dataset.signedIn ?? null;
      return out;
    })()`);
    const jar = await session.defaultSession.cookies.get({ name: 'resona_refresh' });
    report.cookieInJar = jar.length; report.httpOnly = jar[0] ? jar[0].httpOnly : null;
    await session.defaultSession.cookies.flushStore();
    console.log('SMOKE ' + JSON.stringify(report));
  } catch (err) {
    console.log('SMOKE ' + JSON.stringify({ error: String(err && err.message || err) }));
  }
  app.quit();
}

/** 자동 시험 — 화면이 뜨고 엔진이 깨는지, 출력이 몇 채널까지 열리는지 찍고 끝낸다 */
async function smoke() {
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const report = await win.webContents.executeJavaScript(`(async () => {
      const ctx = new AudioContext();
      const max = ctx.destination.maxChannelCount;
      let opened = ctx.destination.channelCount;
      try { ctx.destination.channelCount = max; ctx.destination.channelCountMode = 'explicit'; ctx.destination.channelInterpretation = 'discrete'; opened = ctx.destination.channelCount; } catch (e) { opened = 'error: ' + e.message; }
      let worklet = 'ok';
      try { await ctx.audioWorklet.addModule('./ks-worklet.js'); } catch (e) { worklet = 'error: ' + e.message; }
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput').length;
      const out = {
        origin: location.origin, title: document.title,
        platform: window.resona ? { kind: window.resona.kind, os: window.resona.os, googleLogin: typeof window.resona.googleLogin } : null,
        app: !!document.querySelector('header'), text: document.body.innerText.slice(0, 60),
        maxChannels: max, openedChannels: opened, sampleRate: ctx.sampleRate, worklet, outputDevices: devices,
        setSinkId: typeof ctx.setSinkId === 'function',
        me: await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' }).then((r) => r.status).catch((e) => 'error: ' + e.message),
      };
      await ctx.close();
      return out;
    })()`);
    console.log('SMOKE ' + JSON.stringify(report));
  } catch (err) {
    console.log('SMOKE ' + JSON.stringify({ error: String(err && err.message || err) }));
  }
  app.quit();
}

ipcMain.handle('resona:info', () => ({
  kind: 'desktop', os: process.platform, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
}));

/**
 * 구글 로그인 — **시스템 브라우저에서 한다.** 구글은 앱에 든 창에서의 로그인을 막고,
 * 사용자도 주소창이 보여야 진짜 구글인지 안다.
 *
 *   앱: 127.0.0.1 의 빈 포트를 열고, 검증값(verifier)을 만들어 그 해시만 서버에 준다
 *   → 브라우저: 구글 로그인 → 서버 콜백 → `http://127.0.0.1:포트/callback?code=…`
 *   → 앱: 그 코드와 검증값을 화면에 돌려준다 → 화면이 서버에서 세션으로 바꾼다
 *
 * 코드는 한 번·2분짜리이고 검증값 없이는 못 쓴다 — 다른 프로그램이 포트를 엿봐도 소용없다.
 */
let loginServer = null;
ipcMain.handle('resona:google-login', async () => {
  if (loginServer) { loginServer.close(); loginServer = null; }
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const page = (text) => `<!doctype html><meta charset="utf-8"><title>RESONA</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>${text}</p>`;

  const server = http.createServer();
  loginServer = server;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('로그인을 기다리다 시간이 지났습니다. 다시 해 주세요')), 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(code ? '로그인했습니다. 이 창을 닫고 RESONA 로 돌아가세요.' : '로그인을 마치지 못했습니다. RESONA 에서 다시 해 주세요.'));
      clearTimeout(timer);
      if (code) resolve(code); else reject(new Error('로그인을 마치지 못했습니다'));
    });
  });

  try {
    const res = await net.fetch(`${API}/v1/auth/google/start?desktop_port=${port}&desktop_challenge=${challenge}`);
    const body = await res.json();
    if (!res.ok || !body.authorization_url) throw new Error((body.error && body.error.message) || '구글 로그인을 시작하지 못했습니다');
    // 구글 주소만 연다 — 서버가 엉뚱한 주소를 주더라도 브라우저로 넘기지 않는다
    if (new URL(body.authorization_url).hostname !== 'accounts.google.com') throw new Error('로그인 주소가 올바르지 않습니다');
    await shell.openExternal(body.authorization_url);
    const code = await done;
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    return { code, verifier };
  } finally {
    server.close();
    if (loginServer === server) loginServer = null;
  }
});

app.whenReady().then(() => {
  if (!DEV_URL) serveApp();
  // 마이크·MIDI 는 우리 화면에만 준다
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const ours = wc === (win && win.webContents);
    callback(ours && ['media', 'midi', 'midiSysex', 'speaker-selection', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ['media', 'midi', 'midiSysex', 'speaker-selection'].includes(permission));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SMOKE) app.quit(); });
