// IndexedDB-tallennus. Nuottien tiedot (scores) ja PDF-sisältö (files) ovat
// erillisissä varastoissa, jotta kirjaston listaus pysyy nopeana.

const DB_NAME = 'nuotit';
const DB_VERSION = 2;   // 2: merkinnät (notes)
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('scores')) db.createObjectStore('scores', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Uudempi versio (toinen välilehti) päivittää tietokantaa → suljetaan tämä yhteys.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const asPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const completed = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error || new Error('Tallennus epäonnistui'));
});

export async function listScores() {
  const db = await openDb();
  return asPromise(db.transaction('scores').objectStore('scores').getAll());
}

export async function getScore(id) {
  const db = await openDb();
  return asPromise(db.transaction('scores').objectStore('scores').get(id));
}

/** Palauttaa PDF:n ArrayBufferina. */
export async function getFile(id) {
  const db = await openDb();
  const rec = await asPromise(db.transaction('files').objectStore('files').get(id));
  return rec ? rec.data : null;
}

export async function addScore(meta, data) {
  const db = await openDb();
  const tx = db.transaction(['scores', 'files'], 'readwrite');
  tx.objectStore('scores').put(meta);
  tx.objectStore('files').put({ id: meta.id, data });
  return completed(tx);
}

export async function updateScore(meta) {
  const db = await openDb();
  const tx = db.transaction('scores', 'readwrite');
  tx.objectStore('scores').put(meta);
  return completed(tx);
}

export async function deleteScore(id) {
  const db = await openDb();
  const tx = db.transaction(['scores', 'files', 'notes'], 'readwrite');
  tx.objectStore('scores').delete(id);
  tx.objectStore('files').delete(id);
  tx.objectStore('notes').delete(id);
  return completed(tx);
}

/** Tallentaa usean nuotin tiedot yhdellä kertaa (esim. uusi järjestys). */
export async function updateScores(list) {
  if (!list.length) return;
  const db = await openDb();
  const tx = db.transaction('scores', 'readwrite');
  const store = tx.objectStore('scores');
  for (const meta of list) store.put(meta);
  return completed(tx);
}

/** Nuotin merkinnät: { id, pages: { sivunumero: [viivat] } } tai undefined. */
export async function getNotes(id) {
  const db = await openDb();
  return asPromise(db.transaction('notes').objectStore('notes').get(id));
}

export async function putNotes(id, pages) {
  const db = await openDb();
  const tx = db.transaction('notes', 'readwrite');
  if (Object.keys(pages).length) tx.objectStore('notes').put({ id, pages });
  else tx.objectStore('notes').delete(id);
  return completed(tx);
}
