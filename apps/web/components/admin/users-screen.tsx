'use client';

import type { MouseEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableCell, TableRow } from '@/components/ui/table';

import {
  createAdminUser,
  fetchAdminUsers,
  resetAdminUserPassword,
  updateAdminUserRole,
  updateAdminUserStatus,
} from '../../lib/admin-api';
import { formatAdminDateTime, isUnauthorizedAdminError } from '../../lib/admin-screen';
import type { AdminUser, CreateAdminUserInput } from '../../lib/admin-types';
import {
  AdminPaginationControls,
  buildVisiblePages,
  getPagination,
  PAGE_SIZE_AUTO,
  useAdminPageSize,
} from './admin-pagination';
import { AdminPageHeader } from './shared/admin-page-header';
import {
  AdminDataTable,
  AdminDataTableCell,
  AdminDataTableState,
  type AdminDataColumn,
} from './shared/admin-data-table';
import { AdminListToolbar } from './shared/admin-list-toolbar';
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
type ActionMenuPlacement = 'down' | 'up';

const EMPTY_CREATE_USER_DRAFT: CreateAdminUserInput = {
  username: '',
  password: '',
  role: 'user',
};
const USER_COLUMNS: readonly AdminDataColumn[] = [
  { id: 'username', label: '用户名', priority: 'primary' },
  { id: 'role', label: '角色', priority: 'secondary' },
  { id: 'status', label: '状态', priority: 'primary' },
  { id: 'createdAt', label: '创建时间', priority: 'tertiary' },
  { id: 'updatedAt', label: '更新时间', priority: 'detail' },
  { id: 'actions', label: '操作', priority: 'primary', align: 'right' },
];
const ACTION_MENU_VERTICAL_OFFSET_PX = 8;
const ACTION_MENU_ESTIMATED_HEIGHT_PX = 88;

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

function resolveActionMenuPlacement(triggerElement: HTMLElement): ActionMenuPlacement {
  const triggerRect = triggerElement.getBoundingClientRect();
  const containerRect =
    triggerElement.closest('.admin-workbench-panel')?.getBoundingClientRect() ??
    triggerElement.closest('.admin-main-content')?.getBoundingClientRect();
  const availableBelow = (containerRect?.bottom ?? window.innerHeight) - triggerRect.bottom;

  return availableBelow < ACTION_MENU_ESTIMATED_HEIGHT_PX + ACTION_MENU_VERTICAL_OFFSET_PX ? 'up' : 'down';
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
  const [hasLoadedUsers, setHasLoadedUsers] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<ActionMenuPlacement>('down');
  const [createDraft, setCreateDraft] = useState<CreateAdminUserInput>(EMPTY_CREATE_USER_DRAFT);
  const [resetPasswordState, setResetPasswordState] = useState<ResetPasswordState>(null);
  const [page, setPage] = useState(1);
  const [jumpPageValue, setJumpPageValue] = useState('1');
  const [searchName, setSearchName] = useState('');
  const { pageSizeMode, pageSize, setPageSizeMode, setPageSize } = useAdminPageSize();

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
      setHasLoadedUsers(false);
      return;
    }

    let isActive = true;

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
        setHasLoadedUsers(true);
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
  }, [apiBaseUrl, loadAttempt, session.isAdmin, session.isReady, session.token]);

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
  const pagination = getPagination(filteredUsers.length, page, pageSize);
  const visiblePages = buildVisiblePages(pagination.totalPages, pagination.page);
  const pagedUsers = filteredUsers.slice(pagination.startIndex, pagination.endIndex);

  useEffect(() => {
    if (page !== pagination.page) {
      setPage(pagination.page);
    }
  }, [page, pagination.page]);

  useEffect(() => {
    setJumpPageValue(String(pagination.page));
  }, [pagination.page]);

  function handlePageSizeChange(nextValue: string) {
    if (nextValue === PAGE_SIZE_AUTO) {
      setPageSizeMode(PAGE_SIZE_AUTO);
      setPage(1);
      return;
    }

    setPageSizeMode(nextValue);
    setPageSize(Number(nextValue));
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
  };

  const closeResetPasswordDialog = () => {
    setResetPasswordState(null);
  };

  const retryUserLoad = () => {
    setErrorMessage(null);
    setIsLoading(true);
    setLoadAttempt((current) => current + 1);
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
    setMenuPlacement('down');
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
      <div className="admin-screen">
        <section className="rounded-md border border-border bg-card p-4 shadow-sm">
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
    <div className="admin-screen" onClickCapture={handleScreenClickCapture}>
      {actionErrorMessage ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {actionErrorMessage}
        </p>
      ) : null}
      {actionSuccessMessage ? (
        <p className="mb-3 text-sm text-emerald-700" aria-live="polite">
          {actionSuccessMessage}
        </p>
      ) : null}

      <section className="admin-workbench-panel users-workbench-panel rounded-md border border-border bg-card p-4 shadow-sm">
        <AdminPageHeader description="创建后台账号，并管理角色、启用状态和密码重置。" title="用户管理" />

        <div className="mt-4">
          <AdminListToolbar
            action={
              <>
                <div aria-label="用户统计" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>总用户 {users.length}</span>
                  <span>管理员 {counts.adminCount}</span>
                  <span>已禁用 {counts.disabledCount}</span>
                </div>
                <Button disabled={isSubmitting} onClick={() => setIsCreateDialogOpen(true)} type="button">
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
            <div className="mt-4 overflow-hidden rounded-md border border-border bg-background">
              <AdminDataTable columns={USER_COLUMNS} isRefreshing={isRefreshing} label="用户列表">
                {(columns) => {
                  const [usernameColumn, roleColumn, statusColumn, createdAtColumn, updatedAtColumn, actionsColumn] = columns;

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
                      <TableRow className="hover:bg-transparent" key="retained-user-list-error">
                        <TableCell className="px-3 py-3 text-sm whitespace-normal" colSpan={columns.length}>
                          <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
                            <span className="text-destructive">
                              {errorMessage} 正在显示上次成功加载的用户列表。
                            </span>
                            <Button onClick={retryUserLoad} size="sm" type="button" variant="outline">
                              重试加载
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
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
                    const menuOpen = menuUserId === user.id;

                    return (
                      <TableRow key={user.id}>
                        <AdminDataTableCell className="font-medium" column={usernameColumn!}>
                          {user.username}
                        </AdminDataTableCell>
                        <AdminDataTableCell column={roleColumn!}>{getUserRoleLabel(user.role)}</AdminDataTableCell>
                        <AdminDataTableCell column={statusColumn!}>
                          <StatusBadge status={user.status === 'active' ? 'enabled' : user.status} />
                        </AdminDataTableCell>
                        <AdminDataTableCell column={createdAtColumn!}>{formatAdminDateTime(user.createdAt)}</AdminDataTableCell>
                        <AdminDataTableCell column={updatedAtColumn!}>{formatAdminDateTime(user.updatedAt)}</AdminDataTableCell>
                        <AdminDataTableCell column={actionsColumn!}>
                          <div className="flex justify-end gap-1">
                            <Button
                              disabled={isSubmitting}
                              onClick={() =>
                                void handleUpdateUserStatus(user, user.status === 'active' ? 'disabled' : 'active')
                              }
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              {user.status === 'active' ? '禁用用户' : '启用用户'}
                            </Button>
                            <div className="template-workbench-row-menu users-workbench-row-menu relative">
                              <Button
                                aria-expanded={menuOpen}
                                aria-label="更多操作"
                                disabled={isSubmitting}
                                onClick={(event) => {
                                  if (menuUserId === user.id) {
                                    setMenuUserId(null);
                                    setMenuPlacement('down');
                                    return;
                                  }

                                  setMenuUserId(user.id);
                                  setMenuPlacement(resolveActionMenuPlacement(event.currentTarget));
                                }}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              >
                                <MoreHorizontal aria-hidden="true" />
                              </Button>

                              {menuOpen ? (
                                <div className={`template-workbench-action-menu${menuPlacement === 'up' ? ' is-upward' : ''}`}>
                                  <Button
                                    className="w-full justify-start"
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                    onClick={() => void handleUpdateUserRole(user, user.role === 'admin' ? 'user' : 'admin')}
                                  >
                                    {user.role === 'admin' ? '设为普通用户' : '设为管理员'}
                                  </Button>
                                  <Button
                                    className="w-full justify-start"
                                    size="sm"
                                    type="button"
                                    variant="ghost"
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
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </AdminDataTableCell>
                      </TableRow>
                    );
                  });

                  return retainedListErrorRow ? [retainedListErrorRow, ...userRows] : userRows;
                }}
              </AdminDataTable>
            </div>
            {hasVisibleUsers ? (
              <div className="mt-4">
                <AdminPaginationControls
                  jumpPageValue={jumpPageValue}
                  label="用户列表分页"
                  onJumpPage={handleJumpToPage}
                  onJumpPageValueChange={setJumpPageValue}
                  onNextPage={() => setPage(pagination.page + 1)}
                  onPageSelect={setPage}
                  onPageSizeChange={handlePageSizeChange}
                  onPreviousPage={() => setPage(pagination.page - 1)}
                  pageSizeMode={pageSizeMode}
                  pagination={pagination}
                  visiblePages={visiblePages}
                />
              </div>
            ) : null}
          </AdminListToolbar>
        </div>
      </section>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !isSubmitting) {
            closeCreateDialog();
          }
        }}
        open={isCreateDialogOpen}
      >
        <DialogContent closeButtonDisabled={isSubmitting}>
          <DialogHeader>
            <DialogTitle>创建用户</DialogTitle>
            <DialogDescription>创建新的后台账号，并分配初始角色。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="create-user-username">用户名</Label>
              <Input
                id="create-user-username"
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
              <Label htmlFor="create-user-role">角色</Label>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                id="create-user-role"
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
            </div>
          </div>
          <DialogFooter>
            <Button disabled={isSubmitting} onClick={() => void handleCreateUser()} type="button">
              确认创建
            </Button>
            <Button disabled={isSubmitting} onClick={closeCreateDialog} type="button" variant="outline">
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !isSubmitting) {
            closeResetPasswordDialog();
          }
        }}
        open={resetPasswordState !== null}
      >
        <DialogContent closeButtonDisabled={isSubmitting}>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>将为“{resetPasswordState?.username}”设置新的登录密码。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reset-user-password">新密码</Label>
            <Input
              id="reset-user-password"
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
          <DialogFooter>
            <Button disabled={isSubmitting} onClick={() => void handleResetPassword()} type="button">
              确认重置
            </Button>
            <Button disabled={isSubmitting} onClick={closeResetPasswordDialog} type="button" variant="outline">
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
