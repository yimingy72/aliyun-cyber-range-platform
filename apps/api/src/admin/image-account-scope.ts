const UNSCOPED_ACCOUNT_SCOPE_KEY = '__unscoped__';

export function toAccountScopeKey(accountUid: string | null) {
  const normalizedAccountUid = accountUid?.trim();

  return normalizedAccountUid ? normalizedAccountUid : UNSCOPED_ACCOUNT_SCOPE_KEY;
}
