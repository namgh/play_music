import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 주의 (M1에서 판단할 것): AudioWorklet 안에서 wasm 을 돌리는 것 자체는 헤더가 필요 없다.
// wasm 바이트를 메인 스레드에서 받아 postMessage 로 넘기면 된다 (워크렛 스코프에는 fetch 가 없다).
// 다만 메인 스레드와 오디오 스레드가 SharedArrayBuffer 로 메모리를 공유하게 되면 그때부터
// COOP/COEP 헤더가 필요해지고, 개발 서버와 배포 호스팅 양쪽을 같이 바꿔야 한다.
// 지금은 필요하지 않아 켜지 않는다 — COEP 는 CORP 헤더 없는 외부 리소스를 전부 막기 때문이다.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // **`/v1` 을 서버로 넘긴다.** 이게 없으면 프론트가 자기 자신(5173)에게 물어보고
    // 404 를 받는다. 같은 오리진으로 보내야 리프레시 쿠키(path=/v1/auth)도 실린다
    proxy: { '/v1': { target: 'http://localhost:8000', changeOrigin: true } },
  },
  build: { target: 'es2022' },
});
