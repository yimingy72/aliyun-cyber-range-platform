export type RangeRecoveryTrigger = 'retry' | 'destroy';
export type RangeRecoveryIntent = { trigger: RangeRecoveryTrigger; key: string };
export type RangeRecoveryScope = { apiBaseUrl: string; userId: string; workspaceId: string; rangeId: string };

function storageKey(scope: RangeRecoveryScope) {
  return `range-recovery-intent:${JSON.stringify([scope.apiBaseUrl, scope.userId, scope.workspaceId, scope.rangeId])}`;
}

export function readRangeRecoveryIntent(scope: RangeRecoveryScope): RangeRecoveryIntent | null {
  if (typeof window === 'undefined' || !scope.userId) return null;
  try {
    const intent = JSON.parse(window.sessionStorage.getItem(storageKey(scope)) ?? 'null');
    return intent && (intent.trigger === 'retry' || intent.trigger === 'destroy') &&
      typeof intent.key === 'string' && intent.key.length > 0 && intent.key.length <= 128 ? intent : null;
  } catch { return null; }
}

export function beginRangeRecoveryIntent(scope: RangeRecoveryScope, trigger: RangeRecoveryTrigger): RangeRecoveryIntent {
  if (!scope.userId) throw new Error('登录身份尚未确认，请重新登录后操作。');
  const existing = readRangeRecoveryIntent(scope);
  if (existing) return existing;
  const intent = { trigger, key: crypto.randomUUID() };
  // Persist before the first write; reload must query the original receipt.
  window.sessionStorage.setItem(storageKey(scope), JSON.stringify(intent));
  return intent;
}

export function clearRangeRecoveryIntent(scope: RangeRecoveryScope, key: string) {
  if (readRangeRecoveryIntent(scope)?.key === key) window.sessionStorage.removeItem(storageKey(scope));
}
