// PDF-katselin: yksi sivu kerrallaan.
// - Sivunvaihto: napauta reunoja, pyyhkäise tai käytä näppäimistöä / sivunkääntöpoljinta.
// - Zoomaus: nipistä kahdella sormella, kaksoisnapauta keskeltä, valikon −/+ tai Ctrl+rulla.
//   Zoomattuna sivua siirretään yhdellä sormella vetämällä, ja reunan napautus
//   vierittää ensin sivua alas/ylös ennen kuin sivu vaihtuu.

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const HINT_KEY = 'nuotit.hintShown';
const EDGE = 0.33;          // reunavyöhykkeen osuus leveydestä
const CACHE_MAX = 4;        // valmiiksi piirrettyjä sivuja muistissa
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
const MAX_PIXELS = 12e6;    // iOS rajoittaa canvasin kokoa (~16 Mpx); pysytään alle
const MARGIN = 4;           // reunus sivun ympärillä (px)
const DOUBLE_TAP_MS = 280;
const SCROLL_PART = 0.85;   // kuinka suuri osa näkymästä vieritetään kerralla

const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ei tallennusta */ } },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampZoom = (z) => clamp(Number(z) || 1, MIN_ZOOM, MAX_ZOOM);

/** Lukee PDF:n sivumäärän ja piirtää ensimmäisestä sivusta pikkukuvan. */
export async function analyzePdf(data) {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const thumb = canvas.toDataURL('image/jpeg', 0.8);
    canvas.width = canvas.height = 0;
    return { pageCount: pdf.numPages, thumb };
  } finally {
    pdf.destroy();
  }
}

export class Viewer {
  constructor({ onBack, onPage, onZoom, onClosed }) {
    this.onBack = onBack;
    this.onPage = onPage;
    this.onZoom = onZoom;
    this.onClosed = onClosed;
    this.el = document.getElementById('viewer');
    this.stage = document.getElementById('stage');
    this.titleEl = document.getElementById('v-title');
    this.pageEl = document.getElementById('v-page');
    this.slider = document.getElementById('v-slider');
    this.fullBtn = document.getElementById('v-full');
    this.zoomLabel = document.getElementById('v-zoom-label');
    this.msgEl = document.getElementById('v-msg');
    this.hintEl = document.getElementById('tap-hint');
    this.badgeEl = document.getElementById('page-badge');

    this.pdf = null;
    this.score = null;
    this.page = 1;
    this.count = 0;
    this.cache = new Map();
    this.wanted = new Set();
    this.renderSeq = 0;
    this.wakeLock = null;

    // Näkymän tila: zoom-kerroin ja sivun vasemman yläkulman paikka näkymässä.
    this.zoom = 1;
    this.x = 0;
    this.y = 0;
    this.canvas = null;     // näkyvä sivu
    this.align = 'top';     // mihin kohtaan uusi sivu asetetaan ('top' | 'bottom' | null = pidä paikka)

    this.#bind();
  }

  get isOpen() { return !this.el.hidden; }

  async open(score, data) {
    this.close({ silent: true });
    this.score = score;
    this.titleEl.textContent = score.title;
    this.stage.innerHTML = '<div class="loading">Ladataan…</div>';
    this.el.hidden = false;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', this.onKey);
    this.#lockScreen();

    this.pdf = await pdfjsLib.getDocument({ data }).promise;
    this.count = this.pdf.numPages;
    this.page = Math.min(Math.max(1, score.lastPage || 1), this.count);
    this.zoom = clampZoom(score.zoom);
    this.x = 0;
    this.y = 0;
    this.align = 'top';
    this.slider.max = String(this.count);
    this.slider.disabled = this.count < 2;
    this.#updateZoomLabel();

    if (!prefs.get(HINT_KEY)) {
      prefs.set(HINT_KEY, '1');
      this.hintEl.hidden = false;
      setTimeout(() => { this.hintEl.hidden = true; }, 4200);
      this.#setUI(false);
    } else {
      this.#setUI(true, 2500);
    }
    this.#showBadge();
    await this.render();
  }

  close({ silent = false } = {}) {
    if (!this.isOpen && !this.pdf) return;
    this.renderSeq++;
    document.removeEventListener('keydown', this.onKey);
    clearTimeout(this.uiTimer);
    clearTimeout(this.tapTimer);
    clearTimeout(this.sharpenTimer);
    clearTimeout(this.badgeTimer);
    this.badgeEl.classList.remove('show');
    this.#clearCache();
    this.stage.replaceChildren();
    this.canvas = null;
    this.hintEl.hidden = true;
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    document.body.style.overflow = '';
    this.el.hidden = true;
    this.score = null;
    if (!silent) this.onClosed?.();
  }

  // ---------- Sivunvaihto ----------

  /** Seuraava: zoomattuna vieritetään ensin sivun loppuun, sitten vaihdetaan sivu. */
  next() {
    if (this.#scrollStep(1)) return;
    this.goTo(this.page + 1, 'top');
  }

  /** Edellinen: zoomattuna vieritetään ensin sivun alkuun, sitten edellisen sivun loppuun. */
  prev() {
    if (this.#scrollStep(-1)) return;
    this.goTo(this.page - 1, 'bottom');
  }

  goTo(n, align = 'top') {
    if (!this.pdf) return;
    if (n > this.count) { this.#msg('Viimeinen sivu'); return; }
    if (n < 1) { this.#msg('Ensimmäinen sivu'); return; }
    if (n === this.page) return;
    this.page = n;
    this.align = align;
    this.#showBadge();
    this.render();
    this.onPage?.(n);
  }

  /** Näyttää sivunumeron hetken vasemmassa yläkulmassa. */
  #showBadge() {
    this.badgeEl.textContent = `${this.page} / ${this.count}`;
    this.badgeEl.classList.add('show');
    clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => this.badgeEl.classList.remove('show'), 2500);
  }

  #scrollStep(dir) {
    if (!this.canvas) return false;
    const { H } = this.#view();
    const dh = this.canvas.fitH * this.zoom;
    if (dh <= H + 1) return false;
    const minY = H - dh;
    if (dir > 0 && this.y <= minY + 1) return false;
    if (dir < 0 && this.y >= -1) return false;
    this.y = clamp(this.y - dir * H * SCROLL_PART, minY, 0);
    this.#apply(true);
    return true;
  }

  // ---------- Zoomaus ----------

  /** Zoomaa niin, että näkymän piste (cx, cy) pysyy paikallaan. */
  zoomAt(z, cx, cy, animate = false) {
    if (!this.canvas) return;
    z = clampZoom(z);
    const px = (cx - this.x) / this.zoom;
    const py = (cy - this.y) / this.zoom;
    this.zoom = z;
    this.x = cx - px * z;
    this.y = cy - py * z;
    this.#apply(animate);
    this.#zoomChanged();
  }

  zoomBy(factor) {
    const { W, H } = this.#view();
    this.zoomAt(this.zoom * factor, W / 2, H / 2, true);
  }

  resetZoom() {
    const { W, H } = this.#view();
    this.zoomAt(1, W / 2, H / 2, true);
  }

  #zoomChanged() {
    this.#updateZoomLabel();
    this.onZoom?.(this.zoom);
    // Piirretään sivu terävämmäksi, kun zoomaus on hetken pysynyt paikallaan.
    clearTimeout(this.sharpenTimer);
    this.sharpenTimer = setTimeout(() => {
      if (this.canvas && this.canvas.renderZoom !== this.#renderZoom()) {
        this.align = null;
        this.render();
      }
    }, 250);
  }

  #updateZoomLabel() {
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)} %`;
  }

  /** Piirtotarkkuus pyöristetään puolikkaisiin, ettei jokainen pieni muutos piirrä uudelleen. */
  #renderZoom() {
    return this.zoom <= 1.01 ? 1 : Math.min(MAX_ZOOM, Math.ceil(this.zoom * 2) / 2);
  }

  /** Rajaa paikan niin, ettei sivu karkaa näkyvistä; pienempi kuin näkymä → keskitetään. */
  #clampPosition() {
    if (!this.canvas) return;
    const { W, H } = this.#view();
    const dw = this.canvas.fitW * this.zoom;
    const dh = this.canvas.fitH * this.zoom;
    this.x = dw <= W ? (W - dw) / 2 : clamp(this.x, W - dw, 0);
    this.y = dh <= H ? (H - dh) / 2 : clamp(this.y, H - dh, 0);
  }

  #apply(animate = false) {
    if (!this.canvas) return;
    this.#clampPosition();
    this.canvas.classList.toggle('animating', animate);
    this.canvas.style.transform = `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.zoom})`;
  }

  // ---------- Piirtäminen ----------

  async render() {
    if (!this.pdf) return;
    const seq = ++this.renderSeq;
    const { W, H } = this.#view();
    const rz = this.#renderZoom();
    this.#updateIndicator();

    const neighbours = [this.page + 1, this.page - 1].filter((n) => n >= 1 && n <= this.count);
    this.wanted = new Set([this.page, ...neighbours].map((n) => this.#key(n, W, H, rz)));

    let canvas;
    try {
      canvas = await this.#canvas(this.page, W, H, rz);
    } catch (err) {
      if (seq === this.renderSeq) { console.error(err); this.#msg('Sivun piirtäminen epäonnistui'); }
      return;
    }
    if (seq !== this.renderSeq) return;
    this.#show(canvas);

    // Piirretään seuraava ja edellinen sivu valmiiksi, jotta sivu vaihtuu heti.
    for (const n of neighbours) {
      if (seq !== this.renderSeq) return;
      try { await this.#canvas(n, W, H, rz); } catch { /* ohitetaan */ }
    }
  }

  #show(canvas) {
    const { H } = this.#view();
    const old = this.canvas;
    this.canvas = canvas;
    if (this.align === 'top') this.y = 0;
    if (this.align === 'bottom') this.y = H - canvas.fitH * this.zoom;
    this.align = null;   // null: sama sivu tarkempana → paikka säilyy
    this.#apply(false);
    if (old !== canvas) this.stage.replaceChildren(canvas);
  }

  #view() {
    return { W: Math.max(50, this.stage.clientWidth), H: Math.max(50, this.stage.clientHeight) };
  }

  #key(n, W, H, rz) { return `${n}|${Math.round(W)}x${Math.round(H)}|${rz}`; }

  #canvas(n, W, H, rz) {
    const key = this.#key(n, W, H, rz);
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);       // päivitetään LRU-järjestys
      this.cache.set(key, entry);
      return entry.promise;
    }
    const promise = this.#draw(n, W, H, rz);
    entry = { promise };
    this.cache.set(key, entry);
    promise.catch(() => this.cache.delete(key));
    this.#evict();
    return promise;
  }

  async #draw(n, W, H, rz) {
    const page = await this.pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min((W - 2 * MARGIN) / base.width, (H - 2 * MARGIN) / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = fit * rz * dpr;
    const px = base.width * base.height * scale * scale;
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.fitW = base.width * fit;
    canvas.fitH = base.height * fit;
    canvas.renderZoom = rz;
    canvas.style.width = `${canvas.fitW}px`;
    canvas.style.height = `${canvas.fitH}px`;
    canvas.dataset.page = String(n);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  #evict() {
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= CACHE_MAX) break;
      if (this.wanted.has(key)) continue;
      this.cache.delete(key);
      entry.promise.then((c) => { if (!c.isConnected) c.width = c.height = 0; }, () => {});
    }
  }

  #clearCache() {
    for (const entry of this.cache.values()) {
      entry.promise.then((c) => { if (!c.isConnected) c.width = c.height = 0; }, () => {});
    }
    this.cache.clear();
  }

  #updateIndicator() {
    this.pageEl.textContent = `${this.page} / ${this.count}`;
    this.slider.value = String(this.page);
  }

  // ---------- Käyttöliittymä ----------

  #setUI(visible, autoHideMs = 0) {
    clearTimeout(this.uiTimer);
    this.el.classList.toggle('ui-hidden', !visible);
    if (visible && autoHideMs) this.uiTimer = setTimeout(() => this.#setUI(false), autoHideMs);
  }

  #msg(text) {
    this.msgEl.textContent = text;
    this.msgEl.hidden = false;
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => { this.msgEl.hidden = true; }, 1100);
  }

  #flash(side) {
    const el = document.getElementById(side === 'left' ? 'flash-left' : 'flash-right');
    el.classList.remove('on');
    void el.offsetWidth;   // käynnistää animaation uudelleen
    el.classList.add('on');
  }

  async #lockScreen() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* ei tuettu tai estetty */ }
  }

  #toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
    }
  }

  /** Yksittäinen napautus kohdassa (cx, cy). */
  #tap(cx, cy) {
    const { W } = this.#view();
    const fx = cx / W;
    if (fx < EDGE) { this.#flash('left'); this.prev(); this.#setUI(false); return; }
    if (fx > 1 - EDGE) { this.#flash('right'); this.next(); this.#setUI(false); return; }

    // Keskialue: kaksoisnapautus zoomaa, yksittäinen näyttää/piilottaa valikon.
    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(cx - last.x, cy - last.y) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      if (this.zoom > 1.05) {
        this.zoomAt(1, cx, cy, true);
      } else {
        // Leveyden mukaan (vaakatasossa), muuten 2×.
        const fitWidth = W / this.canvas.fitW;
        this.zoomAt(fitWidth >= 1.3 ? fitWidth : 2, cx, cy, true);
      }
      return;
    }
    this.lastTap = { t: now, x: cx, y: cy };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
      this.#setUI(this.el.classList.contains('ui-hidden'), 4000);
    }, DOUBLE_TAP_MS);
  }

  #bind() {
    // ----- Kosketus ja hiiri: napautus, pyyhkäisy, vetäminen, nipistys -----
    // Kosketusnäytöllä käytetään Touch-tapahtumia: ne tunnistavat kahden sormen
    // nipistyksen luotettavimmin iPadilla ja Androidilla, ja niiden avulla selaimen
    // oma sivun zoomaus saadaan estettyä. Hiiri ja kynä käyttävät Pointer-tapahtumia.
    const pts = new Map();   // aktiiviset sormet/osoittimet: tunniste → { x, y }
    let g = null;            // meneillään oleva ele
    const hasTouch = 'ontouchstart' in window;
    const local = (e) => {
      const r = this.stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const startPinch = () => {
      const [a, b] = [...pts.values()];
      g = {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        z0: this.zoom, x0: this.x, y0: this.y,
      };
    };

    const down = (id, p) => {
      pts.set(id, p);
      if (pts.size === 1) g = { type: 'tap', sx: p.x, sy: p.y, x0: this.x, y0: this.y };
      else if (pts.size === 2) startPinch();
      else g = { type: 'none' };
    };

    const move = (changes) => {
      for (const [id, p] of changes) if (pts.has(id)) pts.set(id, p);
      if (!g) return;

      if (g.type === 'pinch') {
        if (pts.size !== 2) return;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const z = clampZoom(g.z0 * d / g.d0);
        // Nipistyksen alkukohdan sivupiste seuraa sormien keskipistettä.
        this.x = mx - (g.mx - g.x0) / g.z0 * z;
        this.y = my - (g.my - g.y0) / g.z0 * z;
        this.zoom = z;
        this.#apply(false);
        this.#updateZoomLabel();
        return;
      }

      if ((g.type === 'tap' || g.type === 'pan') && pts.size === 1) {
        const [p] = pts.values();
        const dx = p.x - g.sx;
        const dy = p.y - g.sy;
        if (g.type === 'tap' && Math.hypot(dx, dy) > 10) g.type = this.zoom > 1.01 ? 'pan' : 'swipe';
        if (g.type === 'pan') {
          this.x = g.x0 + dx;
          this.y = g.y0 + dy;
          this.#apply(false);
        }
      }
    };

    const up = (id, p, cancelled) => {
      if (!pts.has(id)) return;
      pts.delete(id);
      if (!g) return;

      if (g.type === 'pinch') {
        // Nipistys päättyy ensimmäisen sormen noustessa; jäljelle jäävä sormi ei tee mitään.
        this.#zoomChanged();
        g = pts.size ? { type: 'none' } : null;
        return;
      }
      if (cancelled || pts.size || g.type === 'none' || g.type === 'pan') { g = pts.size ? { type: 'none' } : null; return; }

      const dx = p.x - g.sx;
      const dy = p.y - g.sy;
      if (g.type === 'swipe') {
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) this.goTo(this.page + 1, 'top'); else this.goTo(this.page - 1, 'top');
          this.#setUI(false);
        }
      } else if (g.type === 'tap') {
        this.#tap(p.x, p.y);
      }
      g = null;
    };

    if (hasTouch) {
      const opts = { passive: false };
      this.stage.addEventListener('touchstart', (e) => {
        if (!this.pdf) return;
        e.preventDefault();   // estää selaimen oman zoomauksen, vierityksen ja kaksoisnapautuszoomin
        for (const t of e.changedTouches) down(`t${t.identifier}`, local(t));
      }, opts);
      this.stage.addEventListener('touchmove', (e) => {
        e.preventDefault();
        move([...e.changedTouches].map((t) => [`t${t.identifier}`, local(t)]));
      }, opts);
      const touchEnd = (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) up(`t${t.identifier}`, local(t), e.type === 'touchcancel');
      };
      this.stage.addEventListener('touchend', touchEnd, opts);
      this.stage.addEventListener('touchcancel', touchEnd, opts);
    }

    const handledByTouch = (e) => hasTouch && e.pointerType === 'touch';
    this.stage.addEventListener('pointerdown', (e) => {
      if (!this.pdf || handledByTouch(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
      try { this.stage.setPointerCapture(e.pointerId); } catch { /* ei tuettu */ }
      down(`p${e.pointerId}`, local(e));
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!handledByTouch(e)) move([[`p${e.pointerId}`, local(e)]]);
    });
    const pointerEnd = (e) => {
      if (!handledByTouch(e)) up(`p${e.pointerId}`, local(e), e.type === 'pointercancel');
    };
    this.stage.addEventListener('pointerup', pointerEnd);
    this.stage.addEventListener('pointercancel', pointerEnd);

    // Safari: estetään koko sivun zoomaus nipistyksellä.
    this.el.addEventListener('gesturestart', (e) => e.preventDefault());

    // Rulla: Ctrl/⌘ + rulla (tai kosketuslevyn nipistys) zoomaa, pelkkä rulla siirtää zoomattua sivua.
    this.stage.addEventListener('wheel', (e) => {
      if (!this.canvas) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.stage.clientHeight : 1;
      const p = local(e);
      if (e.ctrlKey || e.metaKey) {
        const delta = clamp(e.deltaY * unit, -50, 50);   // hiiren pykälä ≈ 25 %, kosketuslevy portaattomasti
        this.zoomAt(this.zoom * Math.exp(-delta * 0.005), p.x, p.y);
      } else if (this.zoom > 1.01) {
        this.x -= e.deltaX * unit;
        this.y -= e.deltaY * unit;
        this.#apply(false);
      }
    }, { passive: false });

    // ----- Näppäimistö ja Bluetooth-sivunkääntöpolkimet -----
    this.onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.altKey) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl + / Ctrl − / Ctrl 0 zoomaavat nuottia selaimen zoomin sijaan.
        if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(ZOOM_STEP); }
        else if (e.key === '-') { e.preventDefault(); this.zoomBy(1 / ZOOM_STEP); }
        else if (e.key === '0') { e.preventDefault(); this.resetZoom(); }
        return;
      }
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter':
          e.preventDefault(); this.next(); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
          e.preventDefault(); this.prev(); break;
        case 'Home': e.preventDefault(); this.goTo(1); break;
        case 'End': e.preventDefault(); this.goTo(this.count); break;
        case '+': case '=': e.preventDefault(); this.zoomBy(ZOOM_STEP); break;
        case '-': e.preventDefault(); this.zoomBy(1 / ZOOM_STEP); break;
        case '0': e.preventDefault(); this.resetZoom(); break;
        case 'Escape': e.preventDefault(); this.onBack?.(); break;
      }
    };

    // ----- Työkalurivit -----
    document.getElementById('v-back').addEventListener('click', () => this.onBack?.());
    document.getElementById('v-prev').addEventListener('click', () => this.goTo(this.page - 1, 'top'));
    document.getElementById('v-next').addEventListener('click', () => this.goTo(this.page + 1, 'top'));
    document.getElementById('v-zoom-out').addEventListener('click', () => this.zoomBy(1 / ZOOM_STEP));
    document.getElementById('v-zoom-in').addEventListener('click', () => this.zoomBy(ZOOM_STEP));
    this.zoomLabel.addEventListener('click', () => this.resetZoom());
    this.slider.addEventListener('input', () => {
      this.pageEl.textContent = `${this.slider.value} / ${this.count}`;
      this.#setUI(true, 4000);
    });
    this.slider.addEventListener('change', () => this.goTo(Number(this.slider.value), 'top'));
    const fsSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    if (!fsSupported) this.fullBtn.hidden = true;
    this.fullBtn.addEventListener('click', () => this.#toggleFullscreen());
    for (const bar of this.el.querySelectorAll('.v-bar')) {
      bar.addEventListener('pointerdown', () => this.#setUI(true, 4000));
    }

    // Koon muutos (kierto, ikkunan koko) → piirretään uudelleen
    let resizeTimer;
    new ResizeObserver(() => {
      if (!this.pdf) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { this.#clearCache(); this.align = null; this.render(); }, 150);
    }).observe(this.stage);

    document.addEventListener('visibilitychange', () => {
      if (this.isOpen && document.visibilityState === 'visible') this.#lockScreen();
    });
  }
}
