'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  activateCloudAccountContext,
  createCloudAccountContext,
  ensureCloudAccountContextBucket,
  fetchCloudAccountContexts,
  fetchCloudConfig,
  saveCloudConfig,
} from '../../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../../lib/admin-screen';
import type { CloudAccountContext, CloudConfigSnapshot, CreateCloudAccountContextInput } from '../../../lib/admin-types';
import { useAdminSession } from '../use-admin-session';
import { CloudAccountContextPanel } from './cloud-account-context-panel';
import { CloudConfigPanel } from './cloud-config-panel';

type SettingsScreenProps = {
  apiBaseUrl?: string;
};

const emptyCloudConfig: CloudConfigSnapshot = {
  provider: 'alibaba_cloud',
  defaultRegion: '',
  defaultZoneId: '',
  accessKeyId: '',
  accessKeySecret: '',
};

const emptyCloudAccountContextDraft: CreateCloudAccountContextInput = {
  displayName: '',
  regionId: '',
  zoneId: '',
  accessKeyId: '',
  accessKeySecret: '',
  imageImportBucket: '',
};

export function SettingsScreen({
  apiBaseUrl = 'http://localhost:3001',
}: SettingsScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const { isAdmin, isReady, logout, token } = session;
  const [cloudConfig, setCloudConfig] = useState<CloudConfigSnapshot>(emptyCloudConfig);
  const [cloudConfigErrorMessage, setCloudConfigErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveErrorMessage, setCloudConfigSaveErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveSuccessMessage, setCloudConfigSaveSuccessMessage] = useState<string | null>(null);
  const [isLoadingCloudConfig, setIsLoadingCloudConfig] = useState(false);
  const [isSavingCloudConfig, setIsSavingCloudConfig] = useState(false);
  const [cloudContexts, setCloudContexts] = useState<CloudAccountContext[]>([]);
  const [cloudContextDraft, setCloudContextDraft] = useState<CreateCloudAccountContextInput>(emptyCloudAccountContextDraft);
  const [cloudContextErrorMessage, setCloudContextErrorMessage] = useState<string | null>(null);
  const [cloudContextSuccessMessage, setCloudContextSuccessMessage] = useState<string | null>(null);
  const [isLoadingCloudContexts, setIsLoadingCloudContexts] = useState(false);
  const [isSavingCloudContext, setIsSavingCloudContext] = useState(false);
  const [pendingCloudContextId, setPendingCloudContextId] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!token) {
      setCloudConfig(emptyCloudConfig);
      setCloudConfigErrorMessage(null);
      setCloudConfigSaveErrorMessage(null);
      setCloudConfigSaveSuccessMessage(null);
      setIsLoadingCloudConfig(false);
      setIsSavingCloudConfig(false);
      setCloudContexts([]);
      setCloudContextDraft(emptyCloudAccountContextDraft);
      setCloudContextErrorMessage(null);
      setCloudContextSuccessMessage(null);
      setIsLoadingCloudContexts(false);
      setIsSavingCloudContext(false);
      setPendingCloudContextId(null);
      return;
    }

    if (!isAdmin) {
      setCloudConfig(emptyCloudConfig);
      setCloudConfigErrorMessage(null);
      setCloudConfigSaveErrorMessage(null);
      setCloudConfigSaveSuccessMessage(null);
      setIsLoadingCloudConfig(false);
      setIsSavingCloudConfig(false);
      setCloudContexts([]);
      setCloudContextErrorMessage(null);
      setCloudContextSuccessMessage(null);
      setIsLoadingCloudContexts(false);
      setIsSavingCloudContext(false);
      setPendingCloudContextId(null);
      router.replace('/admin/scenarios');
      return;
    }

    let isActive = true;

    setCloudConfigErrorMessage(null);
    setCloudConfigSaveErrorMessage(null);
    setCloudConfigSaveSuccessMessage(null);
    setIsLoadingCloudConfig(true);
    setIsLoadingCloudContexts(true);

    Promise.all([fetchCloudConfig(apiBaseUrl, token), fetchCloudAccountContexts(apiBaseUrl, token)])
      .then(([cloudConfigPayload, cloudContextsPayload]) => {
        if (!isActive) {
          return;
        }

        setCloudConfig(cloudConfigPayload);
        setCloudContexts(cloudContextsPayload);
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        if (isUnauthorizedAdminError(error)) {
          logout();
          router.replace('/admin/login');
          return;
        }

        setCloudConfigErrorMessage('云配置加载失败，请稍后重试。');
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setIsLoadingCloudConfig(false);
        setIsLoadingCloudContexts(false);
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, isAdmin, isReady, router, token]);

  const handleFieldChange = (field: keyof CloudConfigSnapshot, value: string) => {
    setCloudConfig((currentValue) => ({
      ...currentValue,
      [field]: value,
    }));
    setCloudConfigSaveErrorMessage(null);
    setCloudConfigSaveSuccessMessage(null);
  };

  const handleSaveCloudConfig = async () => {
    if (!token) {
      return;
    }

    setCloudConfigSaveErrorMessage(null);
    setCloudConfigSaveSuccessMessage(null);
    setIsSavingCloudConfig(true);

    try {
      const savedConfig = await saveCloudConfig(apiBaseUrl, token, cloudConfig);
      setCloudConfig(savedConfig);
      setCloudConfigSaveSuccessMessage('云配置已保存。');
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        logout();
        router.replace('/admin/login');
        return;
      }

      setCloudConfigSaveErrorMessage('云配置保存失败，请稍后重试。');
    } finally {
      setIsSavingCloudConfig(false);
    }
  };

  const handleCloudContextFieldChange = (field: keyof CreateCloudAccountContextInput, value: string) => {
    setCloudContextDraft((current) => ({ ...current, [field]: value }));
    setCloudContextErrorMessage(null);
    setCloudContextSuccessMessage(null);
  };

  const handleCreateCloudContext = async () => {
    if (!token) {
      return;
    }

    setCloudContextErrorMessage(null);
    setCloudContextSuccessMessage(null);
    setIsSavingCloudContext(true);

    try {
      const created = await createCloudAccountContext(apiBaseUrl, token, cloudContextDraft);
      setCloudContexts((current) => [created, ...current]);
      setCloudContextDraft(emptyCloudAccountContextDraft);
      setCloudContextSuccessMessage(created.status === 'ready' ? '云账号已验证，OSS Bucket 已就绪。' : '云账号已保存，但 Bucket 初始化失败，请修复后再上传镜像。');
    } catch (error) {
      if (isUnauthorizedAdminError(error)) {
        logout();
        router.replace('/admin/login');
        return;
      }

      setCloudContextErrorMessage(error instanceof Error ? error.message : '云账号创建失败，请检查凭据和 Bucket 权限。');
    } finally {
      setIsSavingCloudContext(false);
    }
  };

  const updateCloudContext = async (id: string, action: 'activate' | 'repair') => {
    if (!token) {
      return;
    }

    setCloudContextErrorMessage(null);
    setCloudContextSuccessMessage(null);
    setPendingCloudContextId(id);

    try {
      const updated = action === 'activate'
        ? await activateCloudAccountContext(apiBaseUrl, token, id)
        : await ensureCloudAccountContextBucket(apiBaseUrl, token, id);
      setCloudContexts((current) => current.map((item) => {
        if (item.id === updated.id) {
          return updated;
        }
        return action === 'activate' ? { ...item, isActive: false } : item;
      }));
      setCloudContextSuccessMessage(action === 'activate' ? '已切换当前阿里云账号。' : updated.status === 'ready' ? 'OSS Bucket 已修复并可用于镜像导入。' : 'Bucket 仍未就绪，请检查阿里云权限。');
    } catch (error) {
      setCloudContextErrorMessage(error instanceof Error ? error.message : '云账号操作失败，请稍后重试。');
    } finally {
      setPendingCloudContextId(null);
    }
  };

  if (!isReady) {
    return null;
  }

  if (!token) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在跳转到管理员登录页...</h2>
          <p className="admin-empty">检测到当前没有有效的管理员会话。</p>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="admin-shell">
        <section className="admin-panel admin-login-panel">
          <h2>正在返回主工作台...</h2>
          <p className="admin-empty">当前账号无权访问基础配置。</p>
        </section>
      </main>
    );
  }

  return (
    <div className="admin-screen admin-workbench-screen">
      {cloudConfigErrorMessage ? <p className="admin-error">{cloudConfigErrorMessage}</p> : null}

      <CloudConfigPanel
        value={cloudConfig}
        isLoading={isLoadingCloudConfig}
        isSaving={isSavingCloudConfig}
        isManagedByAccountContext={cloudContexts.some((context) => context.isActive && context.status === 'ready')}
        saveErrorMessage={cloudConfigSaveErrorMessage}
        saveSuccessMessage={cloudConfigSaveSuccessMessage}
        onChange={handleFieldChange}
        onSubmit={handleSaveCloudConfig}
      />
      <CloudAccountContextPanel
        contexts={cloudContexts}
        draft={cloudContextDraft}
        isLoading={isLoadingCloudContexts}
        isSaving={isSavingCloudContext}
        errorMessage={cloudContextErrorMessage}
        successMessage={cloudContextSuccessMessage}
        pendingContextId={pendingCloudContextId}
        onChange={handleCloudContextFieldChange}
        onCreate={handleCreateCloudContext}
        onActivate={(id) => updateCloudContext(id, 'activate')}
        onRepair={(id) => updateCloudContext(id, 'repair')}
      />
    </div>
  );
}
