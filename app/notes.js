// Merkinnät nuotteihin: kynä, korostus ja pyyhekumi.
// Merkinnät ovat vektoriviivoja SVG-kerroksessa sivun päällä, joten ne eivät lisää
// sivujen piirtämistä eivätkä vie paljon muistia. Koordinaatit ovat sivun omissa
// yksiköissä (leveys = NOTE_W), joten merkinnät pysyvät paikallaan zoomattaessa ja
// näytön koosta tai suunnasta riippumatta.

const NS = 'http://www.w3.org/2000/svg';
export const NOTE_W = 1000;

export const TOOLS = {
  black: { color: '#1b1b1b', width: 3 },
  red: { color: '#d32f2f', width: 3 },
  blue: { color: '#1565c0', width: 3 },
  hl: { color: '#ffd400', width: 18, opacity: 0.45 },
  eraser: { eraser: true },
};

const round = (v) => Math.round(v * 10) / 10;

/** SVG-polku pisteistä; keskipisteiden kautta kulkeva käyrä tekee viivasta pehmeän. */
function pathData(p) {
  const n = p.length / 2;
  if (n === 1) return `M${p[0]} ${p[1]}l0 .01`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i];
    const y = p[2 * i + 1];
    d += `Q${x} ${y} ${round((x + p[2 * i + 2]) / 2)} ${round((y + p[2 * i + 3]) / 2)}`;
  }
  return `${d}L${p[2 * n - 2]} ${p[2 * n - 1]}`;
}

/** Pisteen etäisyys janasta toiseen potenssiin. */
function dist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

function hits(stroke, x, y, r) {
  const p = stroke.p;
  const rr = (r + stroke.w / 2) ** 2;
  if (p.length === 2) return dist2(x, y, p[0], p[1], p[0], p[1]) <= rr;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (dist2(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= rr) return true;
  }
  return false;
}

export class Notes {
  constructor(svg, { onChange }) {
    this.svg = svg;
    this.onChange = onChange;
    this.pages = {};     // sivunumero → [{ c: väri, w: leveys, o?: läpinäkyvyys, p: [x, y, x, y, …] }]
    this.page = 0;
    this.history = [];   // kumottavat muutokset
    this.cur = null;     // keskeneräinen viiva
    this.erased = null;  // pyyhkimisen aikana poistetut viivat
  }

  load(pages) {
    this.pages = pages && typeof pages === 'object' ? pages : {};
    this.history = [];
    this.cur = null;
    this.erased = null;
  }

  /** Näyttää sivun n merkinnät. `aspect` = sivun korkeus / leveys. */
  show(n, aspect) {
    this.page = n;
    this.svg.setAttribute('viewBox', `0 0 ${NOTE_W} ${round(NOTE_W * aspect)}`);
    this.#render();
  }

  get strokes() { return this.pages[this.page] || []; }

  hasUndo() { return this.history.some((h) => h.page === this.page); }

  #render() {
    this.svg.replaceChildren(...this.strokes.map((s) => this.#path(s)));
  }

  #path(s) {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', pathData(s.p));
    el.setAttribute('stroke', s.c);
    el.setAttribute('stroke-width', String(s.w));
    if (s.o) el.setAttribute('stroke-opacity', String(s.o));
    return el;
  }

  // ---------- Kynä ja korostus ----------

  begin(toolName, x, y) {
    const t = TOOLS[toolName] || TOOLS.black;
    const stroke = { c: t.color, w: t.width, p: [round(x), round(y)] };
    if (t.opacity) stroke.o = t.opacity;
    const el = this.#path(stroke);
    // Korostus piirretään muiden alle, jotta nuotit ja kynämerkinnät näkyvät sen läpi.
    if (stroke.o) this.svg.prepend(el); else this.svg.append(el);
    this.cur = { stroke, el };
  }

  extend(x, y, minDist = 0.8) {
    const c = this.cur;
    if (!c) return;
    const p = c.stroke.p;
    if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < minDist) return;
    p.push(round(x), round(y));
    c.el.setAttribute('d', pathData(p));
  }

  end(commit = true) {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    if (!commit) { c.el.remove(); return; }
    const list = this.pages[this.page] || (this.pages[this.page] = []);
    // Korostukset alkuun (alimmaksi), kynäviivat loppuun – sama järjestys kuin näytöllä.
    if (c.stroke.o) list.unshift(c.stroke); else list.push(c.stroke);
    this.history.push({ page: this.page, add: c.stroke });
    this.onChange?.();
  }

  // ---------- Pyyhekumi: poistaa koko viivan, jota kosketaan ----------

  eraseBegin() { this.erased = []; }

  eraseAt(x, y, r) {
    if (!this.erased) return;
    const list = this.strokes;
    let changed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (hits(list[i], x, y, r)) {
        this.erased.push({ stroke: list[i], index: i });
        list.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.#render();
  }

  eraseEnd() {
    const erased = this.erased;
    this.erased = null;
    if (!erased?.length) return;
    this.history.push({ page: this.page, erased });
    this.#tidy();
    this.onChange?.();
  }

  // ---------- Kumoa ja tyhjennä ----------

  /** Kumoaa tämän sivun viimeisimmän muutoksen. */
  undo() {
    let i = this.history.length - 1;
    while (i >= 0 && this.history[i].page !== this.page) i--;
    if (i < 0) return false;
    const [h] = this.history.splice(i, 1);
    const list = this.pages[h.page] || (this.pages[h.page] = []);
    if (h.add) {
      const at = list.lastIndexOf(h.add);
      if (at >= 0) list.splice(at, 1);
    } else if (h.erased) {
      for (const { stroke, index } of [...h.erased].reverse()) list.splice(index, 0, stroke);
    } else if (h.cleared) {
      list.push(...h.cleared);
    }
    this.#tidy();
    this.#render();
    this.onChange?.();
    return true;
  }

  clearPage() {
    const list = this.strokes;
    if (!list.length) return false;
    this.history.push({ page: this.page, cleared: list.slice() });
    delete this.pages[this.page];
    this.#render();
    this.onChange?.();
    return true;
  }

  #tidy() {
    for (const k of Object.keys(this.pages)) if (!this.pages[k].length) delete this.pages[k];
  }
}
