'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { fetchCloudConfig, saveCloudConfig } from '../../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../../lib/admin-screen';
import type { CloudConfigSnapshot } from '../../../lib/admin-types';
import { Button } from '../../ui/button';
import { useAdminSession } from '../use-admin-session';
import { AdminPageHeader } from '../shared/admin-page-header';
import { CloudConfigPanel } from './cloud-config-panel';

type SettingsScreenProps = {
  apiBaseUrl?: string;
};

export function SettingsScreen({
  apiBaseUrl = 'http://localhost:3001',
}: SettingsScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const { isAdmin, isReady, logout, token } = session;
  const [cloudConfig, setCloudConfig] = useState<CloudConfigSnapshot | null>(null);
  const [cloudConfigErrorMessage, setCloudConfigErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveErrorMessage, setCloudConfigSaveErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveSuccessMessage, setCloudConfigSaveSuccessMessage] = useState<string | null>(null);
  const [isLoadingCloudConfig, setIsLoadingCloudConfig] = useState(false);
  const [isSavingCloudConfig, setIsSavingCloudConfig] = useState(false);
  const [cloudConfigLoadAttempt, setCloudConfigLoadAttempt] = useState(0);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!token) {
      setCloudConfig(null);
      setCloudConfigErrorMessage(null);
      setCloudConfigSaveErrorMessage(null);
      setCloudConfigSaveSuccessMessage(null);
      setIsLoadingCloudConfig(false);
      setIsSavingCloudConfig(false);
      return;
    }

    if (!isAdmin) {
      setCloudConfig(null);
      setCloudConfigErrorMessage(null);
      setCloudConfigSaveErrorMessage(null);
      setCloudConfigSaveSuccessMessage(null);
      setIsLoadingCloudConfig(false);
      setIsSavingCloudConfig(false);
      router.replace('/admin/scenarios');
      return;
    }

    let isActive = true;

    setCloudConfigErrorMessage(null);
    setCloudConfigSaveErrorMessage(null);
    setCloudConfigSaveSuccessMessage(null);
    setIsLoadingCloudConfig(true);
    fetchCloudConfig(apiBaseUrl, token)
      .then((cloudConfigPayload) => {
        if (!isActive) {
          return;
        }

        setCloudConfig(cloudConfigPayload);
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
      });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, cloudConfigLoadAttempt, isAdmin, isReady, router, token]);

  const handleFieldChange = (field: keyof CloudConfigSnapshot, value: string) => {
    setCloudConfig((currentValue) => {
      if (!currentValue) {
        return currentValue;
      }

      return {
        ...currentValue,
        [field]: value,
      };
    });
    setCloudConfigSaveErrorMessage(null);
    setCloudConfigSaveSuccessMessage(null);
  };

  const handleSaveCloudConfig = async () => {
    if (!token || !cloudConfig) {
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

      setCloudConfigSaveErrorMessage(error instanceof Error ? error.message : '云配置保存失败，请检查凭据或自定义 Bucket 配置。');
    } finally {
      setIsSavingCloudConfig(false);
    }
  };

  const retryCloudConfigLoad = () => {
    setCloudConfigErrorMessage(null);
    setCloudConfigSaveErrorMessage(null);
    setCloudConfigSaveSuccessMessage(null);
    setIsLoadingCloudConfig(true);
    setCloudConfigLoadAttempt((currentAttempt) => currentAttempt + 1);
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

  const isInitialCloudConfigLoad = cloudConfig === null && cloudConfigErrorMessage === null;

  return (
    <div className="admin-screen">
      <section className="admin-workbench-surface">
        <AdminPageHeader
          action={(
            <Button
              disabled={isInitialCloudConfigLoad || cloudConfig === null || isSavingCloudConfig}
              form="cloud-config-form"
              type="submit"
            >
              {isSavingCloudConfig ? '正在保存...' : '保存云配置'}
            </Button>
          )}
          description="管理阿里云默认地域、访问凭据和镜像导入存储。"
          title="云配置"
        />

        <CloudConfigPanel
          loadErrorMessage={cloudConfigErrorMessage}
          isLoading={isInitialCloudConfigLoad || (isLoadingCloudConfig && cloudConfig === null)}
          isSaving={isSavingCloudConfig}
          saveErrorMessage={cloudConfigSaveErrorMessage}
          saveSuccessMessage={cloudConfigSaveSuccessMessage}
          value={cloudConfig}
          onChange={handleFieldChange}
          onRetry={retryCloudConfigLoad}
          onSubmit={handleSaveCloudConfig}
        />
      </section>
    </div>
  );
}
