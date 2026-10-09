'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { fetchCloudConfig, saveCloudConfig } from '../../../lib/admin-api';
import { useAdminScreenCache } from '../../../lib/admin-screen-cache';
import { isUnauthorizedAdminError } from '../../../lib/admin-screen';
import type { CloudConfigSnapshot } from '../../../lib/admin-types';
import { Button } from '../../ui/button';
import { useAdminRouteIsActive } from '../admin-page-cache';
import { useAdminSession } from '../use-admin-session';
import { AdminPageHeader } from '../shared/admin-page-header';
import { CloudConfigPanel } from './cloud-config-panel';
import { TencentCloudPanel } from './tencent-cloud-panel';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../ui/tabs';

type SettingsScreenProps = {
  apiBaseUrl?: string;
};

export function SettingsScreen({
  apiBaseUrl = 'http://localhost:3001',
}: SettingsScreenProps) {
  const router = useRouter();
  const session = useAdminSession();
  const { isAdmin, isReady, logout, token } = session;
  const isPageActive = useAdminRouteIsActive('/admin/settings/cloud');
  const screenCache = useAdminScreenCache();
  const cloudConfigResource = 'settings:cloud-config';
  const cloudConfigSource = `${apiBaseUrl}\u0000${token ?? ''}`;
  const cachedCloudConfig = screenCache?.read<CloudConfigSnapshot>(apiBaseUrl, token, cloudConfigResource);
  const [cloudConfig, setCloudConfig] = useState<CloudConfigSnapshot | null>(() => cachedCloudConfig?.data ?? null);
  const [cloudTab, setCloudTab] = useState('alibaba_cloud');
  const [cloudConfigErrorMessage, setCloudConfigErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveErrorMessage, setCloudConfigSaveErrorMessage] = useState<string | null>(null);
  const [cloudConfigSaveSuccessMessage, setCloudConfigSaveSuccessMessage] = useState<string | null>(null);
  const [isLoadingCloudConfig, setIsLoadingCloudConfig] = useState(() => !cachedCloudConfig);
  const [isSavingCloudConfig, setIsSavingCloudConfig] = useState(false);
  const [cloudConfigLoadAttempt, setCloudConfigLoadAttempt] = useState(0);
  const [loadedCloudConfigSource, setLoadedCloudConfigSource] = useState<string | null>(() =>
    cachedCloudConfig ? cloudConfigSource : null,
  );

  useEffect(() => {
    if (!isPageActive || !isReady) {
      return;
    }

    if (!token) {
      setCloudConfig(null);
      setCloudConfigErrorMessage(null);
      setCloudConfigSaveErrorMessage(null);
      setCloudConfigSaveSuccessMessage(null);
      setIsLoadingCloudConfig(false);
      setIsSavingCloudConfig(false);
      setLoadedCloudConfigSource(null);
      return;
    }

    if (!isAdmin) {
      setCloudConfig(null);
      setCloudConfigErrorMessage(null);
      setCloudConfigSaveErrorMessage(null);
      setCloudConfigSaveSuccessMessage(null);
      setIsLoadingCloudConfig(false);
      setIsSavingCloudConfig(false);
      setLoadedCloudConfigSource(null);
      router.replace('/admin/scenarios');
      return;
    }

    let isActive = true;
    const cachedSnapshot = screenCache?.read<CloudConfigSnapshot>(apiBaseUrl, token, cloudConfigResource);

    if (cachedSnapshot?.isFresh && cloudConfigLoadAttempt === 0) {
      setCloudConfig(cachedSnapshot.data);
      setLoadedCloudConfigSource(cloudConfigSource);
      setCloudConfigErrorMessage(null);
      setIsLoadingCloudConfig(false);

      return () => {
        isActive = false;
      };
    }

    if (loadedCloudConfigSource === cloudConfigSource && !screenCache && cloudConfigLoadAttempt === 0) {
      setIsLoadingCloudConfig(false);

      return () => {
        isActive = false;
      };
    }

    setCloudConfigErrorMessage(null);
    setIsLoadingCloudConfig(true);
    const request = screenCache
      ? screenCache.load(apiBaseUrl, token, cloudConfigResource, () => fetchCloudConfig(apiBaseUrl, token), {
          force: cloudConfigLoadAttempt > 0,
        })
      : fetchCloudConfig(apiBaseUrl, token);

    request
      .then((cloudConfigPayload) => {
        if (!isActive) {
          return;
        }

        setCloudConfig(cloudConfigPayload);
        setLoadedCloudConfigSource(cloudConfigSource);
        if (cloudConfigLoadAttempt > 0) {
          setCloudConfigLoadAttempt(0);
        }
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
  }, [
    apiBaseUrl,
    cloudConfigLoadAttempt,
    cloudConfigResource,
    cloudConfigSource,
    isAdmin,
    isPageActive,
    isReady,
    loadedCloudConfigSource,
    router,
    screenCache,
    token,
  ]);

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
      screenCache?.invalidate(apiBaseUrl, token, 'settings:');
      screenCache?.invalidate(apiBaseUrl, token, 'image-center:');
      screenCache?.invalidate(apiBaseUrl, token, 'platform-images:');
      setCloudConfig(savedConfig);
      setLoadedCloudConfigSource(cloudConfigSource);
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
          action={cloudTab === 'alibaba_cloud' ? (
            <Button
              disabled={isInitialCloudConfigLoad || cloudConfig === null || isSavingCloudConfig}
              form="cloud-config-form"
              type="submit"
            >
              {isSavingCloudConfig ? '正在保存...' : '保存云配置'}
            </Button>
          ) : undefined}
          description="管理云账号、默认地域与镜像存储。"
          title="云配置"
        />

        <Tabs className="pt-4" value={cloudTab} onValueChange={setCloudTab}>
          <TabsList aria-label="云账号配置" variant="line">
            <TabsTrigger value="alibaba_cloud">阿里云配置</TabsTrigger>
            <TabsTrigger value="tencent_cloud">腾讯云接入</TabsTrigger>
          </TabsList>
          <TabsContent value="alibaba_cloud">
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
          </TabsContent>
          <TabsContent value="tencent_cloud">
            <TencentCloudPanel apiBaseUrl={apiBaseUrl} token={token} onError={error => {
              if (!isUnauthorizedAdminError(error)) return false;
              logout();
              router.replace('/admin/login');
              return true;
            }} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}
