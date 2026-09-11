const DB_NAME = 'metin2-okey-solver';
const DB_VERSION = 1;
const STORE = 'games';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('startedAt', 'startedAt');
        store.createIndex('status', 'status');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveGame(game) {
  return transaction('readwrite', store => store.put(structuredClone(game)));
}

export async function getGames() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function getLatestActiveGame() {
  const games = await getGames();
  return games.find(game => game.status === 'active') || null;
}

export async function importGames(games) {
  if (!Array.isArray(games)) throw new Error('JSON must contain an array of games.');
  for (const game of games) {
    if (!game?.id || !game?.startedAt) continue;
    await saveGame(game);
  }
}

export async function deleteGame(id) {
  return transaction('readwrite', store => store.delete(id));
}
