// IndexedDB implementation of the Storage interface used by sync.js and queue.js. The stack database also holds the
// shared sync cursor and epoch, under the key `cursor` (the key `lastSeq` of older versions was a per-table number).
const DB_NAME = "interrupt-stack";
// The queue lives in a database of its own, so what the stack's code opens never changes shape.
export const QUEUE_DB_NAME = "interrupt-stack-queue";

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openStorage(dbName = DB_NAME) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("items", { keyPath: "id" });
      open.result.createObjectStore("meta", { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  const store = (name, mode = "readonly") => db.transaction(name, mode).objectStore(name);
  const getMeta = async (key, fallback) => (await request(store("meta").get(key)))?.value ?? fallback;
  const putMeta = (key, value) => request(store("meta", "readwrite").put({ key, value }));

  return {
    async load() {
      const [items, dirty, cursor, epoch] = await Promise.all([
        request(store("items").getAll()),
        getMeta("dirty", []),
        getMeta("cursor", 0),
        getMeta("epoch", null),
      ]);
      return { items, dirty, cursor, epoch };
    },
    putItem: (item) => request(store("items", "readwrite").put(item)),
    setDirty: (ids) => putMeta("dirty", ids),
    setCursor: (n) => putMeta("cursor", n),
    setEpoch: (e) => putMeta("epoch", e),
  };
}
