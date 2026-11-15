import * as db from './db.js';
import { Viewer, analyzePdf } from './viewer.js';

const $ = (id) => document.getElementById(id);
const els = {
  grid: $('grid'), empty: $('empty'), noResults: $('no-results'), footer: $('lib-footer'),
  search: $('search'), sort: $('sort'), tagFilter: $('tag-filter'), fileInput: $('file-input'),
  dialog: $('edit-dialog'), form: $('edit-form'), editMeta: $('edit-meta'),
  drop: $('drop-overlay'), toast: $('toast'),
};

const SORT_KEY = 'nuotit.sort';
// Android- ja iOS-sovelluksessa (Capacitor) sivu on paketin sisällä, ja takaisin-painike hoidetaan natiivisti.
const NATIVE = window.Capacitor?.isNativePlatform?.() ?? false;
const ROUTE = /^#\/nuotti\/(.+)$/;
const collator = new Intl.Collator('fi', { numeric: true, sensitivity: 'base' });

let scores = [];
let activeTag = null;
let editing = null;
let saveTimer = null;
let updatePending = false;   // uusi versio odottaa, kunnes nuotti suljetaan

const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ei tallennusta */ } },
};

// ---------- Apufunktiot ----------

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function titleFromFile(name) {
  return name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Nimetön';
}

function parseTags(text) {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))];
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kt`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mt`;
}

let toastTimer;
function toast(text, ms = 2600) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// ---------- Kirjasto ----------

async function refresh() {
  scores = await db.listScores();
  renderLibrary();
}

function renderLibrary() {
  const tags = [...new Set(scores.flatMap((s) => s.tags || []))].sort(collator.compare);
  if (activeTag && !tags.includes(activeTag)) activeTag = null;
  els.tagFilter.hidden = tags.length === 0;
  els.tagFilter.replaceChildren(
    chip('Kaikki', activeTag === null, () => { activeTag = null; renderLibrary(); }),
    ...tags.map((t) => chip(t, activeTag === t, () => { activeTag = activeTag === t ? null : t; renderLibrary(); })),
  );

  const q = els.search.value.trim().toLocaleLowerCase('fi');
  const list = scores.filter((s) => {
    if (activeTag && !(s.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    return [s.title, s.composer, ...(s.tags || [])].join(' ').toLocaleLowerCase('fi').includes(q);
  });

  const sort = els.sort.value;
  list.sort((a, b) => {
    if (sort === 'recent') return (b.lastOpened || 0) - (a.lastOpened || 0) || collator.compare(a.title, b.title);
    if (sort === 'added') return (b.addedAt || 0) - (a.addedAt || 0);
    return collator.compare(a.title, b.title);
  });

  els.grid.replaceChildren(...list.map(card));
  els.empty.hidden = scores.length > 0;
  els.noResults.hidden = !(scores.length > 0 && list.length === 0);

  const total = scores.reduce((sum, s) => sum + (s.size || 0), 0);
  els.footer.textContent = scores.length
    ? `${scores.length} ${scores.length === 1 ? 'nuotti' : 'nuottia'} · ${formatSize(total)} · tallennettu tälle laitteelle`
    : '';
}

function chip(label, pressed, onclick) {
  return el('button', { class: 'chip', type: 'button', 'aria-pressed': String(pressed), onclick }, label);
}

function card(s) {
  const sub = [s.composer, `${s.pageCount} s.`].filter(Boolean).join(' · ');
  return el('article', { class: 'card' },
    el('button', { class: 'card-open', type: 'button', onclick: () => openScore(s.id), 'aria-label': `Avaa ${s.title}` },
      el('div', { class: 'thumb' }, s.thumb ? el('img', { src: s.thumb, alt: '', loading: 'lazy' }) : null),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title' }, s.title),
        el('div', { class: 'card-sub' }, sub),
        s.tags?.length ? el('div', { class: 'card-tags' }, ...s.tags.map((t) => el('span', {}, t))) : null,
      ),
    ),
    el('button', { class: 'card-menu', type: 'button', title: 'Muokkaa', 'aria-label': `Muokkaa: ${s.title}`, onclick: () => openEditor(s) }, '⋯'),
  );
}

// ---------- PDF-tiedostojen tuonti ----------

async function importFiles(fileList) {
  const all = [...fileList];
  const files = all.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) { toast('Valitse PDF-tiedostoja'); return; }

  let added = 0;
  let duplicates = 0;
  const failed = [];
  for (const [i, f] of files.entries()) {
    if (scores.some((s) => s.fileName === f.name && s.size === f.size)) { duplicates++; continue; }
    toast(`Tallennetaan ${i + 1}/${files.length}: ${f.name}`, 0);
    try {
      const data = await f.arrayBuffer();
      const { pageCount, thumb } = await analyzePdf(data.slice(0));
      const meta = {
        id: uid(),
        title: titleFromFile(f.name),
        composer: '',
        tags: activeTag ? [activeTag] : [],
        fileName: f.name,
        size: f.size,
        pageCount,
        thumb,
        addedAt: Date.now(),
        lastOpened: 0,
        lastPage: 1,
      };
      await db.addScore(meta, data);
      scores.push(meta);
      added++;
    } catch (err) {
      console.error(err);
      failed.push(f.name);
    }
  }
  await refresh();

  const parts = [];
  if (added) parts.push(`${added} ${added === 1 ? 'nuotti lisätty' : 'nuottia lisätty'}`);
  if (duplicates) parts.push(`${duplicates} oli jo kirjastossa`);
  if (failed.length) parts.push(`epäonnistui: ${failed.join(', ')}`);
  toast(parts.join(' · ') || 'Ei lisättävää', failed.length ? 6000 : 3000);

  // Pyydetään selainta säilyttämään tallennetut nuotit pysyvästi.
  if (added) navigator.storage?.persist?.().catch(() => {});
}

els.fileInput.addEventListener('change', () => {
  const files = els.fileInput.files;
  if (files?.length) importFiles(files).finally(() => { els.fileInput.value = ''; });
});

// Raahaa ja pudota (tietokoneella)
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || viewer.isOpen) return;
  dragDepth++;
  els.drop.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.drop.hidden = true;
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  if (!viewer.isOpen) importFiles(e.dataTransfer.files);
});

// ---------- Muokkaus ----------

function openEditor(s) {
  editing = s;
  const f = els.form.elements;
  f.title.value = s.title;
  f.composer.value = s.composer || '';
  f.tags.value = (s.tags || []).join(', ');
  const added = new Date(s.addedAt).toLocaleDateString('fi-FI');
  els.editMeta.textContent = `${s.fileName} · ${s.pageCount} sivua · ${formatSize(s.size)} · lisätty ${added}`;
  els.dialog.showModal();
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editing) return;
  const f = els.form.elements;
  const updated = {
    ...editing,
    title: f.title.value.trim() || editing.title,
    composer: f.composer.value.trim(),
    tags: parseTags(f.tags.value),
  };
  await db.updateScore(updated);
  els.dialog.close();
  editing = null;
  await refresh();
});

$('edit-cancel').addEventListener('click', () => { els.dialog.close(); editing = null; });

$('edit-delete').addEventListener('click', async () => {
  if (!editing) return;
  if (!confirm(`Poistetaanko nuotti "${editing.title}" tältä laitteelta?`)) return;
  await db.deleteScore(editing.id);
  els.dialog.close();
  toast(`"${editing.title}" poistettu`);
  editing = null;
  await refresh();
});

// ---------- Katselin ja reititys ----------

function saveProgressSoon() {
  clearTimeout(saveTimer);
  const score = viewer.score;
  if (!score) return;
  saveTimer = setTimeout(() => db.updateScore(score).catch(console.error), 400);
}

function flushProgress(score) {
  clearTimeout(saveTimer);
  if (score) return db.updateScore(score).catch(console.error);
}

const viewer = new Viewer({
  onPage(n) {
    if (!viewer.score) return;
    viewer.score.lastPage = n;
    saveProgressSoon();
  },
  onZoom(z) {
    if (!viewer.score) return;
    viewer.score.zoom = Math.round(z * 100) / 100;
    saveProgressSoon();
  },
  onBack() {
    if (ROUTE.test(location.hash) && history.state?.score) {
      history.back();             // popstate sulkee katselimen
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      closeViewer();
    }
  },
});

async function openScore(id, { push = true } = {}) {
  const score = await db.getScore(id);
  const data = score && await db.getFile(id);
  if (!score || !data) {
    toast('Nuottia ei löytynyt');
    if (!push) history.replaceState(null, '', location.pathname + location.search);
    return;
  }
  if (push) history.pushState({ score: id }, '', `#/nuotti/${id}`);
  document.title = `${score.title} – Nuotit`;
  score.lastOpened = Date.now();
  db.updateScore(score).catch(console.error);
  try {
    await viewer.open(score, data);
  } catch (err) {
    console.error(err);
    toast('PDF-tiedoston avaaminen epäonnistui');
    viewer.onBack();
  }
}

async function closeViewer() {
  const score = viewer.score;
  viewer.close({ silent: true });
  document.title = 'Nuotit';
  await flushProgress(score);
  if (updatePending) { location.reload(); return; }
  await refresh();
}

window.addEventListener('popstate', () => {
  const m = location.hash.match(ROUTE);
  if (m) {
    if (!viewer.isOpen || viewer.score?.id !== m[1]) openScore(m[1], { push: false });
  } else if (viewer.isOpen) {
    closeViewer();
  }
});

// ---------- Käynnistys ----------

els.sort.value = prefs.get(SORT_KEY) || 'title';
els.sort.addEventListener('change', () => { prefs.set(SORT_KEY, els.sort.value); renderLibrary(); });
els.search.addEventListener('input', renderLibrary);

refresh().then(() => {
  const m = location.hash.match(ROUTE);
  if (m) openScore(m[1], { push: false });
}).catch((err) => {
  console.error(err);
  toast('Tallennustilaa ei voitu avata. Onko selaimen yksityinen tila käytössä?', 8000);
});

// Asennettu sovellus (Chrome/Edge): PDF:n voi avata "Avaa sovelluksella → Nuotit".
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    await importFiles(await Promise.all(files.map((h) => h.getFile())));
  });
}

// Android-sovelluksessa (Capacitor) tiedostot ovat paketin sisällä, joten service workeria ei tarvita.
// Takaisin-painike sulkee ensin muokkausikkunan tai nuotin, ja kirjastossa se sulkee sovelluksen.
if (NATIVE) {
  const { App } = window.Capacitor.Plugins;
  App?.addListener('backButton', ({ canGoBack }) => {
    if (els.dialog.open) { els.dialog.close(); editing = null; }
    else if (viewer.isOpen) viewer.onBack();
    else if (canGoBack) history.back();
    else App.exitApp();
  });
}

if (!NATIVE && 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  // Kun uusi versio otetaan käyttöön, ladataan sovellus uudelleen heti kirjastossa
  // (tai kun nuotti suljetaan), jotta päivitys ei vaadi kahta avauskertaa.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;   // ensiasennus, ei päivitys
    if (!viewer.isOpen) { location.reload(); return; }
    updatePending = true;
  });
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker:', err));
}
