import { readAdminSession } from './admin-auth-storage';

const selections = new Map<string, string>();
const STORAGE_PREFIX = 'cloud-workspace-selection:';

export function readCloudWorkspaceSelection(userId?: string | null) {
  const id = userId ?? readAdminSession()?.profile.id;
  return id ? selections.get(id) ?? null : null;
}

export function readStoredCloudWorkspaceSelection(userId: string) {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(`${STORAGE_PREFIX}${userId}`)?.trim() || null;
}

export function setCloudWorkspaceSelection(userId: string, workspaceId: string | null) {
  if (workspaceId) selections.set(userId, workspaceId);
  else selections.delete(userId);
  if (typeof window === 'undefined') return;
  if (workspaceId) window.sessionStorage.setItem(`${STORAGE_PREFIX}${userId}`, workspaceId);
  else window.sessionStorage.removeItem(`${STORAGE_PREFIX}${userId}`);
}

export function workspaceStorageKey(key: string) {
  const session = readAdminSession();
  const workspaceId = readCloudWorkspaceSelection(session?.profile.id);
  return workspaceId && session ? `${key}:${session.profile.id}:${workspaceId}` : key;
}
