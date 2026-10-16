import { accountStorageKey } from './account-storage.ts';

const KEY = 'nandou-studio:hidden-failed-tasks:v1';

export function readHiddenFailures(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(accountStorageKey(KEY)) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)).slice(-300) : [];
  } catch { return []; }
}

export function storeHiddenFailures(storage: Pick<Storage, 'setItem'>, ids: string[]) {
  try { storage.setItem(accountStorageKey(KEY), JSON.stringify([...new Set(ids)].slice(-300))); } catch { /* The current page can still hide a record when storage is unavailable. */ }
}
