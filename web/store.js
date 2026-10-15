// 최근 도면 보관 (IndexedDB). 휴대폰은 파일 경로를 다시 열 수 없어 원본 파일 내용을 그대로 보관한다.
// XREF를 이름으로 찾을 때도 이 보관함을 뒤진다.
(function (global) {
  'use strict';
  const DB = 'dwgv', STORE = 'files', MAX_FILES = 30, MAX_BYTES = 300 * 1024 * 1024;
  let dbP = null;
  const db = () => (dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  };
  const keyOf = (name) => name.normalize('NFC').toLowerCase();

  const Store = {
    keyOf,
    // 목록 (내용 제외, 최근 연 순)
    async list() {
      try {
        const all = await tx('readonly', (s) => s.getAll());
        return all.map(({ key, name, size, opened, main, path }) => ({ key, name, size, opened, main, path })).sort((a, b) => b.opened - a.opened);
      } catch (e) { return []; }
    },
    async get(name) {
      try { return await tx('readonly', (s) => s.get(keyOf(name))); } catch (e) { return null; }
    },
    // main: 사용자가 직접 연 도면(최근 목록에 보임). XREF로만 쓰인 파일은 main=false
    async put(name, bytes, main, path) {
      try {
        const key = keyOf(name);
        const old = await tx('readonly', (s) => s.get(key));
        await tx('readwrite', (s) => s.put({ key, name, size: bytes.byteLength, opened: Date.now(), main: !!main || !!(old && old.main), path: path || (old && old.path) || null, bytes }));
        await Store.prune();
      } catch (e) { console.warn('보관 실패', e); }
    },
    async touch(name) {
      const r = await Store.get(name);
      if (r) { r.opened = Date.now(); r.main = true; await tx('readwrite', (s) => s.put(r)); }
    },
    async remove(name) {
      try { await tx('readwrite', (s) => s.delete(keyOf(name))); } catch (e) { /* 무시 */ }
    },
    async prune() {
      const list = await Store.list();
      let total = 0;
      const drop = [];
      list.forEach((f, i) => { total += f.size; if (i >= MAX_FILES || total > MAX_BYTES) drop.push(f.key); });
      if (drop.length) await tx('readwrite', (s) => drop.forEach((k) => s.delete(k)));
    },
  };
  global.Store = Store;
})(window);
