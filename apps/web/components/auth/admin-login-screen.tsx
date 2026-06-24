'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { writeAdminToken } from '../../lib/admin-auth-storage';

type AdminLoginScreenProps = {
  apiBaseUrl?: string;
};

export function AdminLoginScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: AdminLoginScreenProps) {
  const router = useRouter();
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

      const payload = (await response.json()) as { token: string };

      writeAdminToken(payload.token);
      router.replace('/admin');
    } catch {
      setErrorMessage('管理员登录失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-route auth-route-admin">
      <section className="auth-hero">
        <p className="auth-eyebrow">靶场编排与运维控制台</p>
        <h1>管理员登录</h1>
        <p className="auth-description">
          进入后台后，你将看到靶场总览、靶场实例、编排任务和基础配置，重点关注实例状态、公网入口和失败排障。
        </p>
      </section>

      <section className="auth-card">
        <div className="auth-card-header">
          <h2>登录管理后台</h2>
          <p>请使用平台管理员账号登录。</p>
        </div>

        <form className="auth-form" method="post" onSubmit={handleSubmit}>
          <label>
            <span>管理员账号</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>

          <label>
            <span>登录密码</span>
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

        <p className="auth-helper">
          如果你是参赛队伍，请返回
          <Link href="/login">选手入口</Link>
          。
        </p>
      </section>
    </main>
  );
}
