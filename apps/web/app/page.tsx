'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAdminSession } from '../components/admin/use-admin-session';

export default function HomePage() {
  const router = useRouter();
  const session = useAdminSession();

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    router.replace(session.token ? '/admin/scenarios' : '/admin/login');
  }, [router, session.isReady, session.token]);

  return null;
}
