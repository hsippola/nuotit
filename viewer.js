// PDF-katselin: yksi sivu kerrallaan, sivunvaihto napauttamalla reunoja,
// pyyhkäisemällä tai näppäimistöllä / sivunkääntöpolkimella.

import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const HINT_KEY = 'nuotit.hintShown';
const EDGE = 0.33;          // reunavyöhykkeen osuus leveydestä
const CACHE_MAX = 6;        // valmiiksi piirrettyjä sivuja muistissa

const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ei tallennusta */ } },
};

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
  constructor({ onBack, onPage, onClosed }) {
    this.onBack = onBack;
    this.onPage = onPage;
    this.onClosed = onClosed;
    this.el = document.getElementById('viewer');
    this.stage = document.getElementById('stage');
    this.titleEl = document.getElementById('v-title');
    this.pageEl = document.getElementById('v-page');
    this.slider = document.getElementById('v-slider');
    this.fullBtn = document.getElementById('v-full');
    this.msgEl = document.getElementById('v-msg');
    this.hintEl = document.getElementById('tap-hint');

    this.pdf = null;
    this.score = null;
    this.page = 1;
    this.count = 0;
    this.cache = new Map();
    this.renderSeq = 0;
    this.wakeLock = null;

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
    this.slider.max = String(this.count);
    this.slider.disabled = this.count < 2;

    if (!prefs.get(HINT_KEY)) {
      prefs.set(HINT_KEY, '1');
      this.hintEl.hidden = false;
      setTimeout(() => { this.hintEl.hidden = true; }, 3600);
      this.#setUI(false);
    } else {
      this.#setUI(true, 2500);
    }
    await this.render();
  }

  close({ silent = false } = {}) {
    if (!this.isOpen && !this.pdf) return;
    this.renderSeq++;
    document.removeEventListener('keydown', this.onKey);
    clearTimeout(this.uiTimer);
    this.#clearCache();
    this.stage.replaceChildren();
    this.hintEl.hidden = true;
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    document.body.style.overflow = '';
    this.el.hidden = true;
    this.score = null;
    if (!silent) this.onClosed?.();
  }

  next() { this.goTo(this.page + 1); }
  prev() { this.goTo(this.page - 1); }

  goTo(n) {
    if (!this.pdf) return;
    if (n > this.count) { this.#msg('Viimeinen sivu'); return; }
    n = Math.max(1, n);
    if (n === this.page) { this.#msg('Ensimmäinen sivu'); return; }
    this.page = n;
    this.render();
    this.onPage?.(n);
  }

  // ---------- Piirtäminen ----------

  async render() {
    if (!this.pdf) return;
    const seq = ++this.renderSeq;
    const w = Math.max(50, this.stage.clientWidth - 8);
    const h = Math.max(50, this.stage.clientHeight - 8);
    this.#updateIndicator();

    let canvas;
    try {
      canvas = await this.#canvas(this.page, w, h);
    } catch (err) {
      if (seq === this.renderSeq) { console.error(err); this.#msg('Sivun piirtäminen epäonnistui'); }
      return;
    }
    if (seq !== this.renderSeq) return;
    this.stage.replaceChildren(canvas);

    // Piirretään seuraava ja edellinen sivu valmiiksi, jotta sivu vaihtuu heti.
    for (const n of [this.page + 1, this.page - 1]) {
      if (seq !== this.renderSeq) return;
      if (n < 1 || n > this.count) continue;
      try { await this.#canvas(n, w, h); } catch { /* ohitetaan */ }
    }
  }

  #canvas(n, boxW, boxH) {
    const key = `${n}|${Math.round(boxW)}x${Math.round(boxH)}`;
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);       // päivitetään LRU-järjestys
      this.cache.set(key, entry);
      return entry.promise;
    }
    const promise = this.#draw(n, boxW, boxH);
    entry = { n, promise };
    this.cache.set(key, entry);
    promise.catch(() => this.cache.delete(key));
    this.#evict();
    return promise;
  }

  async #draw(n, boxW, boxH) {
    const page = await this.pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(boxW / base.width, boxH / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // iOS rajoittaa canvasin kokoa (~16 Mpx); pysytään reilusti alle.
    let scale = fit * dpr;
    const px = base.width * base.height * scale * scale;
    if (px > 12e6) scale *= Math.sqrt(12e6 / px);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(base.width * fit)}px`;
    canvas.style.height = `${Math.floor(base.height * fit)}px`;
    canvas.dataset.page = String(n);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  #evict() {
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= CACHE_MAX) break;
      if (Math.abs(entry.n - this.page) <= 3) continue;   // lähisivut säilytetään
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

  #bind() {
    // Napautukset ja pyyhkäisyt
    let start = null;
    this.stage.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary) { start = null; return; }   // toinen sormi → ei sivunvaihtoa
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    this.stage.addEventListener('pointercancel', () => { start = null; });
    this.stage.addEventListener('pointerup', (e) => {
      const s = start;
      start = null;
      if (!s || s.id !== e.pointerId || !this.pdf) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) this.next(); else this.prev();
        this.#setUI(false);
        return;
      }
      if (Math.hypot(dx, dy) > 12) return;
      const r = this.el.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      if (fx < EDGE) { this.#flash('left'); this.prev(); this.#setUI(false); }
      else if (fx > 1 - EDGE) { this.#flash('right'); this.next(); this.#setUI(false); }
      else this.#setUI(this.el.classList.contains('ui-hidden'), 4000);
    });

    // Näppäimistö ja Bluetooth-sivunkääntöpolkimet
    this.onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter':
          e.preventDefault(); this.next(); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
          e.preventDefault(); this.prev(); break;
        case 'Home': e.preventDefault(); this.goTo(1); break;
        case 'End': e.preventDefault(); this.goTo(this.count); break;
        case 'Escape': e.preventDefault(); this.onBack?.(); break;
      }
    };

    // Työkalurivit
    document.getElementById('v-back').addEventListener('click', () => this.onBack?.());
    document.getElementById('v-prev').addEventListener('click', () => this.prev());
    document.getElementById('v-next').addEventListener('click', () => this.next());
    this.slider.addEventListener('input', () => {
      this.pageEl.textContent = `${this.slider.value} / ${this.count}`;
      this.#setUI(true, 4000);
    });
    this.slider.addEventListener('change', () => {
      const n = Number(this.slider.value);
      if (n !== this.page) { this.page = n; this.render(); this.onPage?.(n); }
    });
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
      resizeTimer = setTimeout(() => { this.#clearCache(); this.render(); }, 150);
    }).observe(this.stage);

    document.addEventListener('visibilitychange', () => {
      if (this.isOpen && document.visibilityState === 'visible') this.#lockScreen();
    });
  }
}
