'use client';

import { useState } from 'react';

import { buildAdminOidcAuthorizeUrl, writePendingAdminOidcLogin } from '../../lib/admin-oidc';

type AdminLoginScreenProps = {
  oidcIssuer: string;
  oidcClientId: string;
};

export function AdminLoginScreen({ oidcIssuer, oidcClientId }: AdminLoginScreenProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogin() {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const authorization = await buildAdminOidcAuthorizeUrl({
        issuer: oidcIssuer,
        clientId: oidcClientId,
        redirectUri: `${window.location.origin}/admin/callback`,
      });

      writePendingAdminOidcLogin({
        state: authorization.state,
        codeVerifier: authorization.codeVerifier,
      });
      window.location.assign(authorization.url);
    } catch {
      setErrorMessage('管理员登录失败，请稍后重试。');
      setIsSubmitting(false);
    }
  }

  return (
    <main className="admin-login-shell">
      <section className="admin-login-card">
        <div className="admin-login-card-copy">
          <strong>综合靶场平台</strong>
        </div>

        <div aria-label="管理员登录表单" className="admin-form admin-login-form">
          <p>使用平台统一账号登录管理后台。</p>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          <button type="button" disabled={isSubmitting} onClick={() => void handleLogin()}>
            {isSubmitting ? '正在跳转...' : '使用平台账号登录'}
          </button>
        </div>
      </section>
    </main>
  );
}
