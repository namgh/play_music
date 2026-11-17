/**
 * 오디오 에셋 저장소 — 녹음·가져온 소리의 바이트 (IndexedDB).
 *
 * 프로젝트(JSON)에는 에셋 id 만 둔다. 소리는 수 MB 라 localStorage 에 못 넣고, 자동 저장
 * 때마다 다시 쓰면 안 된다. id 는 **내용의 SHA-256** — 같은 파일을 두 번 넣어도 하나만 남는다.
 *
 * 한계(이번 단계): 파일로 저장(.json)하면 소리는 따라가지 않는다. 다른 기기로 옮기려면
 * 서버 동기화나 묶음 파일(.zip)이 필요하다 — `LOGIC_PARITY.md` 에 적어 둔다.
 */

const DB = 'studio-assets';
const STORE = 'audio';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function assetIdOf(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function putAsset(bytes: ArrayBuffer): Promise<string> {
  const id = await assetIdOf(bytes);
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return id;
}

export async function getAsset(id: string): Promise<ArrayBuffer | null> {
  const db = await open();
  const value = await new Promise<ArrayBuffer | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

/** 컨텍스트마다 디코딩한 버퍼 — 같은 에셋을 두 번 풀지 않는다 */
const decoded = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer | null>>>();

export function decodeAsset(ctx: BaseAudioContext, id: string): Promise<AudioBuffer | null> {
  let map = decoded.get(ctx);
  if (!map) { map = new Map(); decoded.set(ctx, map); }
  let p = map.get(id);
  if (!p) {
    p = getAsset(id).then((bytes) => (bytes ? ctx.decodeAudioData(bytes.slice(0)) : null)).catch(() => null);
    map.set(id, p);
  }
  return p;
}

/** 여러 에셋을 풀어 id → 버퍼 */
export async function decodeAll(ctx: BaseAudioContext, ids: readonly string[]): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  await Promise.all([...new Set(ids)].map(async (id) => {
    const b = await decodeAsset(ctx, id);
    if (b) out.set(id, b);
  }));
  return out;
}

/** 파형 그리기용 봉우리 — 칸 `bins` 개의 최대 진폭 (0~1) */
export function peaks(buffer: AudioBuffer, bins: number): Float32Array {
  const out = new Float32Array(bins);
  const step = Math.max(1, Math.floor(buffer.length / bins));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let b = 0; b < bins; b++) {
      let m = 0;
      for (let i = b * step, end = Math.min(data.length, i + step); i < end; i++) {
        const v = data[i]! < 0 ? -data[i]! : data[i]!;
        if (v > m) m = v;
      }
      if (m > out[b]!) out[b] = m;
    }
  }
  return out;
}
