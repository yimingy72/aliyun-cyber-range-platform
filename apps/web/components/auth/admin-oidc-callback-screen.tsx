'use client';

import { AdminNotice } from '../admin/shared/admin-notice';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  consumePendingAdminOidcLogin,
  exchangeAdminOidcCode,
  parseAdminOidcSessionPayload,
} from '../../lib/admin-oidc';
import { writeAdminSession } from '../../lib/admin-auth-storage';
import { Button } from '../ui/button';
import { fetchAuthenticatedAdminProfile } from '../../lib/admin-api';
import { resolveAdminApiBaseUrl } from '../../lib/admin-api-base-url';

type AdminOidcCallbackScreenProps = {
  oidcIssuer: string;
  oidcClientId: string;
};

export function AdminOidcCallbackScreen({ oidcIssuer, oidcClientId }: AdminOidcCallbackScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function finishLogin() {
      const code = searchParams.get('code')?.trim();
      const state = searchParams.get('state')?.trim();

      if (!code || !state) {
        if (isMounted) {
          setErrorMessage('管理员登录失败，请稍后重试。');
        }
        return;
      }

      const pendingLogin = consumePendingAdminOidcLogin(state);

      if (!pendingLogin) {
        if (isMounted) {
          setErrorMessage('管理员登录失败，请稍后重试。');
        }
        return;
      }

      const tokenResponse = await exchangeAdminOidcCode({
        issuer: oidcIssuer,
        clientId: oidcClientId,
        redirectUri: `${window.location.origin}/admin/callback`,
        code,
        codeVerifier: pendingLogin.codeVerifier,
      });
      if (!isMounted) return;
      const session = tokenResponse ? parseAdminOidcSessionPayload(tokenResponse) : null;
      if (session && process.env.NEXT_PUBLIC_PLATFORM_AUTH_MODE === 'keycloak') {
        session.profile = await fetchAuthenticatedAdminProfile(resolveAdminApiBaseUrl(), session.token);
      }
      if (!isMounted) return;

      if (!session || !writeAdminSession(session)) {
        if (isMounted) {
          setErrorMessage('管理员登录失败，请稍后重试。');
        }
        return;
      }

      router.replace('/admin/scenarios');
    }

    void finishLogin().catch(() => {
      if (isMounted) setErrorMessage('管理员登录失败，请稍后重试。');
    });

    return () => {
      isMounted = false;
    };
  }, [oidcClientId, oidcIssuer, router, searchParams]);

  if (!errorMessage) {
    return null;
  }

  return (
    <main className="admin-login-shell">
      <div className="admin-login-layout">
        <section aria-labelledby="admin-login-title" className="admin-login-card">
          <header className="admin-login-copy">
            <h1 className="admin-login-title" id="admin-login-title">综合靶场平台</h1>
          </header>
          <div className="admin-login-form">
            <AdminNotice tone="error">{errorMessage}</AdminNotice>
            <Button asChild className="admin-login-command" size="lg">
              <Link href="/admin/login">重新登录</Link>
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
