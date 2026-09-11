const DB_NAME = 'metin2-okey-solver';
const DB_VERSION = 2;
const GAMES_STORE = 'games';
const TELEMETRY_STORE = 'telemetry_queue';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GAMES_STORE)) {
        const store = db.createObjectStore(GAMES_STORE, { keyPath: 'id' });
        store.createIndex('startedAt', 'startedAt');
        store.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(TELEMETRY_STORE)) {
        const queue = db.createObjectStore(TELEMETRY_STORE, { keyPath: 'id' });
        queue.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(storeName, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
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
  return transaction(GAMES_STORE, 'readwrite', store => store.put(structuredClone(game)));
}

export async function getGames() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(GAMES_STORE, 'readonly');
      const request = tx.objectStore(GAMES_STORE).getAll();
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
  return transaction(GAMES_STORE, 'readwrite', store => store.delete(id));
}

export async function enqueueTelemetry(id, payload) {
  return transaction(TELEMETRY_STORE, 'readwrite', store => store.put({
    id,
    payload: structuredClone(payload),
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastAttemptAt: null,
  }));
}

export async function getTelemetryQueue() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TELEMETRY_STORE, 'readonly');
      const request = tx.objectStore(TELEMETRY_STORE).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function updateTelemetryQueueItem(item) {
  return transaction(TELEMETRY_STORE, 'readwrite', store => store.put(structuredClone(item)));
}

export async function deleteTelemetryQueueItem(id) {
  return transaction(TELEMETRY_STORE, 'readwrite', store => store.delete(id));
}
