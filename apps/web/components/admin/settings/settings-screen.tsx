'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { fetchCloudConfig, saveCloudConfig } from '../../../lib/admin-api';
import { isUnauthorizedAdminError } from '../../../lib/admin-screen';
import type { CloudConfigSnapshot } from '../../../lib/admin-types';
import { useAdminSession } from '../use-admin-session';
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

export function SettingsScreen({
  apiBaseUrl = 'http://localhost:3001',
}: SettingsScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const { isReady, logout, token } = session;
  const [cloudConfig, setCloudConfig] = useState<CloudConfigSnapshot>(emptyCloudConfig);
  const [cloudConfigErrorMessage, setCloudConfigErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveErrorMessage, setCloudConfigSaveErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveSuccessMessage, setCloudConfigSaveSuccessMessage] = useState<string | null>(null);
  const [isLoadingCloudConfig, setIsLoadingCloudConfig] = useState(false);
  const [isSavingCloudConfig, setIsSavingCloudConfig] = useState(false);

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
  }, [apiBaseUrl, isReady, router, token]);

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

  return (
    <div className="admin-screen admin-workbench-screen">
      {cloudConfigErrorMessage ? <p className="admin-error">{cloudConfigErrorMessage}</p> : null}

      <CloudConfigPanel
        value={cloudConfig}
        isLoading={isLoadingCloudConfig}
        isSaving={isSavingCloudConfig}
        saveErrorMessage={cloudConfigSaveErrorMessage}
        saveSuccessMessage={cloudConfigSaveSuccessMessage}
        onChange={handleFieldChange}
        onSubmit={handleSaveCloudConfig}
      />
    </div>
  );
}
