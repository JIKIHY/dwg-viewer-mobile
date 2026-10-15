// DWG → DXF 변환 워커. LibreDWG(WASM, @mlightcad/libredwg-web)의 dwg_write_dxf를 쓴다.
// 데스크톱의 dwg2dxf와 같은 LibreDWG 코드라 결과 DXF를 그대로 DXF.parse에 넘길 수 있다.
import createModule from './vendor/libredwg/libredwg-web.js';

let modP = null;
const mod = () => (modP ||= createModule());

self.onmessage = async (ev) => {
  const { id, bytes } = ev.data;
  try {
    const M = await mod();
    M.FS.writeFile('/in.dwg', new Uint8Array(bytes));
    let err;
    try { err = M.dwg_write_dxf('/in.dwg', '/out.dxf'); } finally { M.FS.unlink('/in.dwg'); }
    let out = null;
    try { out = M.FS.readFile('/out.dxf'); M.FS.unlink('/out.dxf'); } catch (e) { /* 출력 없음 */ }
    // LibreDWG는 경고만 있어도 오류코드를 낼 수 있어 결과 파일 유무로 판단한다 (데스크톱과 같음)
    if (!out || !out.length) throw new Error(`DWG 변환 실패 (코드 ${err})`);
    self.postMessage({ id, ok: true, dxf: out.buffer }, [out.buffer]);
  } catch (e) {
    modP = null; // 메모리 부족 등으로 모듈이 망가졌을 수 있어 다음엔 새로 만든다
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
