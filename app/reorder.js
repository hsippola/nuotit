// Nuottikorttien järjestäminen raahaamalla.
// Kosketusnäytöllä kortti otetaan painamalla sitä hetken (pitkä painallus), jolloin
// tavallinen vieritys ja napautus toimivat ennallaan. Hiirellä riittää raahaus.
// Kortin voi myös pudottaa `[data-drop]`-kohteen (esim. kansion) päälle.

const HOLD_MS = 380;      // pitkän painalluksen kesto
const TOUCH_SLOP = 10;    // näin paljon sormi saa liikkua odotuksen aikana (muuten vieritetään)
const MOUSE_SLOP = 6;
const EDGE = 80;          // automaattinen vieritys, kun raahataan näin lähelle ylä- tai alareunaa
const MAX_SCROLL = 16;    // px / ruutu

/**
 * @param {HTMLElement} grid  korttien säiliö; kortit ovat `.card[data-id]`-elementtejä
 * @param {{ onDrop(ids: string[]): void, onDropInto?(target: string, id: string): void }} opts
 *   onDrop: kutsutaan uudella järjestyksellä, jos se muuttui
 *   onDropInto: kortti pudotettiin kohteen päälle (kohteen data-drop-arvo ja kortin id)
 * @returns {{ cancel(): void, readonly active: boolean }}
 */
export function enableReorder(grid, { onDrop, onDropInto }) {
  let pending = null;   // { card, x, y, touchId?, mouse?, timer? }
  let drag = null;      // { card, ghost, offX, offY, x, y, before, touchId?, mouse?, raf }
  let swallowClick = false;

  const cards = () => [...grid.querySelectorAll(':scope > .card')];
  const ids = () => cards().map((c) => c.dataset.id);
  const cardOf = (target) => {
    const c = target?.closest?.('.card');
    return c && c.parentElement === grid ? c : null;
  };
  const touchById = (list, id) => [...list].find((t) => t.identifier === id);

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  // ---------- Raahaus ----------

  function start(card, x, y, extra) {
    cancelPending();
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('data-id');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
    const offX = x - r.left;
    const offY = y - r.top;
    ghost.style.transformOrigin = `${offX}px ${offY}px`;
    document.body.append(ghost);
    card.classList.add('drag-placeholder');
    document.documentElement.classList.add('reordering');
    drag = { card, ghost, offX, offY, x, y, before: ids(), raf: 0, target: null, ...extra };
    placeGhost();
    try { navigator.vibrate?.(15); } catch { /* ei värinää */ }
    drag.raf = requestAnimationFrame(tick);
  }

  function placeGhost() {
    drag.ghost.style.transform = `translate3d(${drag.x - drag.offX}px, ${drag.y - drag.offY}px, 0) scale(1.05)`;
  }

  function move(x, y) {
    drag.x = x;
    drag.y = y;
    placeGhost();
    reposition();
  }

  // Automaattinen vieritys reunojen lähellä.
  function tick() {
    if (!drag) return;
    const h = window.innerHeight;
    let dy = 0;
    if (drag.y < EDGE) dy = -MAX_SCROLL * Math.min(1, (EDGE - drag.y) / EDGE);
    else if (drag.y > h - EDGE) dy = MAX_SCROLL * Math.min(1, (drag.y - (h - EDGE)) / EDGE);
    if (dy) {
      const before = window.scrollY;
      window.scrollBy(0, dy);
      if (window.scrollY !== before) reposition();
    }
    drag.raf = requestAnimationFrame(tick);
  }

  // Siirtää paikanpitäjän sen kortin kohdalle, jonka päällä sormi on. Paikat lasketaan
  // asettelun mukaan (offsetLeft/Top), joten liikkeessä olevat kortit eivät hämää.
  function setTarget(el) {
    if (drag.target === el) return;
    drag.target?.classList.remove('drop-target');
    drag.target = el;
    el?.classList.add('drop-target');
  }

  function reposition() {
    // Pudotuskohteen (kansion) päällä korttien järjestys ei muutu.
    const hit = onDropInto && document.elementFromPoint(drag.x, drag.y)?.closest('[data-drop]');
    setTarget(hit || null);
    if (hit) return;

    const g = grid.getBoundingClientRect();
    const x = drag.x - g.left;
    const y = drag.y - g.top;
    const list = cards();
    let over = list.find((c) => x >= c.offsetLeft && x < c.offsetLeft + c.offsetWidth
      && y >= c.offsetTop && y < c.offsetTop + c.offsetHeight);
    if (!over) {
      // Viimeisen kortin jälkeen (sen oikealla puolella tai alapuolella) → loppuun.
      const last = list[list.length - 1];
      if (last && (y > last.offsetTop + last.offsetHeight
        || (y >= last.offsetTop && x > last.offsetLeft + last.offsetWidth))) over = last;
    }
    if (!over || over === drag.card) return;
    const from = list.indexOf(drag.card);
    const to = list.indexOf(over);
    flip(() => {
      if (from < to) over.after(drag.card);
      else over.before(drag.card);
    });
  }

  // Muut kortit liukuvat uusille paikoilleen (FLIP-animaatio).
  function flip(mutate) {
    const list = cards();
    const first = new Map(list.map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of list) {
      if (c === drag.card) continue;
      const a = first.get(c);
      const b = c.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      c.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 180, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }

  function end({ cancel = false } = {}) {
    if (!drag) return;
    const { card, ghost, before, target } = drag;
    cancelAnimationFrame(drag.raf);
    target?.classList.remove('drop-target');
    drag = null;
    document.documentElement.classList.remove('reordering');

    if (target && !cancel) {
      // Pudotettiin kohteen päälle: kortti "katoaa" kohteeseen.
      const t = target.getBoundingClientRect();
      const done = () => { ghost.remove(); card.classList.remove('drag-placeholder'); };
      const anim = ghost.animate?.(
        [{ transform: ghost.style.transform, opacity: 1 },
          { transform: `translate3d(${t.left + t.width / 2 - 20}px, ${t.top + t.height / 2 - 20}px, 0) scale(.15)`, opacity: 0 }],
        { duration: 200, easing: 'ease-in', fill: 'forwards' },
      );
      if (anim) anim.onfinish = anim.oncancel = done; else done();
      onDropInto(target.dataset.drop, card.dataset.id);
      return;
    }

    if (cancel) {
      const byId = new Map(cards().map((c) => [c.dataset.id, c]));
      grid.append(...before.map((id) => byId.get(id)).filter(Boolean));
    }

    // Kortti "laskeutuu" paikalleen.
    const r = card.getBoundingClientRect();
    const finish = () => { ghost.remove(); card.classList.remove('drag-placeholder'); };
    const anim = ghost.animate?.(
      [{ transform: ghost.style.transform }, { transform: `translate3d(${r.left}px, ${r.top}px, 0) scale(1)` }],
      { duration: 160, easing: 'ease-out', fill: 'forwards' },
    );
    if (anim) anim.onfinish = anim.oncancel = finish;
    else finish();

    const after = ids();
    if (!cancel && after.some((id, i) => id !== before[i])) onDrop(after);
  }

  // ---------- Kosketus ----------

  grid.addEventListener('touchstart', (e) => {
    if (drag) return;
    if (e.touches.length > 1) { cancelPending(); return; }
    const card = cardOf(e.target);
    if (!card) return;
    const t = e.changedTouches[0];
    pending = { card, x: t.clientX, y: t.clientY, touchId: t.identifier };
    pending.timer = setTimeout(() => {
      const p = pending;
      if (p) start(p.card, p.x, p.y, { touchId: p.touchId });
    }, HOLD_MS);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (pending && pending.touchId != null) {
      const t = touchById(e.changedTouches, pending.touchId);
      if (t && Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > TOUCH_SLOP) cancelPending();
      return;
    }
    if (drag && drag.touchId != null) {
      const t = touchById(e.touches, drag.touchId);
      if (!t) return;
      if (e.cancelable) e.preventDefault();   // ei vieritetä sivua raahauksen aikana
      move(t.clientX, t.clientY);
    }
  }, { passive: false });

  const touchEnd = (e) => {
    if (pending && touchById(e.changedTouches, pending.touchId)) cancelPending();
    if (drag && drag.touchId != null && touchById(e.changedTouches, drag.touchId)) {
      if (e.cancelable) e.preventDefault();   // pitkä painallus ei avaa nuottia
      end({ cancel: e.type === 'touchcancel' });
    }
  };
  window.addEventListener('touchend', touchEnd, { passive: false });
  window.addEventListener('touchcancel', touchEnd, { passive: false });

  // ---------- Hiiri ja kynä ----------

  grid.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || drag) return;
    const card = cardOf(e.target);
    if (card) pending = { card, x: e.clientX, y: e.clientY, mouse: e.pointerId };
  });

  window.addEventListener('pointermove', (e) => {
    if (pending && pending.mouse === e.pointerId) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOUSE_SLOP) {
        start(pending.card, pending.x, pending.y, { mouse: e.pointerId });
        move(e.clientX, e.clientY);
      }
    } else if (drag && drag.mouse === e.pointerId) {
      move(e.clientX, e.clientY);
    }
  });

  const pointerEnd = (e) => {
    if (pending && pending.mouse === e.pointerId) cancelPending();
    if (drag && drag.mouse === e.pointerId) {
      end({ cancel: e.type === 'pointercancel' });
      swallowClick = true;                       // raahauksen päättävä klikkaus ei avaa nuottia
      setTimeout(() => { swallowClick = false; }, 0);
    }
  };
  window.addEventListener('pointerup', pointerEnd);
  window.addEventListener('pointercancel', pointerEnd);

  window.addEventListener('click', (e) => {
    if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') end({ cancel: true });
  });
  document.addEventListener('visibilitychange', () => {
    cancelPending();
    if (document.hidden) end({ cancel: true });
  });

  // Pitkä painallus ei avaa valikkoa eikä selaimen omaa kuvan raahausta.
  grid.addEventListener('contextmenu', (e) => { if (cardOf(e.target)) e.preventDefault(); });
  grid.addEventListener('dragstart', (e) => e.preventDefault());

  return {
    cancel() { cancelPending(); end({ cancel: true }); },
    get active() { return !!drag; },
  };
}
