// **주의**: 이 점검은 이메일·비밀번호 가입으로 계정을 만든다 — 서버를 `PASSWORD_AUTH_ENABLED=true` 로 띄워야 돈다 (기본은 구글 로그인만)
// 계정 흐름 점검 — **서버가 떠 있어야 한다** (server/ 에서 docker compose --profile app up -d, 개발 서버 5173).
// 가입 → 프로필 단추 → 이름 바꾸기 → 비밀번호 바꾸기 → 로그아웃 → 새 비밀번호로 로그인 → 새로고침 뒤 유지 → 모든 기기 로그아웃
import { launch, sleep } from './lib/chrome.mjs';
const URL_APP = process.env.APP_URL || 'http://127.0.0.1:5173/';
const b = await launch({ port: 9335 });
const out = []; const rec = (name, ok, detail = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const setInput = (sel, v) => b.ev(`(() => { const i = ${sel}; if (!i) return 'none'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
const L = (label) => `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
const btn = (t) => `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(t)})`;
const email = `check-${Date.now()}@example.com`; const pw1 = 'first-password-1'; const pw2 = 'second-password-2';
const signedIn = () => b.ev(`document.querySelector('[aria-label="계정"]')?.dataset.signedIn`);
const openAccount = async () => { await b.clickEl(L('계정')); await sleep(600); };
const authFill = async (mode, pw) => {
  await b.goto(URL_APP + 'login', 1800);
  if (mode === 'signup') { await b.clickEl(btn('계정 만들기')); await sleep(300); }
  await setInput(`document.querySelector('input[type=email]')`, email);
  await setInput(`document.querySelector('input[type=password]')`, pw);
  await b.clickEl(`document.querySelector('form button[type=submit]')`);
  await sleep(2500);
};
try {
  await b.goto(URL_APP, 2500);
  rec('로그인 전 — 프로필 단추가 비로그인으로 보임', (await signedIn()) === 'false');
  await openAccount();
  rec('로그인 전 계정 창 — 안 해도 된다는 안내와 로그인 단추', await b.ev(`!!document.querySelector('[data-account-login]') && document.querySelector('[role=dialog][aria-label="계정"]').textContent.includes('로그인하지 않아도')`));
  await authFill('signup', pw1);
  await b.goto(URL_APP, 2500);
  rec('가입 뒤 — 프로필 단추가 로그인됨', (await signedIn()) === 'true', `${email} · 글자 ${await b.ev(`document.querySelector('[aria-label="계정"]').textContent`)}`);
  await openAccount();
  const text = await b.ev(`document.querySelector('[role=dialog][aria-label="계정"]').textContent`);
  rec('계정 창 — 메일·플랜·곡·용량이 보임', text.includes(email) && /플랜/.test(text) && /곡 만듦|무제한/.test(text) && / B| KB| MB/.test(text), text.replace(/\s+/g, ' ').slice(0, 170));
  await setInput(L('표시 이름'), '점검하는 사람'); await b.clickEl(btn('이름 저장')); await sleep(1200);
  rec('이름 바꾸기 → 프로필 글자가 바뀜', (await b.ev(`document.querySelector('[aria-label="계정"]').textContent`)) === '점');
  await setInput(L('지금 비밀번호'), pw1); await setInput(L('새 비밀번호'), 'short'); await setInput(L('새 비밀번호 다시'), 'short'); await sleep(200);
  const warn = await b.ev(`document.querySelector('[data-password-problem]')?.textContent ?? ''`);
  await setInput(L('새 비밀번호'), pw2); await setInput(L('새 비밀번호 다시'), pw2); await sleep(200);
  await b.clickEl(btn('비밀번호 바꾸기')); await sleep(1500);
  const toast = await b.ev(`document.querySelector('[data-toast]')?.textContent ?? ''`);
  rec('비밀번호 바꾸기 — 짧으면 미리 말하고, 맞으면 바뀜', /10자/.test(warn) && toast.includes('비밀번호를 바꿨습니다'), `${warn} · ${toast.slice(0, 30)}`);
  await b.clickEl(btn('로그아웃')); await sleep(1500);
  rec('로그아웃 → 프로필이 비로그인', (await signedIn()) === 'false');
  await b.goto(URL_APP, 2500);
  rec('로그아웃 뒤 새로고침해도 로그아웃 상태', (await signedIn()) === 'false');
  await authFill('login', pw1);
  await b.goto(URL_APP, 2500);
  rec('옛 비밀번호로는 못 들어감', (await signedIn()) === 'false');
  await authFill('login', pw2);
  await b.goto(URL_APP, 2500);
  rec('새 비밀번호로 로그인 · 새로고침 뒤에도 유지', (await signedIn()) === 'true');
  await openAccount(); await b.clickEl(btn('모든 기기에서 로그아웃')); await sleep(1500);
  await b.goto(URL_APP, 2500);
  rec('모든 기기 로그아웃 → 새로고침해도 로그아웃', (await signedIn()) === 'false');
  // 탈퇴 — 확인 문구를 쳐야 단추가 켜진다
  await authFill('login', pw2); await b.goto(URL_APP, 2500); await openAccount();
  const off = await b.ev(`document.querySelector('[data-delete-account]').disabled`);
  await setInput(L('삭제 확인 문구'), '삭제합니다'); await setInput(L('삭제 확인 비밀번호'), pw2); await sleep(200);
  const on = !(await b.ev(`document.querySelector('[data-delete-account]').disabled`));
  await b.clickEl(`document.querySelector('[data-delete-account]')`); await sleep(1800);
  rec('계정 삭제 — 문구를 쳐야 켜지고, 누르면 로그아웃됨', off && on && (await signedIn()) === 'false', (await b.ev(`document.querySelector('[data-toast]')?.textContent ?? ''`)).slice(0, 40));
  console.log(`콘솔 오류 ${b.errors.length}건` + (b.errors.length ? ' ' + JSON.stringify(b.errors.slice(0, 3)).slice(0, 300) : ''));
} catch (e) { rec('스크립트 실행', false, String(e.stack ?? e).slice(0, 400)); } finally { await b.close(); }
process.exit(out.every(Boolean) ? 0 : 1);
