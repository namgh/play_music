/**
 * 의존성 없는 정적 서버.
 *
 * AudioWorklet 의 addModule() 은 file:// 에서 동작하지 않으므로 http 로 띄워야 한다.
 * npx 로 뭔가 받아오지 않아도 되게 여기 20줄로 둔다.
 *
 *   npm run m0   →  http://localhost:5175
 *
 * 5173 은 Vite 개발 서버가 쓰므로 비켜 둔다.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5175;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' || rel === '\\' ? 'index.html' : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // 스파이크는 매번 새로 읽는 게 낫다
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`M0 프로토타입: http://localhost:${PORT}`);
});
