import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminApiError } from '../../lib/admin-api';
import type {
  ImageCatalogItem,
  ImageCatalogScopePayload,
  ImageSnapshot,
  PlatformImageAssetListPayload,
} from '../../lib/admin-types';

const {
  fetchPublicImageCatalogScopeMock,
  fetchCustomImageCatalogScopeMock,
  fetchPlatformImagesMock,
  syncPublicImagesMock,
  syncCustomImagesMock,
  collectImageCatalogItemMock,
  logoutMock,
} = vi.hoisted(() => ({
  fetchPublicImageCatalogScopeMock: vi.fn(),
  fetchCustomImageCatalogScopeMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  syncPublicImagesMock: vi.fn(),
  syncCustomImagesMock: vi.fn(),
  collectImageCatalogItemMock: vi.fn(),
  logoutMock: vi.fn(),
}));

vi.mock('../../lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/admin-api')>('../../lib/admin-api');

  return {
    ...actual,
    fetchPublicImageCatalogScope: fetchPublicImageCatalogScopeMock,
    fetchCustomImageCatalogScope: fetchCustomImageCatalogScopeMock,
    fetchPlatformImages: fetchPlatformImagesMock,
    syncPublicImages: syncPublicImagesMock,
    syncCustomImages: syncCustomImagesMock,
    collectImageCatalogItem: collectImageCatalogItemMock,
  };
});

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    isReady: true,
    token: 'dev-admin-token',
    logout: logoutMock,
  }),
}));

import { ImageCenterScreen } from './image-center-screen';

function createSnapshot(
  overrides: Partial<ImageSnapshot> & Pick<ImageSnapshot, 'id' | 'imageId' | 'sourceImageName' | 'scope'>,
): ImageSnapshot {
  return {
    provider: 'alibaba_cloud',
    accountUid: null,
    regionId: 'cn-hangzhou',
    osType: 'linux',
    platform: 'Ubuntu',
    architecture: 'x86_64',
    status: 'Available',
    isAvailable: true,
    lastSyncedAt: '2026-07-03T00:00:00.000Z',
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

function createCatalogItem(
  overrides: Partial<ImageCatalogItem> & Pick<ImageCatalogItem, 'id' | 'imageId' | 'displayName' | 'scope'>,
): ImageCatalogItem {
  return {
    provider: 'alibaba_cloud',
    accountUid: null,
    regionId: 'cn-hangzhou',
    enabled: true,
    sourceSnapshotId: null,
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

const publicSnapshot = createSnapshot({
  id: 'public-snapshot-1',
  scope: 'public',
  imageId: 'aliyun-linux-3',
  sourceImageName: 'Alibaba Cloud Linux 3',
  platform: 'Alibaba Cloud Linux',
});

const customSnapshot = createSnapshot({
  id: 'custom-snapshot-1',
  scope: 'custom',
  imageId: 'm-custom-001',
  sourceImageName: 'Blue Team Ubuntu 22.04',
  platform: 'Ubuntu 22.04',
});

const publicScopePayload: ImageCatalogScopePayload = {
  snapshots: [publicSnapshot],
  catalogItems: [
    createCatalogItem({
      id: 'catalog-public-1',
      scope: 'public',
      imageId: 'aliyun-linux-3',
      displayName: 'Alibaba Cloud Linux 3',
      sourceSnapshotId: 'public-snapshot-1',
    }),
  ],
};

const customScopePayload: ImageCatalogScopePayload = {
  snapshots: [customSnapshot],
  catalogItems: [],
};

const platformImagesPayload: PlatformImageAssetListPayload = {
  items: [],
};

beforeEach(() => {
  fetchPublicImageCatalogScopeMock.mockReset();
  fetchCustomImageCatalogScopeMock.mockReset();
  fetchPlatformImagesMock.mockReset();
  syncPublicImagesMock.mockReset();
  syncCustomImagesMock.mockReset();
  collectImageCatalogItemMock.mockReset();
  logoutMock.mockReset();

  fetchPublicImageCatalogScopeMock.mockResolvedValue(publicScopePayload);
  fetchCustomImageCatalogScopeMock.mockResolvedValue(customScopePayload);
  fetchPlatformImagesMock.mockResolvedValue(platformImagesPayload);
  syncPublicImagesMock.mockResolvedValue(publicScopePayload);
  syncCustomImagesMock.mockResolvedValue(customScopePayload);
  collectImageCatalogItemMock.mockResolvedValue(
    createCatalogItem({
      id: 'catalog-custom-1',
      scope: 'custom',
      imageId: 'm-custom-001',
      displayName: 'Blue Team Ubuntu 22.04',
      sourceSnapshotId: 'custom-snapshot-1',
    }),
  );
});

afterEach(() => {
  cleanup();
});

describe('ImageCenterScreen', () => {
  it('renders public and custom image modules with sync actions and rows', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('button', { name: '平台镜像' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '公共镜像' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '自定义镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '同步公共镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '同步自定义镜像' })).toBeTruthy();
    expect(screen.getByText('Alibaba Cloud Linux 3')).toBeTruthy();
    expect(screen.getByText('Blue Team Ubuntu 22.04')).toBeTruthy();
    expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(fetchPlatformImagesMock).toHaveBeenCalledTimes(1);
    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
  });

  it('collects a custom snapshot and then shows it as already collected', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收录到目录 Blue Team Ubuntu 22.04' }));

    await waitFor(() => {
      expect(collectImageCatalogItemMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        {
          snapshotId: 'custom-snapshot-1',
          displayName: 'Blue Team Ubuntu 22.04',
        },
      );
    });

    const collectedButton = await screen.findByRole('button', { name: '已收录 Blue Team Ubuntu 22.04' }) as HTMLButtonElement;
    expect(collectedButton.disabled).toBe(true);
  });

  it('treats disabled catalog items as collectable until they are re-collected', async () => {
    fetchCustomImageCatalogScopeMock.mockResolvedValue({
      snapshots: [customSnapshot],
      catalogItems: [
        createCatalogItem({
          id: 'catalog-custom-disabled-1',
          scope: 'custom',
          imageId: 'm-custom-001',
          displayName: 'Blue Team Ubuntu 22.04',
          sourceSnapshotId: 'custom-snapshot-1',
          enabled: false,
        }),
      ],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('button', { name: '收录到目录 Blue Team Ubuntu 22.04' })).toBeTruthy();
  });

  it('syncs public images and updates the public module rows', async () => {
    syncPublicImagesMock.mockResolvedValue({
      snapshots: [
        ...publicScopePayload.snapshots,
        createSnapshot({
          id: 'public-snapshot-2',
          scope: 'public',
          imageId: 'ubuntu-24-04',
          sourceImageName: 'Ubuntu 24.04 LTS',
          status: 'Deprecated',
          isAvailable: false,
        }),
      ],
      catalogItems: publicScopePayload.catalogItems,
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Alibaba Cloud Linux 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(syncPublicImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    });

    expect(await screen.findByText('Ubuntu 24.04 LTS')).toBeTruthy();
  });

  it('logs out when sync or collect receives a 401 response after initial load', async () => {
    syncPublicImagesMock.mockRejectedValue(new AdminApiError(401, 'session expired'));
    collectImageCatalogItemMock.mockRejectedValue(new AdminApiError(401, 'session expired'));

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '收录到目录 Blue Team Ubuntu 22.04' }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps newer sync results when the initial public load resolves late', async () => {
    let resolvePublicScope: ((value: ImageCatalogScopePayload) => void) | null = null;

    fetchPublicImageCatalogScopeMock.mockImplementationOnce(
      () =>
        new Promise<ImageCatalogScopePayload>((resolve) => {
          resolvePublicScope = resolve;
        }),
    );
    syncPublicImagesMock.mockResolvedValue({
      snapshots: [
        createSnapshot({
          id: 'public-snapshot-2',
          scope: 'public',
          imageId: 'ubuntu-24-04',
          sourceImageName: 'Ubuntu 24.04 LTS',
          status: 'Deprecated',
          isAvailable: false,
        }),
      ],
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    expect(await screen.findByText('Ubuntu 24.04 LTS')).toBeTruthy();

    resolvePublicScope?.(publicScopePayload);

    await waitFor(() => {
      expect(screen.getByText('Ubuntu 24.04 LTS')).toBeTruthy();
    });

    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
  });

  it('filters both sections by image name or image id', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Alibaba Cloud Linux 3')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '筛选镜像名' }), {
      target: { value: 'm-custom-001' },
    });

    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
    expect(screen.getByText('Blue Team Ubuntu 22.04')).toBeTruthy();
  });
});
