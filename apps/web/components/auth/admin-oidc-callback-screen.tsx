'use client';

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
      <section className="admin-login-card">
        <div className="admin-login-card-copy">
          <strong>综合靶场平台</strong>
        </div>

        <div className="admin-form admin-login-form">
          <p className="form-error" role="alert">{errorMessage}</p>
          <Button asChild size="lg">
            <Link href="/admin/login">重新登录</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
