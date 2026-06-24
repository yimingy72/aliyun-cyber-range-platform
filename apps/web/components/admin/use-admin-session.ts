'use client';

import { useEffect, useState } from 'react';

import { clearAdminToken, readAdminToken, writeAdminToken } from '../../lib/admin-auth-storage';

export function useAdminSession() {
  const [token, setToken] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setToken(readAdminToken());
    setIsReady(true);
  }, []);

  return {
    token,
    isReady,
    login(nextToken: string) {
      setToken(writeAdminToken(nextToken));
    },
    logout() {
      clearAdminToken();
      setToken(null);
    },
  };
}
