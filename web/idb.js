// IndexedDB implementation of the Storage interface used by sync.js.
const DB_NAME = "interrupt-stack";

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openStorage() {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
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
      const [items, dirty, lastSeq, epoch] = await Promise.all([
        request(store("items").getAll()),
        getMeta("dirty", []),
        getMeta("lastSeq", 0),
        getMeta("epoch", null),
      ]);
      return { items, dirty, lastSeq, epoch };
    },
    putItem: (item) => request(store("items", "readwrite").put(item)),
    setDirty: (ids) => putMeta("dirty", ids),
    setLastSeq: (n) => putMeta("lastSeq", n),
    setEpoch: (e) => putMeta("epoch", e),
  };
}
