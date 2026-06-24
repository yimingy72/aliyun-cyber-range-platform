'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { clearAdminToken, readAdminToken, subscribeAdminToken, writeAdminToken } from '../../lib/admin-auth-storage';

export function useAdminSession() {
  const token = useSyncExternalStore(subscribeAdminToken, readAdminToken, () => null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setIsReady(true);
  }, []);

  return {
    token,
    isReady,
    login(nextToken: string) {
      return writeAdminToken(nextToken);
    },
    logout() {
      clearAdminToken();
    },
  };
}
