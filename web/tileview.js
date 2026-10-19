// 휴대폰용 그리기: 코어 View를 이어받아 큰 도면을 구역(타일)으로 나눠 그린다.
//  - GPU로 한꺼번에 수백 MB를 넘기면 iOS 웹뷰가 멈추므로 구역별 작은 버퍼로 나눠 올린다
//  - 확대했을 때는 화면에 걸친 구역만 그린다
//  - 손가락으로 움직이는 동안(live)은 마지막 그림을 CSS로 옮기기만 하고, 손을 떼면 한 번 그린다
(function (global) {
  'use strict';

  class TileView extends View {
    constructor(glCanvas, textCanvas) {
      super(glCanvas, textCanvas);
      this.tiles = null;
      this.live = false;
      this.heavy = false;
      this.drawn = null; // 마지막으로 실제 그린 시점의 {cx, cy, scale}
      this.lastMs = 0; // 마지막 한 장 그리는 데 걸린 시간
      // 아래 _applyCss의 이동량은 왼쪽 위 기준으로 계산한다 (기본값인 가운데 기준이면 두 손가락 확대 때 도면이 손가락에서 미끄러짐)
      this.gc.style.transformOrigin = this.tc.style.transformOrigin = '0 0';
    }

    // 코어(lite)가 화면을 구성하면서 구역 하나가 완성될 때마다 불러 준다 → 바로 GPU로 올리고 색 배열은 버린다
    startTiles() { this._freeTiles(); this.tiles = []; }
    addTile(t, col) {
      const gl = this.gl;
      const lp = gl.createBuffer(), lc = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, lp); gl.bufferData(gl.ARRAY_BUFFER, t.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, lc); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
      this.tiles.push({ lp, lc, pieces: t.pieces, bb: t.bb, n: t.n });
    }

    setScene(scene, keepView) {
      if (!scene.tiles) { this._freeTiles(); this.heavy = false; super.setScene(scene, keepView); return; }
      this.scene = scene;
      this.heavy = scene.stats.segments > 1500000;
      const gl = this.gl;
      // 채움(삼각형)은 작아서 코어처럼 한 버퍼로
      const up = (b, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
      up(this.buf.tp, scene.triPos); up(this.buf.tc, scene.triCol);
      if (!keepView) this.zoomExtents();
      this.request();
    }

    _freeTiles() {
      if (!this.tiles) return;
      for (const t of this.tiles) { this.gl.deleteBuffer(t.lp); this.gl.deleteBuffer(t.lc); }
      this.tiles = null;
    }

    // ── 움직이는 동안 ──
    // 선이 많거나, 선이 적어도 한 장 그리는 데 한 프레임(~16ms)을 넘기면 움직이는 동안은 다시 그리지 않는다
    beginLive() { if (this.heavy || this.lastMs > 20) this.live = true; }
    endLive() {
      if (!this.live) return;
      this.live = false;
      this.dirty = false;
      this.render();
    }
    request() {
      if (this.live && this.drawn) { this._applyCss(); if (this.onLive) this.onLive(); return; }
      super.request();
    }
    _applyCss() {
      const d = this.drawn, k = this.scale / d.scale;
      const tx = this.w / 2 - (k * this.w) / 2 + (d.cx - this.cx) * this.scale;
      const ty = this.h / 2 - (k * this.h) / 2 - (d.cy - this.cy) * this.scale;
      const t = `matrix(${k},0,0,${k},${tx},${ty})`;
      this.gc.style.transform = t; this.tc.style.transform = t;
    }
    _clearCss() { this.gc.style.transform = ''; this.tc.style.transform = ''; }

    render() {
      const t0 = performance.now();
      this._render();
      this.lastMs = performance.now() - t0;
    }
    _render() {
      this._clearCss();
      this.drawn = { cx: this.cx, cy: this.cy, scale: this.scale };
      if (!this.tiles) { super.render(); return; }
      const gl = this.gl;
      gl.viewport(0, 0, this.gc.width, this.gc.height);
      const bg = this.light ? [1, 1, 1] : [0.106, 0.114, 0.129];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const tctx = this.tctx;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, this.tc.width, this.tc.height);
      const s = this.scene;
      gl.useProgram(this.prog);
      const kx = (2 * this.scale) / this.w, ky = (2 * this.scale) / this.h;
      const bx = (s.origin[0] - this.cx) * kx, by = (s.origin[1] - this.cy) * ky;
      gl.uniform4f(this.uT, kx, ky, bx, by);
      gl.uniform1f(this.uLight, this.light ? 1 : 0);
      gl.uniform1f(this.uMono, this.mono ? 1 : 0);
      gl.enableVertexAttribArray(this.aPos);
      gl.enableVertexAttribArray(this.aCol);
      const attach = (pb, cb) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.vertexAttribPointer(this.aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      };
      // 채움
      attach(this.buf.tp, this.buf.tc);
      for (const r of s.ranges) if (r.tc && this.isVisible(r.layer, r.group)) gl.drawArrays(gl.TRIANGLES, r.ts, r.tc);
      // 선: 화면(원점 기준 좌표)에 걸친 구역만, 이어지는 보이는 조각은 한 번에
      const [wx0, wy1] = this.toWorld(0, 0), [wx1, wy0] = this.toWorld(this.w, this.h);
      const vx0 = wx0 - s.origin[0], vx1 = wx1 - s.origin[0], vy0 = wy0 - s.origin[1], vy1 = wy1 - s.origin[1];
      for (const t of this.tiles) {
        const b = t.bb;
        if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
        attach(t.lp, t.lc);
        let runS = -1, runE = -1;
        for (const p of t.pieces) {
          if (this.isVisible(p.layer, p.group)) {
            if (runS < 0) runS = p.s;
            runE = p.s + p.n;
          } else if (runS >= 0) { gl.drawArrays(gl.LINES, runS, runE - runS); runS = -1; }
        }
        if (runS >= 0) gl.drawArrays(gl.LINES, runS, runE - runS);
      }
      this.renderText();
      if (this.onRender) this.onRender();
    }
  }

  global.TileView = TileView;
})(window);
