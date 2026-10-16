import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

// Images belong in IndexedDB, not the small synchronous localStorage quota.
const pending = new Map<string, unknown>();
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nandou-private-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function readDraft<T>(key: string): Promise<T | undefined> {
  if (pending.has(key)) return pending.get(key) as T;
  const store = (await db()).transaction('drafts').objectStore('drafts');
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const request = store.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return pending.has(key) ? pending.get(key) as T : value;
}
async function writeDraft(key: string, value: unknown) {
  pending.set(key, value);
  const database = await db();
  // Use the latest value if several keystrokes queued before the database opened.
  const current = pending.get(key);
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(current, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  if (pending.get(key) === current) pending.delete(key);
}

export function useDraft<T extends object>(key: string, initial: T) {
  const fallback = useRef(initial);
  const [snapshot, setSnapshot] = useState<{key: string; value: T; ready: boolean}>({ key, value: initial, ready: false });
  const [error, setError] = useState('');
  const current = useRef(snapshot); current.current = snapshot;
  const activeKey = useRef(key); activeKey.current = key;
  const values = useRef(new Map<string, T>());
  useEffect(() => {
    let alive = true;
    void readDraft<T>(key).then(value => { if (alive) { const restored = {...fallback.current, ...value}; values.current.set(key, restored); setSnapshot({key, value: restored, ready: true}); } })
      .catch(() => { if (alive) { setError('浏览器草稿缓存不可用，关闭页面后可能丢失未发送内容。'); setSnapshot({key, value: fallback.current, ready: true}); } });
    return () => { alive = false; };
  }, [key]);
  const setValue = useCallback((action: SetStateAction<T>) => {
    const previous = values.current.get(key) ?? (current.current.key === key ? current.current.value : fallback.current);
    const value = typeof action === 'function' ? (action as (p:T)=>T)(previous) : action;
    values.current.set(key, value);
    const next = {key, value, ready: true}; if (activeKey.current === key) { current.current = next; setSnapshot(next); }
    void writeDraft(key, value).catch(() => setError('草稿暂未保存到浏览器，请勿关闭页面。'));
  }, [key]);
  return [snapshot.key === key ? snapshot.value : fallback.current, setValue, snapshot.key === key && snapshot.ready, error] as const;
}
