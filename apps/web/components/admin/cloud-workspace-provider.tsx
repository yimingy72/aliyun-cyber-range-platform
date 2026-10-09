'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchAuthenticatedAdminProfile, fetchCurrentCloudWorkspace, switchCloudWorkspace } from '@/lib/admin-api';
import { resolveAdminApiBaseUrl } from '@/lib/admin-api-base-url';
import { readCloudWorkspaceSelection, readStoredCloudWorkspaceSelection, setCloudWorkspaceSelection } from '@/lib/cloud-workspace-selection';
import type { AdminProfile, CloudWorkspaceView } from '@/lib/admin-types';
import { readAdminSession, writeAdminSession } from '@/lib/admin-auth-storage';
import { isUnauthorizedAdminError } from '@/lib/admin-screen';
import { readAdminOidcTokenExpiresAt } from '@/lib/admin-oidc';
import { useAdminSession } from './use-admin-session';

type WorkspaceContext = {
  workspace: CloudWorkspaceView | null;
  profile: AdminProfile | null;
  isReady: boolean;
  isSwitching: boolean;
  error: string | null;
  retry: () => void;
  resetSelection: () => void;
  refreshCurrent: () => Promise<void>;
  switchTo: (workspaceId: string) => Promise<void>;
};

const CloudWorkspaceContext = createContext<WorkspaceContext | null>(null);
export function useCloudWorkspace() { return useContext(CloudWorkspaceContext); }
export function cloudProviderLabel(provider: CloudWorkspaceView['provider']) { return provider === 'tencent_cloud' ? '腾讯云' : '阿里云'; }

export function CloudWorkspaceProvider({ children }: { children: ReactNode }) {
  const session = useAdminSession();
  const apiBaseUrl = resolveAdminApiBaseUrl();
  const [workspace, setWorkspace] = useState<CloudWorkspaceView | null>(null);
  const [verifiedProfile, setVerifiedProfile] = useState<AdminProfile | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const identity = session.profile?.id ?? null;
  const source = identity ?? '';
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const switching = useRef(false);
  const loadedIdentity = useRef<string | null>(null);
  const refreshRevision = useRef(0);

  useEffect(() => {
    if (!session.isReady || !session.token || !identity) return;
    const expiresAt = readAdminOidcTokenExpiresAt(session.token);
    if (session.refreshToken && expiresAt !== null && expiresAt - Date.now() <= 60_000) return;
    // Token renewal keeps the selected data space and mounted pages intact.
    if (loadedIdentity.current === identity && attempt === 0) return;
    let current = true;
    ++refreshRevision.current;
    setIsReady(false);
    setError(null);
    setWorkspace(null);
    setVerifiedProfile(null);
    const storedId = readStoredCloudWorkspaceSelection(identity);
    Promise.all([fetchAuthenticatedAdminProfile(apiBaseUrl, session.token), fetchCurrentCloudWorkspace(apiBaseUrl, session.token, storedId)]).then(([profile, result]) => {
      if (!current) return;
      if (storedId && result?.id !== storedId) throw new Error('返回的云账号工作空间不一致，请重新选择。');
      if (!profile.id || !profile.username || (profile.role !== 'admin' && profile.role !== 'user')) throw new Error('登录身份返回异常。');
      setCloudWorkspaceSelection(profile.id, result?.id ?? null);
      setWorkspace(result);
      setVerifiedProfile(profile);
      loadedIdentity.current = profile.id;
      const storedSession = readAdminSession();
      if (storedSession?.token === session.token) writeAdminSession({ ...storedSession, profile });
      setIsReady(true);
      if (attempt) setAttempt(0);
    }).catch((failure: unknown) => {
      if (current) {
        if (isUnauthorizedAdminError(failure)) session.logout();
        else setError(failure instanceof Error ? failure.message : '云账号工作空间加载失败。');
      }
    });
    return () => { current = false; };
  }, [apiBaseUrl, attempt, identity, session.isReady, session.token]);

  const switchTo = useCallback(async (workspaceId: string) => {
    if (!session.token || !identity || switching.current || workspaceId === workspace?.id) return;
    switching.current = true;
    ++refreshRevision.current;
    setIsSwitching(true);
    const requestSource = source;
    try {
      const next = await switchCloudWorkspace(apiBaseUrl, session.token, workspaceId);
      if (sourceRef.current !== requestSource) return;
      if (next.id !== workspaceId) throw new Error('切换返回的云账号工作空间不一致。');
      setCloudWorkspaceSelection(identity, next.id);
      setWorkspace(next);
      setError(null);
    } finally {
      switching.current = false;
      setIsSwitching(false);
    }
  }, [apiBaseUrl, identity, session.token, source, workspace?.id]);

  const refreshCurrent = useCallback(async () => {
    if (!session.token || !workspace) return;
    const requestSource = source;
    const revision = ++refreshRevision.current;
    const next = await fetchCurrentCloudWorkspace(apiBaseUrl, session.token, workspace.id);
    if (sourceRef.current !== requestSource || revision !== refreshRevision.current
      || readCloudWorkspaceSelection(identity) !== workspace.id) return;
    if (!next || next.id !== workspace.id) throw new Error('云账号配置返回的工作空间不一致。');
    setWorkspace(next);
  }, [apiBaseUrl, identity, session.token, source, workspace]);

  const ready = isReady && loadedIdentity.current === identity;
  return <CloudWorkspaceContext.Provider value={{ workspace, profile: ready ? verifiedProfile : null, isReady: ready, isSwitching, error, retry: () => setAttempt(value => value + 1), resetSelection: () => { if (identity) setCloudWorkspaceSelection(identity, null); setAttempt(value => value + 1); }, refreshCurrent, switchTo }}>{children}</CloudWorkspaceContext.Provider>;
}
