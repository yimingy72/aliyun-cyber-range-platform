'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  createAdminUser,
  fetchAdminUsers,
  resetAdminUserPassword,
  updateAdminUserRole,
  updateAdminUserStatus,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { AdminUser, CreateAdminUserInput } from '../../lib/admin-types';
import { useAdminSession } from './use-admin-session';

type UsersScreenProps = {
  apiBaseUrl?: string;
};

type ResetPasswordState = {
  userId: string;
  username: string;
  password: string;
} | null;

const EMPTY_CREATE_USER_DRAFT: CreateAdminUserInput = {
  username: '',
  password: '',
  role: 'user',
};

function UsersDialog({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="template-workbench-dialog-backdrop" role="presentation">
      <section className="template-workbench-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="template-workbench-dialog-header">
          <div>
            <h2>{title}</h2>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

function getUserRoleLabel(role: AdminUser['role']) {
  return role === 'admin' ? '管理员' : '普通用户';
}

function getUserStatusLabel(status: AdminUser['status']) {
  return status === 'disabled' ? '已禁用' : '已启用';
}

function getUserStatusTone(status: AdminUser['status']) {
  return status === 'disabled' ? 'warning' : 'success';
}

function readActionErrorMessage(error: unknown, fallbackMessage: string) {
  if (!(error instanceof Error) || !error.message) {
    return fallbackMessage;
  }

  if (error.message === 'Cannot disable the last active admin') {
    return '至少需要保留一个可用的管理员账号，无法禁用最后一个管理员。';
  }

  if (error.message === 'Cannot demote the last active admin') {
    return '至少需要保留一个可用的管理员账号，无法将最后一个管理员降级为普通用户。';
  }

  return error.message;
}

function replaceUser(users: AdminUser[], updatedUser: AdminUser) {
  return users.map((user) => (user.id === updatedUser.id ? updatedUser : user));
}

export function UsersScreen({
  apiBaseUrl = 'http://localhost:3001',
}: UsersScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateAdminUserInput>(EMPTY_CREATE_USER_DRAFT);
  const [resetPasswordState, setResetPasswordState] = useState<ResetPasswordState>(null);

  useEffect(() => {
    if (!session.isReady) {
      return;
    }

    if (!session.token || !session.isAdmin) {
      setUsers([]);
      setErrorMessage(null);
      setActionErrorMessage(null);
      setActionSuccessMessage(null);
      setIsLoading(false);
      return;
    }

    let isActive = true;

    setUsers([]);
    setErrorMessage(null);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    setIsLoading(true);

    fetchAdminUsers(apiBaseUrl, session.token)
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setUsers(payload);
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          session.logout();
          router.replace('/admin/login');
          return;
        }

        setErrorMessage('用户列表加载失败，请稍后重试。');
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, session.isAdmin, session.isReady, session.token]);

  const counts = useMemo(() => {
    let adminCount = 0;
    let disabledCount = 0;

    for (const user of users) {
      if (user.role === 'admin') {
        adminCount += 1;
      }

      if (user.status === 'disabled') {
        disabledCount += 1;
      }
    }

    return {
      adminCount,
      disabledCount,
    };
  }, [users]);

  const closeCreateDialog = () => {
    setIsCreateDialogOpen(false);
    setCreateDraft(EMPTY_CREATE_USER_DRAFT);
  };

  const closeResetPasswordDialog = () => {
    setResetPasswordState(null);
  };

  const currentUserId = session.profile?.id ?? null;

  const handleSessionInvalidationForCurrentUser = (message: string) => {
    setActionSuccessMessage(message);
    session.logout();
    router.replace('/admin/login');
  };

  const handleScreenClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!menuUserId) {
      return;
    }

    if ((event.target as HTMLElement).closest('.users-workbench-row-menu')) {
      return;
    }

    setMenuUserId(null);
  };

  const handleCreateUser = async () => {
    if (!session.token) {
      return;
    }

    const payload: CreateAdminUserInput = {
      username: createDraft.username.trim(),
      password: createDraft.password,
      role: createDraft.role,
    };

    if (!payload.username || !payload.password.trim()) {
      setActionErrorMessage('请填写用户名和初始密码。');
      setActionSuccessMessage(null);
      return;
    }

    setIsSubmitting(true);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const createdUser = await createAdminUser(apiBaseUrl, session.token, payload);
      setUsers((currentUsers) => [createdUser, ...currentUsers]);
      closeCreateDialog();
      setActionSuccessMessage(`用户 ${createdUser.username} 已创建。`);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setActionErrorMessage(readActionErrorMessage(error, '创建用户失败，请稍后重试。'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateUserRole = async (user: AdminUser, role: AdminUser['role']) => {
    if (!session.token) {
      return;
    }

    setIsSubmitting(true);
    setMenuUserId(null);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const updatedUser = await updateAdminUserRole(apiBaseUrl, session.token, user.id, { role });
      setUsers((currentUsers) => replaceUser(currentUsers, updatedUser));

      if (updatedUser.id === currentUserId && updatedUser.role !== 'admin') {
        handleSessionInvalidationForCurrentUser(`已更新 ${updatedUser.username} 的角色，请重新登录。`);
        return;
      }

      setActionSuccessMessage(`已更新 ${updatedUser.username} 的角色。`);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setActionErrorMessage(readActionErrorMessage(error, '用户角色更新失败，请稍后重试。'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateUserStatus = async (user: AdminUser, status: AdminUser['status']) => {
    if (!session.token) {
      return;
    }

    setIsSubmitting(true);
    setMenuUserId(null);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const updatedUser = await updateAdminUserStatus(apiBaseUrl, session.token, user.id, { status });
      setUsers((currentUsers) => replaceUser(currentUsers, updatedUser));

      if (updatedUser.id === currentUserId && updatedUser.status === 'disabled') {
        handleSessionInvalidationForCurrentUser(`已更新 ${updatedUser.username} 的状态，请重新登录。`);
        return;
      }

      setActionSuccessMessage(`已更新 ${updatedUser.username} 的状态。`);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setActionErrorMessage(readActionErrorMessage(error, '用户状态更新失败，请稍后重试。'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetPassword = async () => {
    if (!session.token || !resetPasswordState) {
      return;
    }

    const password = resetPasswordState.password;

    if (!password.trim()) {
      setActionErrorMessage('请填写新密码。');
      setActionSuccessMessage(null);
      return;
    }

    setIsSubmitting(true);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const updatedUser = await resetAdminUserPassword(apiBaseUrl, session.token, resetPasswordState.userId, { password });
      setUsers((currentUsers) => replaceUser(currentUsers, updatedUser));
      closeResetPasswordDialog();

      if (updatedUser.id === currentUserId) {
        handleSessionInvalidationForCurrentUser(`已重置 ${resetPasswordState.username} 的密码，请重新登录。`);
        return;
      }

      setActionSuccessMessage(`已重置 ${resetPasswordState.username} 的密码。`);
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        session.logout();
        router.replace('/admin/login');
        return;
      }

      setActionErrorMessage(readActionErrorMessage(error, '密码重置失败，请稍后重试。'));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!session.isReady) {
    return null;
  }

  if (!session.token) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在跳转到管理员登录页...</h2>
          <p className="admin-empty">检测到当前没有有效的管理员会话。</p>
        </section>
      </main>
    );
  }

  if (!session.isAdmin) {
    return (
      <div className="admin-screen admin-workbench-screen">
        <article className="admin-workbench-panel users-workbench-panel">
          <div className="admin-workbench-panel-header users-workbench-header">
            <div className="users-workbench-header-copy">
              <h2>用户管理</h2>
              <p>创建后台账号，并管理角色、启用状态和密码重置。</p>
            </div>
          </div>

          <div className="admin-workbench-empty">
            <strong>只有管理员可以访问用户管理页。</strong>
            <p>请使用管理员账号登录后再执行创建、角色调整或密码重置。</p>
          </div>
        </article>
      </div>
    );
  }

  const isBootstrapLoading = isLoading && users.length === 0;

  return (
    <div className="admin-screen admin-workbench-screen" onClickCapture={handleScreenClickCapture}>
      <h1 className="sr-only">用户管理</h1>
      {errorMessage ? <p className="admin-error">{errorMessage}</p> : null}
      {actionErrorMessage ? <p className="admin-error">{actionErrorMessage}</p> : null}
      {actionSuccessMessage ? <p className="admin-success">{actionSuccessMessage}</p> : null}

      <section>
        <article className="admin-workbench-panel users-workbench-panel">
          <div className="admin-workbench-panel-header users-workbench-header">
            <div className="users-workbench-header-copy">
              <h2>用户管理</h2>
              <p>创建后台账号，并管理角色、启用状态和密码重置。</p>
            </div>
          </div>

          <div className="template-workbench-controls users-workbench-controls">
            <div className="template-workbench-list-meta" aria-label="用户统计">
              <span>总用户 {users.length}</span>
              <span>管理员 {counts.adminCount}</span>
              <span>已禁用 {counts.disabledCount}</span>
            </div>

            <button
              type="button"
              className="template-workbench-create-button"
              disabled={isSubmitting}
              onClick={() => setIsCreateDialogOpen(true)}
            >
              创建用户
            </button>
          </div>

          <div className="users-workbench-column-head">
            <div className="template-workbench-column-cell">
              <strong>用户名</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>角色</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>状态</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>创建时间</strong>
            </div>
            <div className="template-workbench-column-cell">
              <strong>更新时间</strong>
            </div>
            <div className="template-workbench-column-cell workbench-action-cell">
              <strong>操作</strong>
            </div>
          </div>

          {isBootstrapLoading ? (
            <div className="admin-workbench-empty" aria-hidden="true" />
          ) : users.length ? (
            <div className="users-workbench-rows">
              {users.map((user) => {
                const menuOpen = menuUserId === user.id;

                return (
                  <article key={user.id} className={`users-workbench-row${menuOpen ? ' is-menu-open' : ''}`}>
                    <div className="users-workbench-main">
                      <strong>{user.username}</strong>
                    </div>

                    <div className="users-workbench-role">
                      <span className="admin-pill admin-pill-neutral">{getUserRoleLabel(user.role)}</span>
                    </div>

                    <div className="users-workbench-status">
                      <span className={`admin-pill admin-pill-${getUserStatusTone(user.status)}`}>{getUserStatusLabel(user.status)}</span>
                    </div>

                    <div className="users-workbench-time">
                      <span>{formatAdminDateTime(user.createdAt)}</span>
                    </div>

                    <div className="users-workbench-time">
                      <span>{formatAdminDateTime(user.updatedAt)}</span>
                    </div>

                    <div className="users-workbench-actions workbench-action-cell">
                      <div className="template-workbench-row-menu users-workbench-row-menu">
                        <button
                          type="button"
                          className="template-workbench-secondary-action"
                          aria-expanded={menuOpen}
                          disabled={isSubmitting}
                          onClick={() => setMenuUserId((currentValue) => (currentValue === user.id ? null : user.id))}
                        >
                          更多操作
                        </button>

                        {menuOpen ? (
                          <div className="template-workbench-action-menu">
                            <button
                              type="button"
                              onClick={() => void handleUpdateUserRole(user, user.role === 'admin' ? 'user' : 'admin')}
                            >
                              {user.role === 'admin' ? '设为普通用户' : '设为管理员'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleUpdateUserStatus(user, user.status === 'active' ? 'disabled' : 'active')}
                            >
                              {user.status === 'active' ? '禁用用户' : '启用用户'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setMenuUserId(null);
                                setResetPasswordState({
                                  userId: user.id,
                                  username: user.username,
                                  password: '',
                                });
                              }}
                            >
                              重置密码
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="admin-workbench-empty">
              <strong>当前还没有后台用户。</strong>
              <p>你可以先创建一个普通用户或新的管理员账号。</p>
            </div>
          )}
        </article>
      </section>

      {isCreateDialogOpen ? (
        <UsersDialog title="创建用户">
          <div className="template-workbench-dialog-grid">
            <label>
              <span>用户名</span>
              <input
                aria-label="用户名"
                value={createDraft.username}
                onChange={(event) => setCreateDraft((currentValue) => ({ ...currentValue, username: event.target.value }))}
              />
            </label>
            <label>
              <span>初始密码</span>
              <input
                aria-label="初始密码"
                type="password"
                value={createDraft.password}
                onChange={(event) => setCreateDraft((currentValue) => ({ ...currentValue, password: event.target.value }))}
              />
            </label>
            <label>
              <span>角色</span>
              <select
                aria-label="角色"
                value={createDraft.role}
                onChange={(event) =>
                  setCreateDraft((currentValue) => ({
                    ...currentValue,
                    role: event.target.value as AdminUser['role'],
                  }))
                }
              >
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </label>
          </div>

          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleCreateUser()}>
              确认创建
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeCreateDialog}>
              取消
            </button>
          </div>
        </UsersDialog>
      ) : null}

      {resetPasswordState ? (
        <UsersDialog title="重置密码">
          <p className="template-workbench-confirm-copy">将为“{resetPasswordState.username}”设置新的登录密码。</p>

          <div className="template-workbench-dialog-grid">
            <label>
              <span>新密码</span>
              <input
                aria-label="新密码"
                type="password"
                value={resetPasswordState.password}
                onChange={(event) =>
                  setResetPasswordState((currentValue) =>
                    currentValue
                      ? {
                          ...currentValue,
                          password: event.target.value,
                        }
                      : currentValue,
                  )
                }
              />
            </label>
          </div>

          <div className="template-workbench-dialog-actions">
            <button type="button" disabled={isSubmitting} onClick={() => void handleResetPassword()}>
              确认重置
            </button>
            <button type="button" disabled={isSubmitting} onClick={closeResetPasswordDialog}>
              取消
            </button>
          </div>
        </UsersDialog>
      ) : null}
    </div>
  );
}
