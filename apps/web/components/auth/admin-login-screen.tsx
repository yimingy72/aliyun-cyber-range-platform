'use client';

import { ArrowRight, LogIn, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../ui/button';
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
      <div className="admin-login-layout">
        <aside aria-hidden="true" className="admin-login-context">
          <strong>CYBER RANGE / ADMIN</strong>
          <p>统一身份验证完成后，继续进入综合靶场管理工作台。</p>
        </aside>

        <section aria-labelledby="admin-login-title" className="admin-login-card">
          <div aria-label="管理员登录表单" className="admin-login-form">
            <div className="admin-login-copy">
              <span className="admin-login-eyebrow">管理入口</span>
              <h1 className="admin-login-title" id="admin-login-title">
                <img
                  alt=""
                  aria-hidden="true"
                  data-testid="admin-login-title-mark"
                  height="31"
                  src="/brand/platform-mark.svg"
                  width="31"
                />
                登录综合靶场平台
              </h1>
              <p>使用平台统一账号验证身份并进入管理后台。</p>
            </div>

            {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

            <Button
              className="admin-login-command"
              disabled={isSubmitting}
              onClick={() => void handleLogin()}
              size="lg"
              type="button"
            >
              <span>
                <LogIn aria-hidden="true" data-icon="inline-start" />
                {isSubmitting ? '正在跳转...' : '使用平台账号登录'}
              </span>
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>

            <p className="admin-login-security">
              <ShieldCheck aria-hidden="true" />
              登录由平台统一身份认证服务保护
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
