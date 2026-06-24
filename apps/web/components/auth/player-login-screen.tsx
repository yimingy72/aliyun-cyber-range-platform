import type { FormEvent } from 'react';
import Link from 'next/link';

type PlayerLoginScreenProps = {
  adminHref?: string;
};

export function PlayerLoginScreen({ adminHref = '/admin/login' }: PlayerLoginScreenProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  return (
    <main className="auth-route auth-route-player">
      <section className="auth-hero">
        <p className="auth-eyebrow">综合靶场竞赛入口</p>
        <h1>选手登录</h1>
        <p className="auth-description">
          面向参赛队伍的统一登录入口。第一阶段先提供正式登录页与后台区分入口，后续再扩展选手中心、比赛大厅和队伍空间。
        </p>
      </section>

      <section className="auth-card">
        <div className="auth-card-header">
          <h2>进入比赛空间</h2>
          <p>请输入比赛分发的账号信息。</p>
        </div>

        <form aria-label="选手登录表单" className="auth-form" method="post" onSubmit={handleSubmit}>
          <label>
            <span>账号</span>
            <input name="account" type="text" placeholder="请输入账号" />
          </label>

          <label>
            <span>密码</span>
            <input name="password" type="password" placeholder="请输入密码" />
          </label>

          <button type="submit">登录选手入口</button>
        </form>

        <p className="auth-helper">
          如果你是平台管理员，请前往
          <Link href={adminHref}>管理员入口</Link>
          。
        </p>
      </section>
    </main>
  );
}
