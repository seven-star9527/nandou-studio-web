let accountId: string | null = null;

/** Called before mounting (or unmounting) an authenticated workspace. */
export function setAccountStorageUser(userId: string | null) {
  accountId = userId;
}

export function accountStorageKey(key: string): string {
  return `nandou-studio:account:${encodeURIComponent(accountId ?? 'signed-out')}:${key}`;
}
