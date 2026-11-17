import * as db from './db.js';
import { Viewer, analyzePdf } from './viewer.js';
import { enableReorder } from './reorder.js';

const $ = (id) => document.getElementById(id);
const els = {
  grid: $('grid'), empty: $('empty'), noResults: $('no-results'), footer: $('lib-footer'),
  search: $('search'), sort: $('sort'), tagFilter: $('tag-filter'), fileInput: $('file-input'),
  dialog: $('edit-dialog'), form: $('edit-form'), editMeta: $('edit-meta'),
  drop: $('drop-overlay'), toast: $('toast'),
  folders: $('folders'), folderBar: $('folder-bar'), folderTitle: $('folder-title'), folderEmpty: $('folder-empty'),
  folderDialog: $('folder-dialog'), folderForm: $('folder-form'), folderDialogTitle: $('folder-dialog-title'),
};

const SORT_KEY = 'nuotit.sort';
// Android- ja iOS-sovelluksessa (Capacitor) sivu on paketin sisällä, ja takaisin-painike hoidetaan natiivisti.
const NATIVE = window.Capacitor?.isNativePlatform?.() ?? false;
const ROUTE = /^#\/nuotti\/(.+)$/;
const FOLDER_ROUTE = /^#\/kansio\/(.+)$/;
const collator = new Intl.Collator('fi', { numeric: true, sensitivity: 'base' });

let scores = [];
let folders = [];
let currentFolder = null;   // avoimen kansion id tai null (kaikki nuotit)
let activeTag = null;
let editing = null;
let editingFolder = null;
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
  [scores, folders] = await Promise.all([db.listScores(), db.listFolders()]);
  renderLibrary();
}

const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="currentColor"/></svg>';

function svgIcon(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
}

const countText = (n) => `${n} ${n === 1 ? 'nuotti' : 'nuottia'}`;
const sortedFolders = () => [...folders].sort((a, b) => collator.compare(a.name, b.name));
const folderHash = () => (currentFolder ? `#/kansio/${currentFolder}` : location.pathname + location.search);

function renderLibrary() {
  const tags = [...new Set(scores.flatMap((s) => s.tags || []))].sort(collator.compare);
  if (activeTag && !tags.includes(activeTag)) activeTag = null;
  els.tagFilter.hidden = tags.length === 0;
  els.tagFilter.replaceChildren(
    chip('Kaikki', activeTag === null, () => { activeTag = null; renderLibrary(); }),
    ...tags.map((t) => chip(t, activeTag === t, () => { activeTag = activeTag === t ? null : t; renderLibrary(); })),
  );

  const folder = currentFolder ? folders.find((f) => f.id === currentFolder) : null;
  if (!folder) currentFolder = null;
  const folderIds = new Set(folders.map((f) => f.id));
  const inFolder = (s) => !!s.folder && folderIds.has(s.folder);

  // Haku ja tunniste etsivät kaikista nuoteista (myös kansioista), kun mikään kansio ei ole auki.
  const q = els.search.value.trim().toLocaleLowerCase('fi');
  const filtering = !!(q || activeTag);
  const list = scores.filter((s) => {
    if (folder ? s.folder !== folder.id : !filtering && inFolder(s)) return false;
    if (activeTag && !(s.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    return [s.title, s.composer, ...(s.tags || [])].join(' ').toLocaleLowerCase('fi').includes(q);
  });

  sortScores(list, els.sort.value);

  reorder?.cancel();
  els.grid.replaceChildren(...list.map(card));

  // Kansiot näytetään kirjaston alussa (ei kansion sisällä eikä haettaessa).
  const showFolders = !folder && !filtering && folders.length > 0;
  els.folders.hidden = !showFolders;
  els.folders.replaceChildren(...(showFolders
    ? sortedFolders().map((f) => folderCard(f, scores.filter((s) => s.folder === f.id).length))
    : []));
  els.folderBar.hidden = !folder;
  els.folderTitle.textContent = folder?.name || '';
  document.title = folder ? `${folder.name} – Nuotit` : 'Nuotit';

  els.empty.hidden = scores.length > 0 || !!folder;
  els.folderEmpty.hidden = !(folder && !filtering && list.length === 0);
  els.noResults.hidden = !(filtering && scores.length > 0 && list.length === 0);

  const total = scores.reduce((sum, s) => sum + (s.size || 0), 0);
  els.footer.replaceChildren(...(scores.length ? [
    `${scores.length} ${scores.length === 1 ? 'nuotti' : 'nuottia'} · ${formatSize(total)} · tallennettu tälle laitteelle`,
    scores.length > 1 ? el('div', { class: 'lib-hint' }, 'Järjestä nuotteja painamalla korttia hetken ja raahaamalla.') : null,
  ] : []).filter(Boolean));
}

const hasOrder = (s) => Number.isFinite(s.order);

function sortScores(list, sort) {
  return list.sort((a, b) => {
    if (sort === 'manual') {
      // Nuotit, joita ei ole vielä järjestetty, ovat lopussa nimen mukaan.
      if (hasOrder(a) && hasOrder(b)) return a.order - b.order;
      if (hasOrder(a) !== hasOrder(b)) return hasOrder(a) ? -1 : 1;
      return collator.compare(a.title, b.title);
    }
    if (sort === 'recent') return (b.lastOpened || 0) - (a.lastOpened || 0) || collator.compare(a.title, b.title);
    if (sort === 'added') return (b.addedAt || 0) - (a.addedAt || 0);
    return collator.compare(a.title, b.title);
  });
}

/**
 * Tallentaa raahauksen jälkeisen järjestyksen. `visibleIds` ovat näkyvät kortit uudessa
 * järjestyksessä; haun tai tunnisteen piilottamat nuotit pysyvät omilla paikoillaan.
 * Jos järjestyksenä oli jokin muu, se vaihtuu omaksi järjestykseksi.
 */
async function applyOrder(visibleIds) {
  const full = sortScores([...scores], els.sort.value);
  const visible = new Set(visibleIds);
  const byId = new Map(scores.map((s) => [s.id, s]));
  let k = 0;
  const result = full.map((s) => (visible.has(s.id) ? byId.get(visibleIds[k++]) : s));
  const changed = [];
  result.forEach((s, i) => { if (s.order !== i) { s.order = i; changed.push(s); } });

  if (els.sort.value !== 'manual') {
    els.sort.value = 'manual';
    prefs.set(SORT_KEY, 'manual');
    toast('Järjestykseksi vaihdettiin Oma järjestys');
  }
  renderLibrary();
  try {
    await db.updateScores(changed);
  } catch (err) {
    console.error(err);
    toast('Järjestyksen tallennus epäonnistui');
  }
}

const reorder = enableReorder(els.grid, { onDrop: applyOrder, onDropInto: (target, id) => moveToFolder(id, target) });

function chip(label, pressed, onclick) {
  return el('button', { class: 'chip', type: 'button', 'aria-pressed': String(pressed), onclick }, label);
}

function card(s) {
  const sub = [s.composer, `${s.pageCount} s.`].filter(Boolean).join(' · ');
  return el('article', { class: 'card', 'data-id': s.id },
    el('button', { class: 'card-open', type: 'button', onclick: () => openScore(s.id), 'aria-label': `Avaa ${s.title}` },
      el('div', { class: 'thumb' }, s.thumb ? el('img', { src: s.thumb, alt: '', loading: 'lazy', draggable: 'false' }) : null),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title' }, s.title),
        el('div', { class: 'card-sub' }, sub),
        s.tags?.length ? el('div', { class: 'card-tags' }, ...s.tags.map((t) => el('span', {}, t))) : null,
      ),
    ),
    el('button', { class: 'card-menu', type: 'button', title: 'Muokkaa', 'aria-label': `Muokkaa: ${s.title}`, onclick: () => openEditor(s) }, '⋯'),
  );
}

// ---------- Kansiot ----------

function folderCard(f, count) {
  return el('button', { class: 'folder-card', type: 'button', 'data-drop': f.id, onclick: () => enterFolder(f.id), 'aria-label': `Avaa kansio ${f.name}` },
    svgIcon(FOLDER_ICON),
    el('div', {},
      el('div', { class: 'folder-name' }, f.name),
      el('div', { class: 'folder-count' }, countText(count)),
    ),
  );
}

function enterFolder(id) {
  history.pushState({ folder: id }, '', `#/kansio/${id}`);
  currentFolder = id;
  activeTag = null;
  els.search.value = '';
  renderLibrary();
  window.scrollTo(0, 0);
}

function leaveFolder() {
  if (history.state?.folder && FOLDER_ROUTE.test(location.hash)) {
    history.back();   // popstate näyttää kaikki nuotit
  } else {
    currentFolder = null;
    history.replaceState(null, '', folderHash());
    renderLibrary();
  }
}

/** Siirtää nuotin kansioon (tai 'root' → pois kansiosta). */
async function moveToFolder(scoreId, target) {
  const s = scores.find((x) => x.id === scoreId);
  if (!s) return;
  const to = target === 'root' ? null : folders.find((f) => f.id === target);
  if ((s.folder || null) === (to?.id || null)) return;
  if (to) s.folder = to.id; else delete s.folder;
  renderLibrary();
  try {
    await db.updateScore(s);
    toast(to ? `"${s.title}" siirretty kansioon ${to.name}` : `"${s.title}" siirretty pois kansiosta`);
  } catch (err) {
    console.error(err);
    toast('Siirto epäonnistui');
  }
}

function openFolderDialog(f = null) {
  editingFolder = f;
  els.folderDialogTitle.textContent = f ? 'Muokkaa kansiota' : 'Uusi kansio';
  els.folderForm.elements.name.value = f?.name || '';
  $('folder-delete').hidden = !f;
  els.folderDialog.showModal();
}

function closeFolderDialog() {
  els.folderDialog.close();
  editingFolder = null;
}

els.folderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.folderForm.elements.name.value.trim();
  if (!name) return;
  const isNew = !editingFolder;
  const f = editingFolder ? { ...editingFolder, name } : { id: uid(), name, createdAt: Date.now() };
  try {
    await db.putFolder(f);
  } catch (err) {
    console.error(err);
    toast('Kansion tallennus epäonnistui');
    return;
  }
  folders = [...folders.filter((x) => x.id !== f.id), f];
  closeFolderDialog();
  renderLibrary();
  if (isNew) toast(`Kansio "${name}" luotu. Siirrä nuotteja raahaamalla ne kansion päälle.`, 4000);
});

$('folder-cancel').addEventListener('click', closeFolderDialog);

$('folder-delete').addEventListener('click', async () => {
  const f = editingFolder;
  if (!f) return;
  const inside = scores.filter((s) => s.folder === f.id);
  const msg = inside.length
    ? `Poistetaanko kansio "${f.name}"? ${inside.length === 1
      ? 'Sen nuotti siirtyy kansioiden ulkopuolelle, eikä sitä poisteta.'
      : `Sen ${inside.length} nuottia siirtyvät kansioiden ulkopuolelle, eikä niitä poisteta.`}`
    : `Poistetaanko kansio "${f.name}"?`;
  if (!confirm(msg)) return;
  await db.deleteFolder(f.id, inside);
  folders = folders.filter((x) => x.id !== f.id);
  closeFolderDialog();
  if (currentFolder === f.id) leaveFolder(); else renderLibrary();
  toast(`Kansio "${f.name}" poistettu`);
});

$('new-folder-btn').addEventListener('click', () => openFolderDialog());
$('folder-edit').addEventListener('click', () => {
  const f = folders.find((x) => x.id === currentFolder);
  if (f) openFolderDialog(f);
});
$('folder-back').addEventListener('click', leaveFolder);

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
        order: scores.reduce((max, s) => (hasOrder(s) ? Math.max(max, s.order + 1) : max), 0),
      };
      if (currentFolder) meta.folder = currentFolder;   // avoimeen kansioon lisätyt nuotit menevät siihen
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
  f.folder.replaceChildren(
    el('option', { value: '' }, 'Ei kansiota'),
    ...sortedFolders().map((x) => el('option', { value: x.id }, x.name)),
  );
  f.folder.value = folders.some((x) => x.id === s.folder) ? s.folder : '';
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
  if (f.folder.value) updated.folder = f.folder.value; else delete updated.folder;
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

// Merkinnät tallennetaan hetken kuluttua viimeisestä muutoksesta.
let notesTimer = null;
let notesPending = null;   // { id, pages }

function saveNotesSoon(pages) {
  if (!viewer.score) return;
  notesPending = { id: viewer.score.id, pages };
  clearTimeout(notesTimer);
  notesTimer = setTimeout(flushNotes, 600);
}

function flushNotes() {
  clearTimeout(notesTimer);
  const p = notesPending;
  notesPending = null;
  if (!p) return;
  return db.putNotes(p.id, p.pages).catch((err) => {
    console.error(err);
    toast('Merkintöjen tallennus epäonnistui');
  });
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
  onNotes: saveNotesSoon,
  onBack() {
    if (ROUTE.test(location.hash) && history.state?.score) {
      history.back();             // popstate sulkee katselimen
    } else {
      history.replaceState(null, '', folderHash());
      closeViewer();
    }
  },
});

async function openScore(id, { push = true } = {}) {
  const score = await db.getScore(id);
  const data = score && await db.getFile(id);
  const notes = score && await db.getNotes(id).catch(() => null);
  if (!score || !data) {
    toast('Nuottia ei löytynyt');
    if (!push) history.replaceState(null, '', folderHash());
    return;
  }
  if (push) history.pushState({ score: id }, '', `#/nuotti/${id}`);
  document.title = `${score.title} – Nuotit`;
  score.lastOpened = Date.now();
  db.updateScore(score).catch(console.error);
  try {
    await viewer.open(score, data, notes?.pages);
  } catch (err) {
    console.error(err);
    toast('PDF-tiedoston avaaminen epäonnistui');
    viewer.onBack();
  }
}

async function closeViewer() {
  const score = viewer.score;
  viewer.close({ silent: true });
  await Promise.all([flushProgress(score), flushNotes()]);
  if (updatePending) { location.reload(); return; }
  await refresh();
}

function folderFromHash() {
  currentFolder = location.hash.match(FOLDER_ROUTE)?.[1] ?? null;
}

window.addEventListener('popstate', () => {
  const m = location.hash.match(ROUTE);
  if (m) {
    if (!viewer.isOpen || viewer.score?.id !== m[1]) openScore(m[1], { push: false });
    return;
  }
  folderFromHash();
  if (viewer.isOpen) closeViewer();
  else renderLibrary();
});

// ---------- Käynnistys ----------

els.sort.value = prefs.get(SORT_KEY) || 'title';
els.sort.addEventListener('change', () => { prefs.set(SORT_KEY, els.sort.value); renderLibrary(); });
els.search.addEventListener('input', renderLibrary);

folderFromHash();
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
    else if (els.folderDialog.open) closeFolderDialog();
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

// Sovellus suljetaan tai siirtyy taustalle → tallennetaan merkinnät heti.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushNotes();
});
