'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { useAdminSession } from '../admin/use-admin-session';
import type { AdminSessionPayload } from '../../lib/admin-types';

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

      const payload = (await response.json()) as AdminSessionPayload;

      if (!login(payload)) {
        setErrorMessage('管理员登录失败，服务返回了无效会话。');
        return;
      }

      router.replace('/admin/scenarios');
    } catch {
      setErrorMessage('管理员登录失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="admin-workspace admin-login-workspace">
      <aside className="admin-sidebar admin-login-sidebar">
        <div className="admin-brand">
          <div className="admin-brand-copy">
            <strong>综合靶场平台</strong>
            <span>阿里云企业网络型靶场编排与实例管理工作台</span>
          </div>
        </div>

        <section className="admin-sidebar-section admin-sidebar-section-status" aria-label="登录环境状态">
          <div>
            <span className="admin-sidebar-label">访问入口</span>
            <strong>统一后台登录</strong>
          </div>
          <span className="admin-status-dot admin-status-dot-live">在线</span>
        </section>

        <section className="admin-sidebar-section admin-sidebar-section-tip admin-login-note" aria-label="登录页说明">
          <span className="admin-sidebar-label">当前阶段能力</span>
          <strong>靶场编排优先</strong>
          <p>登录成功后将进入当前可落地的主工作台，用于继续靶场编排、实例查看与云配置管理。</p>
        </section>
      </aside>

      <section className="admin-main-shell admin-login-main-shell">
        <header className="admin-topbar admin-login-topbar">
          <div className="admin-topbar-heading">
            <h1>管理员登录</h1>
            <span>使用统一后台账号进入靶场编排与实例管理工作台。</span>
          </div>

          <div className="admin-topbar-meta">
            <div className="admin-topbar-badge-group" aria-label="后台入口标签">
              <span className="admin-topbar-badge">工作台 / 靶场编排</span>
              <span className="admin-topbar-badge">角色 / 管理员</span>
            </div>
          </div>
        </header>

        <section className="admin-main-content admin-login-content">
          <section className="admin-panel admin-login-panel admin-login-form-panel">
            <div className="admin-section-header admin-login-header">
              <div>
                <span>统一后台入口</span>
                <h2>登录管理后台</h2>
              </div>
            </div>

            <p className="admin-description admin-login-description">请使用平台管理员账号登录，继续进入靶场编排主工作台。</p>

            <form aria-label="管理员登录表单" className="admin-form" method="post" onSubmit={handleSubmit}>
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
          </section>
        </section>
      </section>
    </main>
  );
}
