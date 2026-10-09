'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableRow } from '@/components/ui/table';

import {
  createAdminUser,
  fetchAdminUsers,
  resetAdminUserPassword,
  updateAdminUserRole,
  updateAdminUserStatus,
} from '../../lib/admin-api';
import { useAdminScreenCache } from '../../lib/admin-screen-cache';
import { useCloudWorkspace } from './cloud-workspace-provider';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { AdminUser, CreateAdminUserInput } from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  useAdminPageSize,
} from './admin-pagination';
import { useAdminRouteIsActive } from './admin-page-cache';
import { AdminPageHeader } from './shared/admin-page-header';
import { AdminSelectField } from './shared/admin-select-field';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableRevalidationNotice,
  AdminDataTableState,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
import { AdminDialog } from './shared/admin-dialog';
import { AdminPaginatedList } from './shared/admin-paginated-list';
import { StatusBadge } from './shared/status-badge';
import { TableLoadingState } from './shared/table-loading-state';
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
const USER_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'username', label: '用户名', priority: 'primary' },
  { id: 'role', label: '角色', priority: 'secondary' },
  { id: 'createdAt', label: '创建时间', priority: 'tertiary' },
  { id: 'updatedAt', label: '更新时间', priority: 'detail' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'actions', label: '操作', priority: 'primary', width: '11rem' },
];

function getUserRoleLabel(role: AdminUser['role']) {
  return role === 'admin' ? '管理员' : '普通用户';
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
  const workspace = useCloudWorkspace()?.workspace;
  const isPageActive = useAdminRouteIsActive('/admin/users');
  const screenCache = useAdminScreenCache();
  const usersResource = 'users:list';
  const usersSource = `${apiBaseUrl}\u0000${session.token ?? ''}`;
  const cachedUsers = screenCache?.read<AdminUser[]>(apiBaseUrl, session.token, usersResource);
  const [users, setUsers] = useState<AdminUser[]>(() => cachedUsers?.data ?? []);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(() => !cachedUsers);
  const [hasLoadedUsers, setHasLoadedUsers] = useState(() => Boolean(cachedUsers));
  const [loadedUsersSource, setLoadedUsersSource] = useState<string | null>(() => (cachedUsers ? usersSource : null));
  const usersMutationRevision = useRef(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateAdminUserInput>(EMPTY_CREATE_USER_DRAFT);
  const [resetPasswordState, setResetPasswordState] = useState<ResetPasswordState>(null);
  const [page, setPage] = useState(1);
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const [searchName, setSearchName] = useState('');
  const createUserNameRef = useRef<HTMLInputElement>(null);
  const resetPasswordRef = useRef<HTMLInputElement>(null);
  const { pageSize, setPageSize } = useAdminPageSize();

  async function copyLoginUsername(user: AdminUser) {
    try {
      await navigator.clipboard.writeText(user.loginUsername ?? user.username);
      setActionSuccessMessage('登录账号已复制。');
    } catch {
      setActionErrorMessage('登录账号复制失败，请从列表选择文字复制。');
    }
  }

  useEffect(() => {
    if (!isPageActive || !session.isReady) {
      return;
    }

    if (!session.token || !session.isAdmin) {
      setUsers([]);
      setErrorMessage(null);
      setActionErrorMessage(null);
      setActionSuccessMessage(null);
      setIsLoading(false);
      setHasLoadedUsers(false);
      setLoadedUsersSource(null);
      return;
    }

    let isActive = true;
    const token = session.token;
    const cachedSnapshot = screenCache?.read<AdminUser[]>(apiBaseUrl, token, usersResource);

    if (cachedSnapshot?.isFresh && loadAttempt === 0) {
      setUsers(cachedSnapshot.data);
      setHasLoadedUsers(true);
      setLoadedUsersSource(usersSource);
      setErrorMessage(null);
      setIsLoading(false);

      return () => {
        isActive = false;
      };
    }

    if (loadedUsersSource === usersSource && !screenCache && loadAttempt === 0) {
      setIsLoading(false);

      return () => {
        isActive = false;
      };
    }

    setErrorMessage(null);
    setIsLoading(true);

    const readRevision = usersMutationRevision.current;
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, usersResource, () => fetchAdminUsers(apiBaseUrl, token), {
          force: loadAttempt > 0,
        })
      : fetchAdminUsers(apiBaseUrl, token);

    request
      .then((payload) => {
        if (!isActive || readRevision !== usersMutationRevision.current) {
          return;
        }

        setUsers(payload);
        setHasLoadedUsers(true);
        setLoadedUsersSource(usersSource);
        if (loadAttempt > 0) {
          setLoadAttempt(0);
        }
      })
      .catch((error: unknown) => {
        if (!isActive || readRevision !== usersMutationRevision.current) {
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
  }, [
    apiBaseUrl,
    isPageActive,
    loadAttempt,
    loadedUsersSource,
    screenCache,
    session.isAdmin,
    session.isReady,
    session.token,
    usersResource,
    usersSource,
  ]);

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
  const normalizedSearchName = searchName.trim().toLocaleLowerCase();
  const filteredUsers = useMemo(
    () =>
      normalizedSearchName
        ? users.filter((user) => user.username.toLocaleLowerCase().includes(normalizedSearchName))
        : users,
    [normalizedSearchName, users],
  );

  useEffect(() => {
    setPage(1);
  }, [normalizedSearchName]);

  const pagination = getPagination(filteredUsers.length, page, pageSize);
  const visiblePages = buildVisiblePages(pagination.totalPages, pagination.page);
  const pagedUsers = filteredUsers.slice(pagination.startIndex, pagination.endIndex);

  useEffect(() => {
    if (page !== pagination.page) {
      setPage(pagination.page);
    }
  }, [page, pagination.page]);

  useLayoutEffect(() => {
    setJumpPageValue(String(pagination.page));
  }, [pagination.page]);

  function handlePageSizeChange(nextValue: 20 | 50 | 100) {
    setPageSize(nextValue);
    setPage(1);
  }

  function handleJumpToPage() {
    const parsedPage = Number.parseInt(jumpPageValue, 10);

    if (Number.isNaN(parsedPage)) {
      setJumpPageValue(String(pagination.page));
      return;
    }

    setPage(parsedPage);
  }

  const closeCreateDialog = () => {
    setIsCreateDialogOpen(false);
    setCreateDraft(EMPTY_CREATE_USER_DRAFT);
    setActionErrorMessage(null);
  };

  const closeResetPasswordDialog = () => {
    setResetPasswordState(null);
    setActionErrorMessage(null);
  };

  const retryUserLoad = () => {
    setErrorMessage(null);
    setIsLoading(true);
    setLoadAttempt((current) => current + 1);
  };

  const handleSessionInvalidationForCurrentUser = (message: string) => {
    setActionSuccessMessage(message);
    session.logout();
    router.replace('/admin/login');
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
      usersMutationRevision.current += 1;
      screenCache?.invalidate(apiBaseUrl, session.token, 'users:');
      setUsers((currentUsers) => [createdUser, ...currentUsers]);
      setHasLoadedUsers(true);
      setLoadedUsersSource(usersSource);
      setErrorMessage(null);
      closeCreateDialog();
      setActionSuccessMessage(`用户 ${createdUser.username} 已创建。${createdUser.loginUsername && createdUser.loginUsername !== createdUser.username ? `登录账号：${createdUser.loginUsername}` : ''}`);
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
    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const updatedUser = await updateAdminUserRole(apiBaseUrl, session.token, user.id, { role });
      usersMutationRevision.current += 1;
      screenCache?.invalidate(apiBaseUrl, session.token, 'users:');
      setUsers((currentUsers) => replaceUser(currentUsers, updatedUser));

      if (updatedUser.isCurrentUser && updatedUser.role !== 'admin') {
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
    setActionErrorMessage(null);
    setActionSuccessMessage(null);

    try {
      const updatedUser = await updateAdminUserStatus(apiBaseUrl, session.token, user.id, { status });
      usersMutationRevision.current += 1;
      screenCache?.invalidate(apiBaseUrl, session.token, 'users:');
      setUsers((currentUsers) => replaceUser(currentUsers, updatedUser));

      if (updatedUser.isCurrentUser && updatedUser.status === 'disabled') {
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
      usersMutationRevision.current += 1;
      screenCache?.invalidate(apiBaseUrl, session.token, 'users:');
      setUsers((currentUsers) => replaceUser(currentUsers, updatedUser));
      closeResetPasswordDialog();

      if (updatedUser.isCurrentUser) {
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
      <div className="admin-screen">
        <section className="admin-workbench-surface">
          <AdminPageHeader description="创建后台账号，并管理角色、启用状态和密码重置。" title="用户管理" />
          <div className="py-16 text-center">
            <strong className="text-sm font-medium text-foreground">只有管理员可以访问用户管理页。</strong>
            <p className="mt-1 text-sm text-muted-foreground">请使用管理员账号登录后再执行创建、角色调整或密码重置。</p>
          </div>
        </section>
      </div>
    );
  }

  const isBootstrapLoading = isLoading && !hasLoadedUsers;
  const isRefreshing = isLoading && hasLoadedUsers;
  const hasVisibleUsers = filteredUsers.length > 0;

  return (
    <div className="admin-screen admin-pagination-screen">
      {actionErrorMessage && !isCreateDialogOpen && !resetPasswordState ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {actionErrorMessage}
        </p>
      ) : null}
      {actionSuccessMessage ? (
        <p className="mb-3 text-sm text-emerald-700" aria-live="polite">
          {actionSuccessMessage}
        </p>
      ) : null}

      <section className="admin-workbench-surface users-workbench-panel admin-pagination-surface">
        <AdminPageHeader description="创建后台账号，并管理角色、启用状态和密码重置。" title="用户管理" />

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <AdminListToolbar
            action={
              <>
                <div aria-label="用户统计" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>总用户 {users.length}</span>
                  <span>管理员 {counts.adminCount}</span>
                  <span>已禁用 {counts.disabledCount}</span>
                </div>
                <Button disabled={isSubmitting || workspace?.isReadOnly} onClick={() => { setActionErrorMessage(null); setIsCreateDialogOpen(true); }} type="button">
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  创建用户
                </Button>
              </>
            }
            onSearchChange={setSearchName}
            searchLabel="筛选用户名"
            searchPlaceholder="搜索用户名"
            searchValue={searchName}
          >
            <AdminPaginatedList
              className="mt-4"
              footer={
                hasVisibleUsers ? (
                  <AdminPaginationControls
                    jumpPageValue={jumpPageValue}
                    label="用户列表分页"
                    onJumpPage={handleJumpToPage}
                    onJumpPageValueChange={setJumpPageValue}
                    onNextPage={() => setPage(pagination.page + 1)}
                    onPageSelect={setPage}
                    onPageSizeChange={handlePageSizeChange}
                    onPreviousPage={() => setPage(pagination.page - 1)}
                    pageSize={pageSize}
                    pagination={pagination}
                    visiblePages={visiblePages}
                  />
                ) : null
              }
            >
              <AdminDataTable columns={USER_COLUMNS} isRefreshing={isRefreshing} label="用户列表">
                {(columns) => {
                  const [usernameColumn, roleColumn, createdAtColumn, updatedAtColumn, statusColumn, actionsColumn] = columns;

                  if (isBootstrapLoading) {
                    return <TableLoadingState columnCount={columns.length} label="正在加载用户列表" rowCount={5} />;
                  }

                  if (errorMessage && !hasLoadedUsers) {
                    return (
                      <AdminDataTableState
                        columns={columns}
                        description={errorMessage}
                        onRetry={retryUserLoad}
                        title="无法加载用户列表"
                        variant="error"
                      />
                    );
                  }

                  const retainedListErrorRow =
                    errorMessage && hasLoadedUsers ? (
                      <AdminDataTableRevalidationNotice
                        columns={columns}
                        description={errorMessage}
                        key="retained-user-list-error"
                        onRetry={retryUserLoad}
                      />
                    ) : null;

                  if (retainedListErrorRow && !hasVisibleUsers) {
                    return retainedListErrorRow;
                  }

                  if (!hasVisibleUsers) {
                    return (
                      <AdminDataTableState
                        columns={columns}
                        description={
                          normalizedSearchName
                            ? '没有找到匹配的后台用户。'
                            : '你可以先创建一个普通用户或新的管理员账号。'
                        }
                        title={normalizedSearchName ? '没有匹配的后台用户' : '当前还没有后台用户。'}
                        variant="empty"
                      />
                    );
                  }

                  const userRows = pagedUsers.map((user) => {
                    return (
                      <TableRow key={user.id}>
                        <AdminDataTableCell className="font-medium" column={usernameColumn!}>
                          <div className="grid min-w-0 gap-1"><span>{user.username}</span>{user.loginUsername && user.loginUsername !== user.username ? <span className="break-all text-xs font-normal text-muted-foreground">登录账号：{user.loginUsername}</span> : null}</div>
                        </AdminDataTableCell>
                        <AdminDataTableCell column={roleColumn!}>{getUserRoleLabel(user.role)}</AdminDataTableCell>
                        <AdminDataTableCell column={createdAtColumn!}>{formatAdminDateTime(user.createdAt)}</AdminDataTableCell>
                        <AdminDataTableCell column={updatedAtColumn!}>{formatAdminDateTime(user.updatedAt)}</AdminDataTableCell>
                        <AdminDataTableCell column={statusColumn!}>
                          <StatusBadge status={user.status === 'active' ? 'enabled' : user.status} />
                        </AdminDataTableCell>
                        <AdminDataTableCell column={actionsColumn!}>
                          <div className="flex justify-start gap-1">
                            <Button
                              disabled={isSubmitting || workspace?.isReadOnly}
                              onClick={() =>
                                void handleUpdateUserStatus(user, user.status === 'active' ? 'disabled' : 'active')
                              }
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              {user.status === 'active' ? '禁用用户' : '启用用户'}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  aria-label="更多操作"
                                  disabled={isSubmitting || workspace?.isReadOnly}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  <MoreHorizontal aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => void copyLoginUsername(user)}>复制登录账号</DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={isSubmitting || workspace?.isReadOnly}
                                  onSelect={() => void handleUpdateUserRole(user, user.role === 'admin' ? 'user' : 'admin')}
                                >
                                  {user.role === 'admin' ? '设为普通用户' : '设为管理员'}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={isSubmitting || workspace?.isReadOnly}
                                  onSelect={() =>
                                    setResetPasswordState({
                                      userId: user.id,
                                      username: user.username,
                                      password: '',
                                    })
                                  }
                                >
                                  重置密码
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </AdminDataTableCell>
                      </TableRow>
                    );
                  });

                  return retainedListErrorRow ? [retainedListErrorRow, ...userRows] : userRows;
                }}
              </AdminDataTable>
            </AdminPaginatedList>
          </AdminListToolbar>
        </div>
      </section>

      <AdminDialog
        footer={
          <>
            <Button disabled={isSubmitting} onClick={closeCreateDialog} type="button" variant="outline">
              取消
            </Button>
            <Button disabled={isSubmitting || workspace?.isReadOnly} onClick={() => void handleCreateUser()} type="button">
              确认创建
            </Button>
          </>
        }
        initialFocusRef={createUserNameRef}
        onOpenChange={(open) => {
          if (!open) {
            closeCreateDialog();
          }
        }}
        open={isCreateDialogOpen}
        pending={isSubmitting}
        title="创建用户"
      >
          {actionErrorMessage ? <p className="text-sm text-destructive" role="alert">{actionErrorMessage}</p> : null}
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="create-user-username">用户名</Label>
              <Input
                id="create-user-username"
                ref={createUserNameRef}
                value={createDraft.username}
                onChange={(event) => setCreateDraft((currentValue) => ({ ...currentValue, username: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="create-user-password">初始密码</Label>
              <Input
                id="create-user-password"
                type="password"
                value={createDraft.password}
                onChange={(event) => setCreateDraft((currentValue) => ({ ...currentValue, password: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>角色</Label>
              <AdminSelectField
                ariaLabel="角色"
                className="w-full"
                disabled={isSubmitting || workspace?.isReadOnly}
                onValueChange={(value) =>
                  setCreateDraft((currentValue) => ({
                    ...currentValue,
                    role: value as AdminUser['role'],
                  }))
                }
                options={[
                  { label: '普通用户', value: 'user' },
                  { label: '管理员', value: 'admin' },
                ]}
                value={createDraft.role}
              />
            </div>
          </div>
      </AdminDialog>

      <AdminDialog
        footer={
          <>
            <Button disabled={isSubmitting} onClick={closeResetPasswordDialog} type="button" variant="outline">
              取消
            </Button>
            <Button disabled={isSubmitting || workspace?.isReadOnly} onClick={() => void handleResetPassword()} type="button">
              确认重置
            </Button>
          </>
        }
        initialFocusRef={resetPasswordRef}
        onOpenChange={(open) => {
          if (!open) {
            closeResetPasswordDialog();
          }
        }}
        open={resetPasswordState !== null}
        pending={isSubmitting}
        title="重置密码"
      >
          {actionErrorMessage ? <p className="text-sm text-destructive" role="alert">{actionErrorMessage}</p> : null}
          <div className="grid gap-2">
            <Label htmlFor="reset-user-password">新密码</Label>
            <Input
              id="reset-user-password"
              ref={resetPasswordRef}
              type="password"
              value={resetPasswordState?.password ?? ''}
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
          </div>
      </AdminDialog>
    </div>
  );
}
