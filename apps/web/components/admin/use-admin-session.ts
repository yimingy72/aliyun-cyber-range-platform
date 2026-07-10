'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { AdminSessionPayload } from '../../lib/admin-types';
import {
  clearAdminSession,
  readAdminSession,
  subscribeAdminSession,
  writeAdminSession,
} from '../../lib/admin-auth-storage';

export function useAdminSession() {
  const session = useSyncExternalStore(subscribeAdminSession, readAdminSession, () => null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setIsReady(true);
  }, []);

  return {
    token: session?.token ?? null,
    profile: session?.profile ?? null,
    isAdmin: session?.profile?.role === 'admin',
    isReady,
    login(nextSession: AdminSessionPayload) {
      return writeAdminSession(nextSession);
    },
    logout() {
      clearAdminSession();
    },
  };
}
