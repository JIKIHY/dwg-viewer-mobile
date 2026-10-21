// 모바일 화면 동작: 파일 열기·변환, 터치 이동/확대, 측정(십자선 + 스냅), 레이어·검색·XREF 패널
// 도면 해석(DXF)·전개(Scene)·그리기(View)는 데스크톱 dwg-viewer의 코어를 그대로 쓴다 (sync-core.sh).
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const MAX_DPR = 2; // 휴대폰 3배 화면은 2배로 그려도 충분하고 훨씬 가볍다
  const dprOf = () => Math.min(MAX_DPR, window.devicePixelRatio || 1);
  const view = new TileView($('#gl'), $('#text'));
  const ui = $('#ui');
  const uctx = ui.getContext('2d');

  const S = {
    mainKey: null, mainName: '', mainDoc: null,
    docs: new Map(), docLoads: new Map(), // 파일 키(소문자 이름) → 파싱된 도면
    xrefs: [], overrides: {}, attached: [],
    scene: null, tool: 'pan',
    measures: [], cur: [], mouse: null, snap: null, index: null,
    layerVis: new Map(), groupVis: new Map(), flash: null,
  };
  // 이번에 고른 파일들 (키 → {name, bytes}). XREF를 이름으로 찾을 때 먼저 본다
  const pool = new Map();

  const UNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
  const fmt = (v, d = 2) => v.toLocaleString('ko-KR', { maximumFractionDigits: d });
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const isDrawing = (n) => /\.(dwg|dxf)$/i.test(n);
  const BENCH = /bench/.test(location.search);
  const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
  const nativeR = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nativeReply;
  const ask = (msg) => (nativeR ? nativeR.postMessage(msg) : Promise.resolve(null)); // 앱에 묻고 답 받기
  const normKey = (s) => String(s).normalize('NFC').toLowerCase();
  // iOS 앱에서는 진행 상황·오류를 앱 로그(Xcode/devicectl 콘솔)로 넘긴다
  const log = (msg) => { if (native) try { native.postMessage({ type: 'log', msg: String(msg) }); } catch (e) { /* 무시 */ } };
  window.addEventListener('error', (e) => log('JS 오류: ' + e.message + ' @' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => log('Promise 오류: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

  // ───────────────────────── 알림/로딩 ─────────────────────────
  function setLoading(on, msg) {
    $('#loading').hidden = !on;
    if (msg) $('#loading-msg').textContent = msg;
  }
  let hintTimer = null;
  function hint(msg, ms) {
    const h = $('#hint');
    clearTimeout(hintTimer);
    if (!msg) { h.hidden = true; return; }
    h.textContent = msg;
    h.hidden = false;
    if (ms) hintTimer = setTimeout(updateHint, ms);
  }
  function updateHint() {
    if (S.tool === 'dist') hint(S.cur.length ? '두 번째 점 — 십자선을 옮겨 [점 찍기]' : '거리 — 십자선을 맞추고 [점 찍기] (탭해도 됨)');
    else if (S.tool === 'area') hint(S.cur.length ? `점 ${S.cur.length}개${S.cur.length >= 3 ? ' · [완료]로 마침' : ''}` : '면적 — 꼭짓점을 차례로 찍으세요');
    else hint(null);
  }

  // ───────────────────────── DWG → DXF 변환 (워커) ─────────────────────────
  // 변환기(WASM)는 큰 도면에서 메모리를 수백 MB~GB까지 늘리고 줄이지 않으므로 다 쓴 워커는 통째로 내린다.
  // 큰 DWG는 변환(WASM, 18MB 도면에 ~1.9GB)과 해석(임시 ~1GB)을 한 워커에서 이어 하면 두 메모리가 겹쳐
  // iOS가 화면 프로세스를 강제 종료한다(실기기 확인). 그래서 변환 워커를 끝나자마자 내려 메모리를 돌려받은 뒤
  // 새 워커에서 해석한다. 작은 파일은 한 워커에서 둘 다 하고, 잠시 쉬면 내린다
  let worker = null, jobId = 0, idleTimer = null; // worker: 작은 파일용으로 잠시 살려 두는 공용 워커
  const jobs = new Map();
  const BIG = 1048576; // 이보다 큰 DWG·(8배) DXF는 단계마다 전용 워커를 새로 띄운다
  function killWorker() { clearTimeout(idleTimer); if (worker) { worker.terminate(); worker = null; } }
  function makeWorker() {
    const w = new Worker('convert-worker.js', { type: 'module' });
    w.onmessage = (ev) => {
      const j = jobs.get(ev.data.id);
      jobs.delete(ev.data.id);
      if (!j) return;
      // 결과를 넘기기 전에 전용 워커부터 내린다 → 다음 단계가 시작될 때 이 워커의 메모리는 이미 놓여 있다
      if (j.oneShot) w.terminate();
      else if (![...jobs.values()].some((x) => x.w === w)) idleTimer = setTimeout(() => { if (worker === w && ![...jobs.values()].some((x) => x.w === w)) killWorker(); }, 1500);
      ev.data.ok ? j.res(ev.data) : j.rej(new Error(ev.data.error));
    };
    w.onerror = (ev) => {
      for (const [id, j] of jobs) if (j.w === w) { jobs.delete(id); j.rej(new Error('변환기 오류: ' + (ev.message || '알 수 없음'))); }
      w.terminate();
      if (worker === w) worker = null;
    };
    return w;
  }
  function runWorker(msg, transfer, oneShot) {
    let w;
    if (oneShot) w = makeWorker();
    else { clearTimeout(idleTimer); w = worker || (worker = makeWorker()); }
    const id = ++jobId;
    return new Promise((res, rej) => {
      jobs.set(id, { res, rej, oneShot, w });
      w.postMessage({ id, ...msg }, transfer);
    });
  }
  const rest = () => new Promise((r) => setTimeout(r, 300)); // 내린 워커의 메모리가 실제로 풀릴 틈
  async function parseInWorker(bytes, dwg) {
    const copy = bytes.slice(0); // 원본은 보관함·재변환용으로 남긴다
    if (dwg && bytes.byteLength > BIG) {
      const { dxf } = await runWorker({ op: 'dxf', bytes: copy }, [copy], true);
      await rest();
      const r = await runWorker({ op: 'parse', bytes: dxf }, [dxf], true);
      await rest();
      return r.doc;
    }
    const big = bytes.byteLength > 8 * BIG;
    const r = await runWorker({ op: dwg ? 'both' : 'parse', bytes: copy }, [copy], big);
    if (big) await rest();
    return r.doc;
  }

  // ───────────────────────── 파일 보관 / 찾기 ─────────────────────────
  async function bytesOf(key) {
    if (pool.has(key)) return pool.get(key);
    const r = await Store.get(key);
    if (r) { const f = { name: r.name, bytes: r.bytes, path: r.path }; pool.set(key, f); return f; }
    return null;
  }
  async function fetchItem(it) {
    const r = await fetch(it.url);
    if (!r.ok) throw new Error(`${it.name} 읽기 실패 (${r.status})`);
    return { name: it.name, path: it.path, bytes: await r.arrayBuffer() };
  }
  // XREF 찾기: ① 이번에 함께 고른 파일(이름) ② 연결된 도면 폴더 — 데스크톱처럼 상대경로·같은 폴더·폴더 전체 검색 ③ 최근 도면 보관함(이름)
  const xrefCache = new Map();
  async function resolveXref(ref, hostKey) {
    if (!ref) return null;
    let name = baseName(ref);
    if (!isDrawing(name)) name += '.dwg';
    const key = Store.keyOf(name);
    if (pool.has(key) && pool.get(key).picked) return key;
    if (nativeR) {
      const host = (pool.get(hostKey) || {}).path || null;
      const ck = host + '|' + ref;
      if (xrefCache.has(ck)) return xrefCache.get(ck);
      let found = null;
      try {
        const it = await ask({ type: 'findXref', ref, host });
        if (it) {
          found = 'p:' + normKey(it.path);
          if (!pool.has(found)) pool.set(found, await fetchItem(it));
        }
      } catch (e) { log('XREF 찾기 오류: ' + e.message); }
      xrefCache.set(ck, found);
      if (found) return found;
    }
    if (pool.has(key) || (await Store.get(key))) return key;
    return null;
  }

  function loadDoc(key) {
    if (S.docs.has(key)) return Promise.resolve(S.docs.get(key));
    if (!S.docLoads.has(key)) {
      S.docLoads.set(key, (async () => {
        const f = await bytesOf(key);
        if (!f) throw new Error('파일 없음');
        const d = await parseInWorker(f.bytes, /\.dwg$/i.test(f.name)); // 변환·해석 모두 워커에서
        S.docs.set(key, d);
        return d;
      })());
      S.docLoads.get(key).catch(() => S.docLoads.delete(key));
    }
    return S.docLoads.get(key);
  }

  async function loadXrefs(doc, hostKey, depth, chain, visited, tok) {
    doc.xrefPaths = {};
    const blks = Object.values(doc.blocks).filter((b) => b.flags & 4);
    for (const b of blks) { // 휴대폰 메모리를 생각해 하나씩 변환
      if (S.xrefStop || tok !== openToken) return;
      const key = b.name.toUpperCase();
      const overlay = (b.flags & 8) !== 0;
      if (depth > 0 && overlay) continue;
      const entry = { name: b.name, ref: b.xref, host: hostKey, depth, overlay, resolved: null, status: 'miss', key: hostKey + '|' + key };
      S.xrefs.push(entry);
      const res = S.overrides[entry.key] || (await resolveXref(b.xref, hostKey));
      if (!res) continue;
      if (chain.includes(res)) { entry.status = 'cycle'; continue; }
      try {
        S.xrefDone = (S.xrefDone || 0) + 1;
        $('#loading-msg').textContent = `XREF 불러오는 중 (${S.xrefDone}) ${b.name}`;
        $('#xbar-msg').textContent = `XREF 불러오는 중 · ${S.xrefDone}개째 · ${b.name}`;
        const tx = performance.now();
        const xd = await loadDoc(res);
        if (tok !== openToken) return;
        log(`XREF ${S.xrefDone} ${b.name} ${Math.round(performance.now() - tx)}ms`);
        doc.xrefPaths[key] = res;
        const pf = pool.get(res) || {};
        entry.resolved = pf.path || pf.name || res;
        entry.status = 'ok';
        if (!visited.has(res)) {
          visited.add(res);
          await loadXrefs(xd, res, depth + 1, chain.concat(res), visited, tok);
        }
      } catch (err) {
        entry.status = 'error';
        entry.error = err.message;
      }
    }
  }
  async function reloadXrefs() {
    S.xrefs = [];
    S.xrefDone = 0;
    S.xrefStop = false;
    await loadXrefs(S.mainDoc, S.mainKey, 0, [S.mainKey], new Set(), openToken);
  }

  // 파일 선택 결과 처리. 여러 개면 어느 것을 열지 묻고 나머지는 XREF 후보로 둔다
  async function takeFiles(files, forXref) {
    const list = [];
    for (const f of files) {
      if (!isDrawing(f.name)) continue;
      // 앱에서 넘긴 항목은 bytes(ArrayBuffer)가 있고, 브라우저 File은 arrayBuffer()로 읽는다
      // (최신 브라우저의 File에는 bytes() 메서드가 있어 f.bytes만 보면 함수가 잡힌다)
      const bytes = f.bytes instanceof ArrayBuffer ? f.bytes : await f.arrayBuffer();
      const key = Store.keyOf(f.name);
      pool.set(key, { name: f.name, bytes, path: f.path, picked: true });
      list.push({ key, name: f.name, bytes, path: f.path });
    }
    if (!list.length) { if (files.length) hint('DWG 또는 DXF 파일만 열 수 있습니다', 3000); return []; }
    return list;
  }
  async function openFiles(files) {
    setLoading(true, '파일 읽는 중…');
    let list;
    try { list = await takeFiles(files); } finally { setLoading(false); }
    if (!list.length) return;
    if (list.length === 1) { await openMain(list[0].key); return; }
    // 여러 개: 고르게 한다. XREF처럼 보이는 이름(X-, XR-)은 뒤로
    const xrefLike = (n) => /^x[r-]|^x[a-z]*-|xref/i.test(n);
    list.sort((a, b) => xrefLike(a.name) - xrefLike(b.name));
    openSheet('pick');
    const ul = $('#pick-list');
    ul.innerHTML = '';
    for (const f of list) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="grow nm"></span><span class="cnt"></span>';
      li.querySelector('.nm').textContent = f.name;
      li.querySelector('.cnt').textContent = mb(f.bytes.byteLength);
      li.onclick = async () => {
        closeSheet();
        for (const o of list) if (o !== f) Store.put(o.name, o.bytes, false, o.path);
        await openMain(f.key);
      };
      ul.appendChild(li);
    }
  }
  const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  let openToken = 0;
  async function openMain(key) {
    S.xrefStop = true; // 앞 도면의 XREF 불러오기가 진행 중이면 멈춘다
    setLoading(true, '도면 변환 중…');
    await tick();
    try {
      const f = await bytesOf(key);
      if (!f) throw new Error('파일을 찾을 수 없습니다');
      xrefCache.clear();
      Object.assign(S, {
        mainKey: key, mainName: f.name, mainDoc: null, docs: new Map(), docLoads: new Map(), xrefs: [], overrides: {}, attached: [],
        measures: [], cur: [], layerVis: new Map(), groupVis: new Map(), scene: null,
      });
      const t0 = performance.now();
      if (/\.dwg$/i.test(f.name)) $('#loading-msg').textContent = `DWG 변환 중… (${mb(f.bytes.byteLength)})`;
      const doc = await loadDoc(key);
      S.mainDoc = doc;
      S.loadSec = (performance.now() - t0) / 1000;
      Store.put(f.name, f.bytes, true, f.path);
      const token = ++openToken;
      const hasXref = Object.values(doc.blocks).some((b) => b.flags & 4);
      // 본 도면부터 바로 보여 준다 (XREF가 수십 개면 다 붙이는 데 오래 걸려 '먹통'처럼 보이므로)
      doc.xrefPaths = {};
      await rebuild(false);
      $('#docname').textContent = f.name;
      document.title = f.name;
      showHome(false);
      setTool('pan');
      setLoading(false);
      if (hasXref) {
        $('#xbar-msg').textContent = 'XREF 찾는 중…';
        $('#xbar').hidden = false;
        document.body.classList.add('xloading');
        try { await reloadXrefs(); } finally {
          if (token === openToken) { $('#xbar').hidden = true; document.body.classList.remove('xloading'); }
        }
        if (token !== openToken) return; // 그사이 다른 도면을 열었음
        const stopped = S.xrefStop;
        const okN = S.xrefs.filter((x) => x.status === 'ok').length;
        if (okN) await rebuild(true);
        S.docs = new Map([[S.mainKey, S.mainDoc]]); // 화면에 다 옮겼으니 XREF 해석본은 놓는다 (~수백 MB)
        S.docLoads = new Map();
        if (stopped) { hint(`XREF 불러오기를 멈췄습니다 (${okN}개만 표시)`, 4000); log('XREF 중단'); return; }
      }
      const miss = S.xrefs.filter((x) => x.status !== 'ok').length;
      if (BENCH) setTimeout(async () => {
        for (const z of [1, 4, 16, 64]) {
          view.zoomExtents(); view.zoomAt(view.w / 2, view.h / 2, z);
          log(`벤치 확대 ${z}배`); view.render(); view.render();
          await tick();
        }
      }, 1500);
      log(`열기 성공: ${f.name} 변환 ${S.loadSec.toFixed(2)}초, 구성 ${S.buildSec.toFixed(2)}초, 선 ${S.scene.stats.segments}, XREF ${S.xrefs.length}(못 찾음 ${miss})`);
      if (miss) hint(`XREF ${miss}개를 찾지 못했습니다. ${nativeR ? '도면이 든 상위 폴더를 처음 화면에서 연결하면 자동으로 찾습니다.' : '더보기 → XREF에서 파일을 지정하세요.'}`, 7000);
    } catch (err) {
      setLoading(false);
      hint('열기 실패: ' + err.message, 8000);
      log('열기 실패: ' + (err.stack || err.message));
      console.error(err);
    }
    setLoading(false);
  }

  async function rebuild(keepView) {
    setLoading(true, '화면 구성 중…');
    await tick();
    const t0 = performance.now();
    // 변환기(WASM)가 남아 있으면 화면 구성 전에 내려 메모리를 비운다
    if (worker && !jobs.size) killWorker();
    log('화면 구성 시작');
    view.startTiles();
    const scene = Scene.build({ mainDoc: S.mainDoc, docs: S.docs, attached: S.attached, lite: true, freeDocs: true, onTile: (t, col) => view.addTile(t, col) });
    log(`화면 구성 끝 ${((performance.now() - t0) / 1000).toFixed(1)}초, 선 ${scene.stats.segments}`);
    S.scene = scene;
    S.index = null;
    S.buildSec = (performance.now() - t0) / 1000;
    S.docs = new Map([[S.mainKey, S.mainDoc]]); S.docLoads = new Map(); // 코어가 전개 뒤 XREF 해석본을 비웠다(freeDocs)
    view.layerVis = scene.layers.map((l) => (S.layerVis.has(l.key) ? S.layerVis.get(l.key) : l.visible));
    view.groupVis = scene.groups.map((g) => S.groupVis.get(g.key) !== false);
    view.setScene(scene, keepView);
    log(`GPU로 올림 ${((performance.now() - t0) / 1000).toFixed(1)}초`);
    if (measuring()) ensureIndex().then(() => { updateCenter(); drawUI(); });
    $$('#toolbar button').forEach((b) => (b.disabled = false));
    setLoading(false);
  }

  // ───────────────────────── 처음 화면 / 최근 도면 ─────────────────────────
  function showHome(on) {
    $('#home').hidden = !on;
    if (on) { renderRecent(); renderFolders(false); }
  }
  async function renderRecent() {
    const ul = $('#recent');
    const list = (await Store.list()).filter((f) => f.main);
    ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="empty">아직 연 도면이 없습니다</li>'; return; }
    for (const f of list) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="grow"><div class="nm"></div><div class="sub"></div></div><button class="del">삭제</button>';
      li.querySelector('.nm').textContent = f.name;
      const d = new Date(f.opened);
      li.querySelector('.sub').textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${mb(f.size)}`;
      li.querySelector('.del').onclick = async (ev) => { ev.stopPropagation(); await Store.remove(f.key); pool.delete(f.key); renderRecent(); };
      li.onclick = () => openRecent(f);
      ul.appendChild(li);
    }
  }
  async function openRecent(f) {
    if (nativeR && f.path) {
      try {
        const it = await ask({ type: 'readFile', path: f.path });
        if (it) { await openFiles([await fetchItem(it)]); return; }
      } catch (e) { /* 원본에 못 가면 보관본으로 */ }
    }
    await openMain(f.key);
  }

  // ───────────────────────── 연결된 도면 폴더 (iOS 앱) ─────────────────────────
  let libFiles = [];
  async function renderFolders(refresh) {
    if (!nativeR) return;
    $('#folders').hidden = false;
    const folders = (await ask({ type: 'folders' })) || [];
    const ul = $('#folder-list');
    ul.innerHTML = '';
    folders.forEach((fd, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span>📁</span><span class="grow nm"></span><button class="del">연결 해제</button>';
      li.querySelector('.nm').textContent = fd.name;
      li.querySelector('.del').onclick = async () => { await ask({ type: 'unlinkFolder', index: i }); renderFolders(true); };
      ul.appendChild(li);
    });
    $('#lib-box').hidden = !folders.length;
    $('#folder-note').hidden = !!folders.length;
    if (!folders.length) { libFiles = []; return; }
    $('#lib-list').innerHTML = '<li class="empty">도면 목록 읽는 중…</li>';
    libFiles = (await ask({ type: 'listDrawings', refresh: !!refresh })) || [];
    renderLib();
  }
  function renderLib() {
    const q = normKey($('#lib-filter').value.trim());
    const ul = $('#lib-list');
    ul.innerHTML = '';
    const hits = libFiles.filter((f) => !q || normKey(f.rel).includes(q));
    if (!hits.length) { ul.innerHTML = `<li class="empty">${libFiles.length ? '결과 없음' : 'DWG/DXF 파일이 없습니다'}</li>`; return; }
    const frag = document.createDocumentFragment();
    for (const f of hits.slice(0, 300)) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="grow"><div class="nm"></div><div class="sub"></div></div>';
      li.querySelector('.nm').textContent = f.name;
      const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
      li.querySelector('.sub').textContent = f.folder + (dir ? ' / ' + dir : '');
      li.onclick = async () => {
        setLoading(true, '파일 읽는 중…');
        try {
          const it = await ask({ type: 'readFile', path: f.path });
          if (!it) throw new Error('파일을 읽지 못했습니다');
          const file = await fetchItem(it);
          setLoading(false);
          await openFiles([file]);
        } catch (e) { setLoading(false); hint(e.message, 5000); }
      };
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    if (hits.length > 300) ul.insertAdjacentHTML('beforeend', `<li class="empty">${hits.length - 300}개 더 있음 — 검색어로 좁히세요</li>`);
  }
  $('#lib-filter').addEventListener('input', renderLib);
  $('#btn-link').onclick = async () => {
    const r = await ask({ type: 'linkFolder' });
    if (r) renderFolders(true);
  };

  // ───────────────────────── 아래 패널(시트) ─────────────────────────
  const TITLES = { layers: '레이어', search: '문자 검색', measure: '측정 목록', xrefs: 'XREF', more: '더보기', pick: '열 도면을 고르세요', pdf: 'PDF로 내보내기' };
  let sheetName = null;
  function openSheet(name) {
    sheetName = name;
    $('#sheet-title').textContent = TITLES[name];
    $$('#sheet .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    $('#sheet').hidden = false;
    $('#sheet-bg').hidden = false;
    $('#sheet').classList.toggle('short', name === 'more');
    $$('#toolbar [data-sheet]').forEach((b) => b.classList.toggle('active', b.dataset.sheet === name));
    if (name === 'layers') renderLayers();
    if (name === 'measure') renderMeasures();
    if (name === 'xrefs') renderXrefs();
    if (name === 'more') renderInfo();
  }
  function closeSheet() {
    sheetName = null;
    $('#sheet').hidden = true;
    $('#sheet-bg').hidden = true;
    $$('#toolbar [data-sheet]').forEach((b) => b.classList.remove('active'));
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
  }
  $('#sheet-close').onclick = closeSheet;
  $('#sheet-bg').onclick = closeSheet;
  $$('#toolbar [data-sheet]').forEach((b) => (b.onclick = () => (sheetName === b.dataset.sheet ? closeSheet() : openSheet(b.dataset.sheet))));
  // 시트 손잡이를 아래로 끌면 닫기
  (() => {
    let y0 = null;
    const head = [$('#sheet .grab'), $('#sheet > header')];
    head.forEach((h) => {
      h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
      h.addEventListener('touchmove', (e) => { if (y0 !== null) $('#sheet').style.transform = `translateY(${Math.max(0, e.touches[0].clientY - y0)}px)`; }, { passive: true });
      h.addEventListener('touchend', (e) => {
        const dy = y0 === null ? 0 : e.changedTouches[0].clientY - y0;
        y0 = null;
        $('#sheet').style.transform = '';
        if (dy > 80) closeSheet();
      });
    });
  })();

  // ───────────────────────── 레이어 ─────────────────────────
  function renderLayers() {
    const ul = $('#layer-list');
    const s = S.scene;
    if (!s) { ul.innerHTML = '<li class="empty">도면을 열어주세요</li>'; return; }
    const q = $('#layer-filter').value.trim().toUpperCase();
    const items = s.layers.filter((l) => !q || l.key.includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const l of items) {
      const li = document.createElement('li');
      li.dataset.id = l.id;
      const on = view.layerVis[l.id] !== false;
      li.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}/><span class="swatch" style="background:#${l.rgb.toString(16).padStart(6, '0')}"></span><span class="grow nm ${on ? '' : 'off'}"></span><span class="cnt">${fmt(l.count, 0)}</span>`;
      li.querySelector('.nm').textContent = l.name;
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    if (!items.length) ul.innerHTML = '<li class="empty">레이어 없음</li>';
  }
  function setLayer(id, on) {
    view.layerVis[id] = on;
    S.layerVis.set(S.scene.layers[id].key, on);
    S.snap = null;
  }
  $('#layer-list').addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (!li) return;
    const id = +li.dataset.id;
    const on = view.layerVis[id] === false;
    setLayer(id, on);
    li.querySelector('input').checked = on;
    li.querySelector('.nm').classList.toggle('off', !on);
    view.request();
  });
  $('#layer-filter').addEventListener('input', renderLayers);
  function bulkLayers(fn) {
    if (!S.scene) return;
    const q = $('#layer-filter').value.trim().toUpperCase();
    for (const l of S.scene.layers) if (!q || l.key.includes(q)) setLayer(l.id, fn(view.layerVis[l.id] !== false));
    renderLayers();
    view.request();
  }
  $('#layers-all-on').onclick = () => bulkLayers(() => true);
  $('#layers-all-off').onclick = () => bulkLayers(() => false);
  $('#layers-invert').onclick = () => bulkLayers((v) => !v);

  // ───────────────────────── 문자 검색 ─────────────────────────
  $('#search-input').addEventListener('input', () => {
    const q = $('#search-input').value.trim().toLowerCase();
    const ul = $('#search-list');
    ul.innerHTML = '';
    if (!q || !S.scene) return;
    const hits = [];
    for (const t of S.scene.texts) {
      if (t.str.toLowerCase().includes(q)) { hits.push(t); if (hits.length >= 300) break; }
    }
    if (!hits.length) { ul.innerHTML = '<li class="empty">결과 없음</li>'; return; }
    for (const t of hits) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="grow nm"></span><span class="cnt"></span>';
      li.querySelector('.nm').textContent = t.str;
      li.querySelector('.cnt').textContent = S.scene.layers[t.layer].name;
      li.onclick = () => {
        closeSheet();
        const b = t.bb, w = b[2] - b[0], h = b[3] - b[1];
        const pad = Math.max(w, h) * 4;
        view.zoomTo(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, 0);
        S.flash = { bb: b, until: performance.now() + 2500 };
        setTimeout(drawUI, 2600);
      };
      ul.appendChild(li);
    }
  });
  $('#search-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });

  // ───────────────────────── XREF ─────────────────────────
  let xrefPickFor = null;
  function renderXrefs() {
    const ul = $('#xref-list');
    ul.innerHTML = '';
    const s = S.scene;
    if (!s) return;
    if (!S.xrefs.length) { ul.innerHTML = '<li class="empty">이 도면에는 XREF가 없습니다</li>'; return; }
    const STATUS = { ok: ['ok', '연결됨'], miss: ['miss', '못 찾음'], cycle: ['miss', '순환 참조'], error: ['miss', '변환 오류'] };
    for (const x of S.xrefs) {
      const [cls, label] = STATUS[x.status];
      const top = x.depth === 0;
      const gi = top ? s.groups.findIndex((g) => g.key === x.name.toUpperCase()) : -1;
      const li = document.createElement('li');
      li.className = 'xr';
      li.innerHTML = `${gi >= 0 ? `<input type="checkbox" ${view.groupVis[gi] !== false ? 'checked' : ''}/>` : ''}<span class="grow nm" style="padding-left:${x.depth * 12}px"></span><span class="badge ${cls}">${label}</span><button class="del">파일 지정</button><div class="path"></div>`;
      li.querySelector('.nm').textContent = (x.depth ? '└ ' : '') + x.name + (x.overlay ? ' (오버레이)' : '');
      li.querySelector('.path').textContent = x.status === 'ok' ? x.resolved : `원래 경로: ${x.ref}${x.error ? ' — ' + x.error : ''}`;
      const cb = li.querySelector('input');
      if (cb) cb.onchange = () => { view.groupVis[gi] = cb.checked; S.groupVis.set(s.groups[gi].key, cb.checked); view.request(); };
      li.querySelector('.del').onclick = () => {
        xrefPickFor = x;
        if (native) { native.postMessage({ type: 'pick', mode: 'xref' }); return; }
        $('#file-xref').value = ''; $('#file-xref').click();
      };
      ul.appendChild(li);
    }
  }
  $('#file-xref').addEventListener('change', (ev) => { const fs = [...ev.target.files]; if (fs.length) takeXrefFiles(fs); });
  async function takeXrefFiles(files) {
    setLoading(true, 'XREF 다시 불러오는 중…');
    try {
      const list = await takeFiles(files);
      for (const f of list) Store.put(f.name, f.bytes, false);
      if (xrefPickFor && list.length === 1) S.overrides[xrefPickFor.key] = list[0].key;
      xrefPickFor = null;
      xrefCache.clear();
      S.docs = new Map([[S.mainKey, S.mainDoc]]);
      S.docLoads = new Map();
      await reloadXrefs();
      await rebuild(true);
      renderXrefs();
    } catch (err) { hint('XREF 실패: ' + err.message, 5000); log('XREF 실패: ' + err.message); }
    setLoading(false);
  }

  // ───────────────────────── 측정 ─────────────────────────
  function unitLabel() { return UNITS[S.scene && S.scene.units] || ''; }
  function areaText(a) {
    const conv = { 4: 1e6, 5: 1e4, 6: 1, 1: 1550.0031, 2: 10.7639 }[S.scene && S.scene.units];
    return conv ? `${fmt(a / conv, 3)} m²` : `${fmt(a)} (도면단위²)`;
  }
  function dimNormal(m) {
    const [a, b] = m.pts;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  }
  function dimScreen(m) {
    const [a, b] = m.pts, n = dimNormal(m), o = m.off || 0;
    return {
      a: view.toScreen(a[0], a[1]), b: view.toScreen(b[0], b[1]),
      da: view.toScreen(a[0] + n[0] * o, a[1] + n[1] * o), db: view.toScreen(b[0] + n[0] * o, b[1] + n[1] * o),
    };
  }
  // 손가락 근처의 거리 치수(치수선 또는 숫자) 번호, 없으면 -1
  function hitDim(sx, sy) {
    for (let i = S.measures.length - 1; i >= 0; i--) {
      const m = S.measures[i];
      if (m.type !== 'dist') continue;
      const { da, db } = dimScreen(m);
      const dx = db[0] - da[0], dy = db[1] - da[1], L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((sx - da[0]) * dx + (sy - da[1]) * dy) / L2)) : 0;
      if (Math.hypot(da[0] + dx * t - sx, da[1] + dy * t - sy) < 14) return i;
      const mx = (da[0] + db[0]) / 2, my = (da[1] + db[1]) / 2 - 16;
      if (Math.abs(sx - mx) < 46 && Math.abs(sy - my) < 18) return i;
    }
    return -1;
  }
  function measureInfo(m) {
    if (m.type === 'dist') {
      const [a, b] = m.pts;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const d = Math.hypot(dx, dy);
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      return { main: `${fmt(d)} ${unitLabel()}`, sub: `ΔX ${fmt(dx)} · ΔY ${fmt(dy)} · 각도 ${fmt(ang, 1)}°`, label: fmt(d) };
    }
    const p = m.pts;
    let a = 0, per = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
      per += Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]);
    }
    a = Math.abs(a) / 2;
    return { main: areaText(a), sub: `둘레 ${fmt(per)} ${unitLabel()} · 점 ${p.length}개`, label: areaText(a) };
  }
  function renderMeasures() {
    const ul = $('#measure-list');
    ul.innerHTML = '';
    if (!S.measures.length) { ul.innerHTML = '<li class="empty">📏 거리 · ⬠ 면적 도구로 측정하세요</li>'; return; }
    S.measures.forEach((m, i) => {
      const info = measureInfo(m);
      const li = document.createElement('li');
      li.className = 'mi';
      li.innerHTML = `<div class="grow"><div class="cnt">#${i + 1} ${m.type === 'dist' ? '거리' : '면적'}</div><div class="v"></div><div class="sub"></div></div><button class="del">삭제</button>`;
      li.querySelector('.v').textContent = info.main;
      li.querySelector('.sub').textContent = info.sub;
      li.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); S.measures.splice(i, 1); renderMeasures(); drawUI(); };
      li.onclick = () => {
        closeSheet();
        const xs = m.pts.map((p) => p[0]), ys = m.pts.map((p) => p[1]);
        view.zoomTo(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 0.3);
      };
      ul.appendChild(li);
    });
  }
  $('#btn-clear').onclick = () => { S.measures = []; S.cur = []; renderMeasures(); drawUI(); };

  function addPoint(pt) {
    if (S.tool === 'dist') {
      if (!S.cur.length) S.cur = [pt];
      else {
        const m = { type: 'dist', pts: [S.cur[0], pt] };
        S.measures.push(m);
        S.cur = [];
        hint(`거리 ${measureInfo(m).main}`, 2500);
        if (navigator.vibrate) navigator.vibrate(15);
        updateBar();
        drawUI();
        return;
      }
    } else if (S.tool === 'area') S.cur.push(pt);
    if (navigator.vibrate) navigator.vibrate(8);
    updateHint();
    updateBar();
    drawUI();
  }
  function finishArea() {
    const pts = S.cur.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 1e-9);
    if (pts.length >= 3) {
      const m = { type: 'area', pts };
      S.measures.push(m);
      hint(`면적 ${measureInfo(m).main}`, 3000);
    }
    S.cur = [];
    updateBar();
    drawUI();
  }

  // ───────────────────────── 스냅 ─────────────────────────
  // 스냅 색인: 격자 칸별 목록을 Int32Array 두 개(시작 위치·번호)로 만든다 (수백만 개여도 메모리가 작다).
  // 화면 구성 직후가 아니라 측정을 처음 켤 때 만든다
  const G = 512, NC = (G + 1) * (G + 1);
  // 스냅용 선분 목록: get(i, o) 가 o에 [x1,y1,x2,y2](월드 좌표)를 채운다
  function segSource() {
    const s = S.scene;
    if (s.segs) {
      const A = s.segs.a;
      return { n: A.length / 4, get: (i, o) => { o[0] = A[i * 4]; o[1] = A[i * 4 + 1]; o[2] = A[i * 4 + 2]; o[3] = A[i * 4 + 3]; }, layerOf: (i) => [s.segs.layer[i], 0] };
    }
    const ox = s.origin[0], oy = s.origin[1];
    // lite: 코어가 구역별로 남긴 좌표(tiles[].pos, 원점 기준 Float32)를 그대로 쓴다
    const T = s.tiles || [];
    const off = [0];
    for (const t of T) off.push(off[off.length - 1] + t.n);
    const tileOf = (i) => { let lo = 0, hi = T.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (off[m] <= i) lo = m; else hi = m - 1; } return lo; };
    return {
      n: off[off.length - 1],
      get: (i, o) => {
        const t = tileOf(i), P = T[t].pos, k = (i - off[t]) * 4;
        o[0] = P[k] + ox; o[1] = P[k + 1] + oy; o[2] = P[k + 2] + ox; o[3] = P[k + 3] + oy;
      },
      layerOf: (i) => {
        const t = tileOf(i), v = (i - off[t]) * 2, ps = T[t].pieces;
        let lo = 0, hi = ps.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ps[m].s <= v) lo = m; else hi = m - 1; }
        return [ps[lo].layer, ps[lo].group];
      },
    };
  }
  function buildIndex() {
    const s = S.scene;
    const e = s.fullExtents;
    const cs = Math.max(e[2] - e[0], e[3] - e[1]) / G || 1;
    const cx = (x) => Math.min(G, Math.max(0, Math.floor((x - e[0]) / cs)));
    const cy = (y) => Math.min(G, Math.max(0, Math.floor((y - e[1]) / cs)));
    const csr = (n, each) => { // each(i, emit(cell)) 를 두 번 돌려 개수 → 채우기
      const st = new Int32Array(NC + 1);
      for (let i = 0; i < n; i++) each(i, (c) => { st[c + 1]++; });
      for (let c = 0; c < NC; c++) st[c + 1] += st[c];
      const cur = st.slice(0, NC), idx = new Int32Array(st[NC]);
      for (let i = 0; i < n; i++) each(i, (c) => { idx[cur[c]++] = i; });
      return { st, idx };
    };
    const P = s.snap.pts, [pbx, pby] = s.snap.base || [0, 0];
    const pts = csr(P.length / 2, (i, emit) => emit(cx(P[i * 2] + pbx) * (G + 1) + cy(P[i * 2 + 1] + pby)));
    const src = segSource();
    const q = [0, 0, 0, 0];
    const segs = csr(src.n, (i, emit) => {
      src.get(i, q);
      const x1 = q[0], y1 = q[1], x2 = q[2], y2 = q[3];
      const ax = cx(Math.min(x1, x2)), ay = cy(Math.min(y1, y2)), bx = cx(Math.max(x1, x2)), by = cy(Math.max(y1, y2));
      if ((bx - ax + 1) * (by - ay + 1) <= 16) {
        for (let ix = ax; ix <= bx; ix++) for (let iy = ay; iy <= by; iy++) emit(ix * (G + 1) + iy);
      } else {
        const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cs / 2));
        let last = -1;
        for (let k = 0; k <= n; k++) {
          const kk = cx(x1 + ((x2 - x1) * k) / n) * (G + 1) + cy(y1 + ((y2 - y1) * k) / n);
          if (kk !== last) { emit(kk); last = kk; }
        }
      }
    });
    S.index = { pts, segs, src, cx, cy };
  }
  const KIND_ON = () => ({ 1: $('#snap-end').checked, 2: $('#snap-mid').checked, 3: $('#snap-cen').checked, 4: $('#snap-cen').checked, 5: $('#snap-near').checked });
  function findSnap(wx, wy, rpx) {
    const s = S.scene;
    if (!s || !S.index) return null; // 색인은 측정을 켤 때 따로 만든다
    const ix = S.index;
    const r = rpx / view.scale;
    const ax = ix.cx(wx - r), ay = ix.cy(wy - r), bx = ix.cx(wx + r), by = ix.cy(wy + r);
    if ((bx - ax + 1) * (by - ay + 1) > 3000) return null;
    const on = KIND_ON();
    let best = null, bd = r;
    const P = s.snap.pts, [pbx, pby] = s.snap.base || [0, 0];
    const visL = (l) => view.layerVis[l] !== false;
    for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) {
      const c = x * (G + 1) + y, { st, idx } = ix.pts;
      for (let j = st[c]; j < st[c + 1]; j++) {
        const i = idx[j], k = s.snap.kind[i];
        if (!on[k] || !visL(s.snap.layer[i])) continue;
        const px = P[i * 2] + pbx, py = P[i * 2 + 1] + pby;
        const d = Math.hypot(px - wx, py - wy);
        if (d < bd) { bd = d; best = { x: px, y: py, kind: k }; }
      }
    }
    if (best || !on[5]) return best;
    const { get, layerOf } = ix.src, q = [0, 0, 0, 0];
    for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) {
      const c = x * (G + 1) + y, { st, idx } = ix.segs;
      for (let j = st[c]; j < st[c + 1]; j++) {
        const i = idx[j];
        get(i, q);
        const x1 = q[0], y1 = q[1], x2 = q[2], y2 = q[3];
        const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((wx - x1) * dx + (wy - y1) * dy) / L2)) : 0;
        const px = x1 + dx * t, py = y1 + dy * t;
        const d = Math.hypot(px - wx, py - wy);
        if (d < bd) {
          const [l, g] = layerOf(i);
          if (!view.isVisible(l, g)) continue;
          bd = d; best = { x: px, y: py, kind: 5 };
        }
      }
    }
    return best;
  }
  async function ensureIndex() {
    if (S.index || !S.scene) return;
    const big = S.scene.stats.segments > 1e6;
    if (big) { setLoading(true, '스냅 준비 중…'); await tick(); }
    const t0 = performance.now();
    buildIndex();
    log(`스냅 색인 ${((performance.now() - t0) / 1000).toFixed(1)}초`);
    if (big) setLoading(false);
  }
  const measuring = () => S.tool === 'dist' || S.tool === 'area';
  // 측정 중에는 화면 가운데 십자선이 현재 점. 화면이 움직일 때마다 스냅을 다시 찾는다
  function updateCenter() {
    if (!measuring() || !S.scene) { S.snap = null; S.mouse = null; return; }
    let [wx, wy] = view.toWorld(view.w / 2, view.h / 2);
    const sn = findSnap(wx, wy, 26);
    S.snap = sn;
    if (sn) { wx = sn.x; wy = sn.y; }
    S.mouse = [wx, wy];
  }

  // ───────────────────────── 화면 위 측정·표시 ─────────────────────────
  view.onRender = () => { updateCenter(); drawUI(); };
  view.onLive = () => { updateCenter(); drawUI(); }; // 움직이는 중: 도면은 CSS로 옮기고 측정 표시만 다시
  // 한 번 그리는 데 걸린 시간 (선·문자 따로). 느리면 앱 로그로
  const _render = view.render.bind(view), _renderText = view.renderText.bind(view);
  let lastTextMs = 0;
  view.renderText = () => { const t = performance.now(); _renderText(); lastTextMs = performance.now() - t; };
  view.render = () => {
    const t = performance.now();
    _render();
    if (BENCH) view.gl.finish();
    const ms = performance.now() - t;
    S.lastRenderMs = ms;
    if (BENCH || ms > 150) log(`그리기 ${Math.round(ms)}ms (문자 ${Math.round(lastTextMs)}ms)`);
  };
  function drawUI() {
    const dpr = window.devicePixelRatio || 1;
    if (ui.width !== Math.round(ui.clientWidth * dpr) || ui.height !== Math.round(ui.clientHeight * dpr)) {
      ui.width = Math.round(ui.clientWidth * dpr); ui.height = Math.round(ui.clientHeight * dpr);
    }
    const c = uctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, ui.width, ui.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!S.scene) return;
    const acc = view.light ? '#d1006f' : '#00e5ff';
    const fill = view.light ? 'rgba(209,0,111,0.12)' : 'rgba(0,229,255,0.15)';
    const sp = (p) => view.toScreen(p[0], p[1]);
    const label = (x, y, text) => {
      c.font = '600 14px -apple-system, "Apple SD Gothic Neo", sans-serif';
      const w = c.measureText(text).width + 14;
      c.fillStyle = view.light ? 'rgba(255,255,255,0.94)' : 'rgba(0,0,0,0.78)';
      c.strokeStyle = acc;
      c.lineWidth = 1;
      c.beginPath(); c.roundRect(x - w / 2, y - 12, w, 24, 6); c.fill(); c.stroke();
      c.fillStyle = view.light ? '#000' : '#fff';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, x, y + 1);
    };
    const drawDim = (m, live) => {
      const { a, b, da, db } = dimScreen(m);
      const sl = Math.hypot(db[0] - da[0], db[1] - da[1]) || 1;
      let nx = -(db[1] - da[1]) / sl, ny = (db[0] - da[0]) / sl;
      const ox = da[0] - a[0], oy = da[1] - a[1], od = Math.hypot(ox, oy);
      if (od > 1e-6 && nx * ox + ny * oy < 0) { nx = -nx; ny = -ny; }
      const GAP = 3, EXT = 6;
      c.strokeStyle = acc; c.lineWidth = 1.8;
      c.setLineDash(live ? [6, 4] : []);
      c.beginPath(); c.moveTo(da[0], da[1]); c.lineTo(db[0], db[1]); c.stroke();
      c.setLineDash([]);
      c.lineWidth = 1;
      c.beginPath();
      for (const [p, d] of [[a, da], [b, db]]) {
        const s0 = od > GAP ? GAP : -EXT;
        c.moveTo(p[0] + nx * s0, p[1] + ny * s0);
        c.lineTo(d[0] + nx * EXT, d[1] + ny * EXT);
      }
      c.stroke();
      const ux = (db[0] - da[0]) / sl, uy = (db[1] - da[1]) / sl, AL = 10, AW = 3;
      c.fillStyle = acc;
      for (const [p, s] of [[da, 1], [db, -1]]) {
        c.beginPath();
        c.moveTo(p[0], p[1]);
        c.lineTo(p[0] + ux * AL * s - uy * AW, p[1] + uy * AL * s + ux * AW);
        c.lineTo(p[0] + ux * AL * s + uy * AW, p[1] + uy * AL * s - ux * AW);
        c.closePath(); c.fill();
      }
      for (const p of [a, b]) { c.beginPath(); c.arc(p[0], p[1], 3, 0, Math.PI * 2); c.fill(); }
      label((da[0] + db[0]) / 2, (da[1] + db[1]) / 2 - 16, measureInfo(m).label);
    };
    const drawMeasure = (m, live) => {
      if (m.type === 'dist') { drawDim(m, live); return; }
      c.strokeStyle = acc; c.fillStyle = fill; c.lineWidth = 1.8;
      const pts = m.pts.map(sp);
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      c.closePath(); c.fill();
      c.setLineDash(live ? [6, 4] : []);
      c.stroke();
      c.setLineDash([]);
      for (const p of pts) { c.beginPath(); c.arc(p[0], p[1], 3.5, 0, Math.PI * 2); c.fillStyle = acc; c.fill(); }
      if (pts.length >= 3) {
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        label(cx, cy, measureInfo(m).label);
      }
    };
    for (const m of S.measures) drawMeasure(m, false);
    if (S.cur.length && S.mouse) {
      if (S.tool === 'dist') drawMeasure({ type: 'dist', pts: [S.cur[0], S.mouse] }, true);
      else if (S.tool === 'area') drawMeasure({ type: 'area', pts: [...S.cur, S.mouse] }, true);
    } else if (S.cur.length) {
      for (const p of S.cur.map(sp)) { c.beginPath(); c.arc(p[0], p[1], 3.5, 0, Math.PI * 2); c.fillStyle = acc; c.fill(); }
    }
    if (S.snap) {
      const [x, y] = sp([S.snap.x, S.snap.y]);
      c.strokeStyle = '#ffb000'; c.lineWidth = 2.2;
      c.beginPath();
      const r = 9;
      switch (S.snap.kind) {
        case 1: c.rect(x - r, y - r, r * 2, r * 2); break;
        case 2: c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); break;
        case 3: c.arc(x, y, r, 0, Math.PI * 2); break;
        case 4: c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); break;
        default: c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r);
      }
      c.stroke();
    }
    if (S.flash && performance.now() < S.flash.until) {
      const b = S.flash.bb;
      const [x0, y0] = view.toScreen(b[0], b[3]), [x1, y1] = view.toScreen(b[2], b[1]);
      c.strokeStyle = '#ffb000'; c.lineWidth = 3;
      c.strokeRect(x0 - 8, y0 - 8, x1 - x0 + 16, y1 - y0 + 16);
    }
  }

  // ───────────────────────── 도구 ─────────────────────────
  function setTool(t) {
    S.tool = t;
    S.cur = [];
    $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('#cross').hidden = !measuring();
    if (measuring() && !S.index && S.scene) ensureIndex().then(() => { updateCenter(); drawUI(); });
    updateCenter();
    updateHint();
    updateBar();
    drawUI();
  }
  function updateBar() {
    $('#mbar').hidden = !measuring();
    $('#m-done').hidden = !(S.tool === 'area' && S.cur.length >= 3);
    $('#m-done').classList.toggle('primary', S.tool === 'area' && S.cur.length >= 3);
    $('#m-undo').disabled = !S.cur.length && !S.measures.length;
    updateHint();
  }
  $$('#toolbar [data-tool]').forEach((b) => (b.onclick = () => { closeSheet(); setTool(S.tool === b.dataset.tool ? 'pan' : b.dataset.tool); }));
  $('#m-add').onclick = () => { if (S.mouse) addPoint(S.mouse.slice()); };
  $('#m-done').onclick = finishArea;
  $('#m-undo').onclick = () => {
    if (S.cur.length) S.cur.pop();
    else if (S.measures.length) S.measures.pop();
    updateBar();
    drawUI();
  };
  $('#m-cancel').onclick = () => { if (S.cur.length) { S.cur = []; updateBar(); drawUI(); } else setTool('pan'); };
  $('#t-extents').onclick = () => view.zoomExtents();
  $('#xbar-stop').onclick = () => { S.xrefStop = true; $('#xbar-msg').textContent = '멈추는 중…'; };

  // ───────────────────────── 터치 (포인터) ─────────────────────────
  // 한 손가락: 이동 · 두 손가락: 확대/축소+이동 · 두 번 탭: 확대 · 측정 중 탭: 그 자리(스냅)에 점
  const ptrs = new Map();
  let gest = null; // {mode:'pan'|'pinch'|'dim', ...}
  let lastTap = null, fling = null;
  const local = (ev) => { const r = ui.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  function stopFling() { if (fling) { cancelAnimationFrame(fling.raf); fling = null; } }
  function pinchState() {
    const [a, b] = [...ptrs.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
  }
  ui.addEventListener('pointerdown', (ev) => {
    if (!S.scene) return;
    ui.setPointerCapture(ev.pointerId);
    stopFling();
    view.beginLive();
    if (ev.isPrimary) ptrs.clear(); // 새 제스처의 첫 손가락: 앞 제스처에서 떼는 신호를 놓친 손가락이 남아 있으면 지운다
    const p = local(ev);
    ptrs.set(ev.pointerId, p);
    if (ptrs.size === 1) {
      const i = S.measures.length ? hitDim(p[0], p[1]) : -1;
      if (i >= 0 && !S.cur.length) {
        const m = S.measures[i], n = dimNormal(m);
        const [wx, wy] = view.toWorld(p[0], p[1]);
        gest = { mode: 'dim', m, grab: (m.off || 0) - ((wx - m.pts[0][0]) * n[0] + (wy - m.pts[0][1]) * n[1]), x0: p[0], y0: p[1], t0: performance.now(), moved: false };
      } else gest = { mode: 'pan', x0: p[0], y0: p[1], lx: p[0], ly: p[1], t0: performance.now(), moved: false, hist: [[performance.now(), p[0], p[1]]] };
    } else if (ptrs.size === 2) {
      const ps = pinchState();
      gest = { mode: 'pinch', ...ps, moved: true };
    }
  });
  ui.addEventListener('pointermove', (ev) => {
    if (!ptrs.has(ev.pointerId) || !gest) return;
    const p = local(ev);
    ptrs.set(ev.pointerId, p);
    if (gest.mode === 'pinch' && ptrs.size >= 2) {
      const ps = pinchState();
      view.panBy(ps.mx - gest.mx, ps.my - gest.my);
      view.zoomAt(ps.mx, ps.my, ps.d / gest.d);
      Object.assign(gest, ps);
      return;
    }
    if (!gest.moved && Math.hypot(p[0] - gest.x0, p[1] - gest.y0) > 8) gest.moved = true;
    if (!gest.moved) return;
    if (gest.mode === 'dim') {
      const [wx, wy] = view.toWorld(p[0], p[1]);
      const m = gest.m, n = dimNormal(m);
      m.off = gest.grab + (wx - m.pts[0][0]) * n[0] + (wy - m.pts[0][1]) * n[1];
      drawUI();
    } else if (gest.mode === 'pan') {
      view.panBy(p[0] - gest.lx, p[1] - gest.ly);
      gest.lx = p[0]; gest.ly = p[1];
      const now = performance.now();
      gest.hist.push([now, p[0], p[1]]);
      while (gest.hist.length > 2 && now - gest.hist[0][0] > 90) gest.hist.shift();
    }
  });
  function endPointer(ev) {
    if (!ptrs.has(ev.pointerId)) return;
    const p = local(ev);
    ptrs.delete(ev.pointerId);
    if (!gest) return;
    if (gest.mode === 'pinch') {
      // 한 손가락이 남으면 그 손가락으로 이어서 이동
      if (ptrs.size === 1) { const q = [...ptrs.values()][0]; gest = { mode: 'pan', x0: q[0], y0: q[1], lx: q[0], ly: q[1], moved: true, hist: [] }; }
      else gest = null;
      return;
    }
    if (ptrs.size) return;
    const g = gest;
    gest = null;
    if (ev.type === 'pointercancel') { view.endLive(); return; }
    if (!g.moved && performance.now() - g.t0 < 350) { view.endLive(); onTap(p); return; }
    // 손을 뗀 속도로 조금 더 미끄러지기
    if (g.mode === 'pan' && g.hist.length >= 2) {
      const a = g.hist[0], b = g.hist[g.hist.length - 1], dt = b[0] - a[0];
      if (dt > 0 && performance.now() - b[0] < 60) {
        let vx = (b[1] - a[1]) / dt, vy = (b[2] - a[2]) / dt;
        const sp = Math.hypot(vx, vy), MAXV = 2.5; // px/ms
        if (sp > MAXV) { vx *= MAXV / sp; vy *= MAXV / sp; }
        if (Math.hypot(vx, vy) > 0.35) {
          let last = performance.now();
          const step = (now) => {
            const k = Math.min(48, now - last); last = now;
            view.panBy(vx * k, vy * k);
            const f = Math.pow(0.994, k);
            vx *= f; vy *= f;
            fling.raf = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : (fling = null, view.endLive(), 0);
          };
          fling = { raf: requestAnimationFrame(step) };
        }
      }
    }
    if (!fling) view.endLive();
  }
  ui.addEventListener('pointerup', endPointer);
  ui.addEventListener('pointercancel', endPointer);
  function onTap(p) {
    const now = performance.now();
    const dbl = lastTap && now - lastTap.t < 320 && Math.hypot(p[0] - lastTap.x, p[1] - lastTap.y) < 40;
    lastTap = dbl ? null : { t: now, x: p[0], y: p[1] };
    if (measuring()) {
      let [wx, wy] = view.toWorld(p[0], p[1]);
      const sn = findSnap(wx, wy, 30);
      if (sn) { wx = sn.x; wy = sn.y; }
      addPoint([wx, wy]);
      return;
    }
    if (dbl) animateZoom(p[0], p[1], 2.2);
  }
  function animateZoom(sx, sy, f) {
    const t0 = performance.now(), dur = 180;
    let done = 1;
    view.beginLive();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const target = Math.pow(f, 1 - Math.pow(1 - t, 3));
      view.zoomAt(sx, sy, target / done);
      done = target;
      if (t < 1) requestAnimationFrame(step); else view.endLive();
    };
    requestAnimationFrame(step);
  }
  // iOS 사파리의 페이지 확대 막기
  ['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
  // 마우스 휠(태블릿·PC 브라우저에서 확인용)
  ui.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (!S.scene) return;
    const [sx, sy] = local(ev);
    view.zoomAt(sx, sy, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)));
  }, { passive: false });

  // ───────────────────────── 더보기 ─────────────────────────
  function applyBg() { document.body.classList.toggle('light', view.light); view.request(); }
  $('#mn-bg').onclick = () => {
    view.light = !view.light;
    try { localStorage.setItem('bgLight', view.light ? '1' : '0'); } catch (e) { /* 무시 */ }
    applyBg();
    closeSheet();
  };
  $('#mn-measure').onclick = () => openSheet('measure');
  $('#mn-xrefs').onclick = () => openSheet('xrefs');
  $('#mn-snap').onclick = () => { $('#snap-opts').hidden = !$('#snap-opts').hidden; };
  $$('#snap-opts input').forEach((cb) => (cb.onchange = () => {
    try { localStorage.setItem(cb.id, cb.checked ? '1' : '0'); } catch (e) { /* 무시 */ }
    updateCenter(); drawUI();
  }));
  function renderInfo() {
    const s = S.scene;
    if (!s) { $('#doc-info').textContent = ''; return; }
    const st = s.stats;
    $('#doc-info').textContent = `${S.mainName} · 단위 ${UNITS[s.units] || '없음'} · 선 ${fmt(st.segments, 0)} · 채움 ${fmt(st.triangles, 0)} · 문자 ${fmt(st.texts, 0)} · 레이어 ${s.layers.length} · 열기 ${S.loadSec.toFixed(1)}초 + 구성 ${S.buildSec.toFixed(1)}초${s.space === 'paper' ? ' · 배치공간' : ''}`;
  }
  $('#mn-about').onclick = () => {
    closeSheet();
    hint('DWG 뷰어 · GPLv3 자유 소프트웨어 · 소스 github.com/JIKIHY/dwg-viewer-mobile · DWG 변환: GNU LibreDWG (libredwg-web, GPLv3) · 선 분할: earcut (ISC)', 10000);
  };
  $('#mn-png').onclick = async () => {
    closeSheet();
    if (!S.scene) return;
    view.render();
    const out = document.createElement('canvas');
    out.width = $('#gl').width; out.height = $('#gl').height;
    const c = out.getContext('2d');
    c.drawImage($('#gl'), 0, 0); c.drawImage($('#text'), 0, 0); c.drawImage(ui, 0, 0, out.width, out.height);
    const name = S.mainName.replace(/\.(dwg|dxf)$/i, '') + '_캡처.png';
    if (native) { native.postMessage({ type: 'share', name, dataUrl: out.toDataURL('image/png') }); return; }
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    const file = new File([blob], name, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // ───────────────────────── PDF 내보내기 ─────────────────────────
  // 화면 그리기(View)를 잠시 용지 크기의 큰 캔버스로 바꿔 흰 배경으로 한 번 그리고, 그 그림을 JPEG로 담은 PDF를 만든다
  const pdfOpt = { paper: 'A4', orient: 'auto', range: 'view' };
  $$('#sheet .seg').forEach((row) => row.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    row.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    pdfOpt[row.dataset.opt] = b.dataset.v;
  })));
  $('#mn-pdf').onclick = () => { if (S.scene) openSheet('pdf'); };
  const PAPER_PT = { A4: [842, 595], A3: [1191, 842] }; // 가로 기준 (pt = 1/72인치)

  function makePdf(jpeg, pw, ph, iw, ih) {
    // 한 쪽짜리 PDF: 이미지 하나를 여백 10mm 안에 비율을 지켜 가운데에 놓는다
    const m = 28.35, aw = pw - 2 * m, ah = ph - 2 * m;
    const k = Math.min(aw / iw, ah / ih), dw = iw * k, dh = ih * k;
    const dx = (pw - dw) / 2, dy = (ph - dh) / 2;
    const enc = new TextEncoder();
    const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm /Im0 Do Q`;
    const parts = []; const offs = []; let len = 0;
    const add = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const obj = (n, body) => { offs[n] = len; add(`${n} 0 obj\n`); for (const b of body) add(b); add('\nendobj\n'); };
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
    obj(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`]);
    obj(4, [`<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
    obj(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    const xref = len;
    let x = 'xref\n0 6\n0000000000 65535 f \n';
    for (let n = 1; n <= 5; n++) x += String(offs[n]).padStart(10, '0') + ' 00000 n \n';
    add(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }

  async function renderForPdf() {
    // 범위(세계 좌표)
    let x0, y0, x1, y1;
    if (pdfOpt.range === 'all') { [x0, y0, x1, y1] = S.scene.extents; }
    else { [x0, y1] = view.toWorld(0, 0); [x1, y0] = view.toWorld(view.w, view.h); }
    const land = pdfOpt.orient === 'land' || (pdfOpt.orient === 'auto' && (x1 - x0) >= (y1 - y0));
    const [pl, ps] = PAPER_PT[pdfOpt.paper];
    const pw = land ? pl : ps, ph = land ? ps : pl;
    // 용지 안쪽(여백 10mm) 크기로, 약 200dpi. 큰 캔버스는 휴대폰 메모리 한도 안으로 줄인다
    let dpr = 200 / 72;
    const iwPt = pw - 56.7, ihPt = ph - 56.7;
    while (iwPt * ihPt * dpr * dpr > 12e6) dpr *= 0.9;
    const keep = { cx: view.cx, cy: view.cy, scale: view.scale, w: view.w, h: view.h, dpr: view.dpr, light: view.light };
    try {
      view.light = true;
      view.resize(iwPt, ihPt, dpr);
      view.zoomTo(x0, y0, x1, y1, pdfOpt.range === 'all' ? 0.02 : 0);
      view.dirty = true; // 예약된 그리기를 막고 지금 한 번만 그린다
      view.render();
      const iw = view.gc.width, ih = view.gc.height;
      const c = document.createElement('canvas'); c.width = iw; c.height = ih;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, iw, ih);
      g.drawImage(view.gc, 0, 0); g.drawImage(view.tc, 0, 0);
      // 아래쪽에 파일 이름·날짜
      const fs = Math.round(9 * dpr);
      g.font = `${fs}px -apple-system, sans-serif`; g.fillStyle = '#555'; g.textAlign = 'right';
      const d = new Date();
      g.fillText(`${S.mainName} · ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} · 용지에 맞춤(축척 아님)`, iw - fs * 0.6, ih - fs * 0.6);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      c.width = c.height = 0;
      return { jpeg: new Uint8Array(await blob.arrayBuffer()), iw, ih, pw, ph };
    } finally {
      view.light = keep.light;
      view.resize(keep.w, keep.h, keep.dpr);
      view.cx = keep.cx; view.cy = keep.cy; view.scale = keep.scale;
      view.dirty = false; view.request();
    }
  }

  $('#pdf-make').onclick = async () => {
    if (!S.scene) return;
    closeSheet();
    setLoading(true, 'PDF 만드는 중…');
    let pdf;
    try {
      const r = await renderForPdf();
      pdf = makePdf(r.jpeg, r.pw, r.ph, r.iw, r.ih);
    } catch (e) {
      log('PDF 오류: ' + e.message);
      hint('PDF를 만들지 못했습니다: ' + e.message, 5000);
      return;
    } finally { setLoading(false); }
    const name = S.mainName.replace(/\.(dwg|dxf)$/i, '') + `_${pdfOpt.paper}.pdf`;
    const blob = new Blob([pdf], { type: 'application/pdf' });
    if (native) {
      const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      native.postMessage({ type: 'share', name, dataUrl });
      return;
    }
    const file = new File([blob], name, { type: 'application/pdf' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // ───────────────────────── 열기 버튼 / 처음 화면 ─────────────────────────
  const pickFiles = () => {
    if (native) { native.postMessage({ type: 'pick', mode: 'open' }); return; }
    $('#file').value = ''; $('#file').click();
  };
  $('#btn-open').onclick = pickFiles;
  $('#h-open').onclick = pickFiles;
  $('#file').addEventListener('change', (ev) => { const fs = [...ev.target.files]; if (fs.length) openFiles(fs); });
  $('#btn-home').onclick = () => { closeSheet(); showHome(true); };

  // iOS 앱 껍데기가 다른 앱에서 넘겨받은 파일을 여는 입구: [{name, url}]
  window.__nativeOpen = async (items, mode) => {
    log(`파일 ${items.length}개 받음: ${items.map((i) => i.name).join(', ')}`);
    setLoading(true, '파일 받는 중…');
    try {
      const files = [];
      for (const it of items) files.push(await fetchItem(it));
      log('받은 크기: ' + files.map((f) => f.bytes.byteLength).join(', '));
      setLoading(false);
      if (mode === 'xref') await takeXrefFiles(files);
      else await openFiles(files);
    } catch (err) { setLoading(false); hint('파일 받기 실패: ' + err.message, 6000); log('파일 받기 실패: ' + err.message); }
  };

  // ───────────────────────── 시작 ─────────────────────────
  try {
    view.light = localStorage.getItem('bgLight') === '1';
    for (const cb of $$('#snap-opts input')) { const v = localStorage.getItem(cb.id); if (v !== null) cb.checked = v === '1'; }
  } catch (e) { /* 무시 */ }
  applyBg();
  $$('#toolbar button').forEach((b) => (b.disabled = true));
  const stage = $('#stage');
  new ResizeObserver(() => { view.resize(stage.clientWidth, stage.clientHeight, dprOf()); drawUI(); }).observe(stage);
  view.resize(stage.clientWidth, stage.clientHeight, dprOf());
  showHome(true);
  if (native) native.postMessage({ type: 'ready' });
  // 개발용: ?memtest — 화면 엔진이 메모리를 몇 MB까지 쓸 수 있는지 100MB씩 늘려 가며 앱 로그로 남긴다
  if (/memtest/.test(location.search)) {
    const keep = [];
    let mbUsed = 0;
    const step = () => {
      const a = new Uint8Array(100 * 1048576);
      for (let i = 0; i < a.length; i += 4096) a[i] = 1; // 실제로 쓰게 만든다
      keep.push(a); mbUsed += 100;
      log(`메모리 시험 ${mbUsed}MB`);
      setTimeout(step, 250);
    };
    setTimeout(step, 500);
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  window.__dwg = { S, view, openFiles, openMain, pool };
})();
