// 변환·해석 워커: DWG → DXF(LibreDWG WASM, @mlightcad/libredwg-web의 dwg_write_dxf) → DXF.parse(코어 dxf.js)
// 해석까지 워커에서 하는 이유: 수십 MB짜리 도면 글자를 줄로 나누며 생기는 임시 쓰레기가 화면 엔진에 쌓이지 않게,
// 다 쓴 워커를 통째로 내려 한 번에 비우려고. 화면 쪽으로는 해석이 끝난 도면 객체만 보낸다.
// op: 'dxf' = 변환만(DXF 바이트를 돌려줌) · 'parse' = DXF 해석만 · 'both' = 작은 DWG를 한 번에
// 큰 DWG는 app.js가 'dxf'와 'parse'를 서로 다른 워커에서 돌린다 (변환기 메모리와 해석 메모리가 겹치지 않게)
import './worker-env.js';
import './core/dxf.js';
import createModule from './vendor/libredwg/libredwg-web.js';

let modP = null;
const mod = () => (modP ||= createModule());

async function toDxf(bytes) {
  const M = await mod();
  M.FS.writeFile('/in.dwg', new Uint8Array(bytes));
  let err;
  try { err = M.dwg_write_dxf('/in.dwg', '/out.dxf'); } finally { M.FS.unlink('/in.dwg'); }
  let out = null;
  try { out = M.FS.readFile('/out.dxf'); M.FS.unlink('/out.dxf'); } catch (e) { /* 출력 없음 */ }
  // LibreDWG는 경고만 있어도 오류코드를 낼 수 있어 결과 파일 유무로 판단한다 (데스크톱과 같음)
  if (!out || !out.length) throw new Error(`DWG 변환 실패 (코드 ${err})`);
  return out;
}

self.onmessage = async (ev) => {
  const { id, op, bytes } = ev.data;
  try {
    if (op === 'dxf') {
      const out = await toDxf(bytes);
      self.postMessage({ id, ok: true, dxf: out.buffer }, [out.buffer]);
      return;
    }
    let u8 = op === 'both' ? await toDxf(bytes) : new Uint8Array(bytes);
    const doc = self.DXF.parse(u8);
    u8 = null;
    self.postMessage({ id, ok: true, doc });
  } catch (e) {
    modP = null; // 메모리 부족 등으로 모듈이 망가졌을 수 있어 다음엔 새로 만든다
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
