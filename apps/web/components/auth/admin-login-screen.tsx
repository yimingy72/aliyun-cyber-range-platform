'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { useAdminSession } from '../admin/use-admin-session';

type AdminLoginScreenProps = {
  apiBaseUrl?: string;
};

export function AdminLoginScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: AdminLoginScreenProps) {
  const router = useRouter();
  const { login } = useAdminSession();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`${apiBaseUrl}/admin/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        setErrorMessage('管理员登录失败，请检查账号或密码。');
        return;
      }

      const payload = (await response.json()) as { token?: unknown };
      const nextToken = typeof payload.token === 'string' ? payload.token : null;

      if (!nextToken?.trim()) {
        setErrorMessage('管理员登录失败，服务返回了无效会话。');
        return;
      }

      login(nextToken);
      router.replace('/admin/scenarios');
    } catch {
      setErrorMessage('管理员登录失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="admin-login-shell">
      <section className="admin-login-card">
        <div className="admin-login-card-copy">
          <strong>综合靶场平台</strong>
        </div>

        <form aria-label="管理员登录表单" className="admin-form admin-login-form" method="post" onSubmit={handleSubmit}>
          <label>
            <span>账号</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>

          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入管理员密码"
            />
          </label>

          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? '正在登录...' : '登录管理后台'}
          </button>
        </form>
      </section>
    </main>
  );
}
