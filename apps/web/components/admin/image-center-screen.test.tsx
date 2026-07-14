import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminApiError } from '../../lib/admin-api';
import type {
  ImageCatalogItem,
  ImageCatalogScopePayload,
  ImageSnapshot,
  PlatformImageAsset,
  PlatformImageAssetListPayload,
} from '../../lib/admin-types';

const {
  fetchPublicImageCatalogScopeMock,
  fetchCustomImageCatalogScopeMock,
  fetchPlatformImagesMock,
  syncPublicImagesMock,
  syncCustomImagesMock,
  collectPlatformImageMock,
  renamePlatformImageMock,
  publishPlatformImageMock,
  unpublishPlatformImageMock,
  enablePlatformImageMock,
  disablePlatformImageMock,
  removePlatformImageMock,
  deleteCustomImageSnapshotMock,
  logoutMock,
  pushMock,
  sessionState,
} = vi.hoisted(() => ({
  fetchPublicImageCatalogScopeMock: vi.fn(),
  fetchCustomImageCatalogScopeMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  syncPublicImagesMock: vi.fn(),
  syncCustomImagesMock: vi.fn(),
  collectPlatformImageMock: vi.fn(),
  renamePlatformImageMock: vi.fn(),
  publishPlatformImageMock: vi.fn(),
  unpublishPlatformImageMock: vi.fn(),
  enablePlatformImageMock: vi.fn(),
  disablePlatformImageMock: vi.fn(),
  removePlatformImageMock: vi.fn(),
  deleteCustomImageSnapshotMock: vi.fn(),
  logoutMock: vi.fn(),
  pushMock: vi.fn(),
  sessionState: {
    profile: {
      id: 'admin-user',
      username: 'admin',
      role: 'admin' as const,
    },
  },
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
    collectPlatformImage: collectPlatformImageMock,
    renamePlatformImage: renamePlatformImageMock,
    publishPlatformImage: publishPlatformImageMock,
    unpublishPlatformImage: unpublishPlatformImageMock,
    enablePlatformImage: enablePlatformImageMock,
    disablePlatformImage: disablePlatformImageMock,
    removePlatformImage: removePlatformImageMock,
    deleteCustomImageSnapshot: deleteCustomImageSnapshotMock,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('./use-admin-session', () => ({
  useAdminSession: () => ({
    isReady: true,
    token: 'dev-admin-token',
    profile: sessionState.profile,
    isAdmin: sessionState.profile.role === 'admin',
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

function createPlatformImageAsset(
  overrides: Partial<PlatformImageAsset> & Pick<PlatformImageAsset, 'id' | 'imageId' | 'displayName'>,
): PlatformImageAsset {
  return {
    provider: 'alibaba_cloud',
    accountUid: null,
    accountScopeKey: 'aliyun:cn-hangzhou',
    regionId: 'cn-hangzhou',
    sourceScope: 'custom',
    sourceSnapshotId: null,
    enabled: true,
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
  items: [
    createPlatformImageAsset({
      id: 'platform-image-1',
      imageId: 'aliyun-linux-3',
      displayName: 'Alibaba Cloud Linux 3',
      createdBy: 'admin',
      sourceSnapshotId: 'public-snapshot-1',
      sourceScope: 'public',
      enabled: true,
    }),
  ],
};

const myImagesPayload: PlatformImageAssetListPayload = {
  items: [
    createPlatformImageAsset({
      id: 'my-image-1',
      imageId: 'm-owned-001',
      displayName: 'My Ubuntu 22.04',
      createdBy: 'test',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
      enabled: true,
    }),
  ],
};

const exportingMyImagesPayload: PlatformImageAssetListPayload = {
  items: [
    createPlatformImageAsset({
      id: 'my-image-exporting-1',
      imageId: 'm-exporting-001',
      displayName: 'Exporting Ubuntu 22.04',
      createdBy: 'test',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
      sourceSnapshotStatus: 'Creating 65%',
      sourceSnapshotAvailable: false,
      enabled: true,
    }),
  ],
};

beforeEach(() => {
  fetchPublicImageCatalogScopeMock.mockReset();
  fetchCustomImageCatalogScopeMock.mockReset();
  fetchPlatformImagesMock.mockReset();
  syncPublicImagesMock.mockReset();
  syncCustomImagesMock.mockReset();
  collectPlatformImageMock.mockReset();
  renamePlatformImageMock.mockReset();
  publishPlatformImageMock.mockReset();
  unpublishPlatformImageMock.mockReset();
  enablePlatformImageMock.mockReset();
  disablePlatformImageMock.mockReset();
  removePlatformImageMock.mockReset();
  deleteCustomImageSnapshotMock.mockReset();
  logoutMock.mockReset();
  pushMock.mockReset();
  sessionState.profile = {
    id: 'admin-user',
    username: 'admin',
    role: 'admin',
  };

  fetchPublicImageCatalogScopeMock.mockResolvedValue(publicScopePayload);
  fetchCustomImageCatalogScopeMock.mockResolvedValue(customScopePayload);
  fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
    view === 'mine' ? myImagesPayload : platformImagesPayload,
  );
  syncPublicImagesMock.mockResolvedValue(publicScopePayload);
  syncCustomImagesMock.mockResolvedValue(customScopePayload);
  collectPlatformImageMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'platform-image-collected-1',
      imageId: 'm-custom-001',
      displayName: 'Blue Team Ubuntu 22.04',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
      enabled: true,
    }),
  );
  renamePlatformImageMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'platform-image-1',
      imageId: 'm-custom-001',
      displayName: 'Blue Team Ubuntu 22.04 Renamed',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
      enabled: true,
    }),
  );
  publishPlatformImageMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'my-image-1',
      imageId: 'm-owned-001',
      displayName: 'My Ubuntu 22.04',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
      ownerUserId: 'admin-user',
      visibility: 'platform',
      enabled: true,
    }),
  );
  unpublishPlatformImageMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'my-image-2',
      imageId: 'm-owned-002',
      displayName: 'My Published Ubuntu 22.04',
      sourceSnapshotId: 'custom-snapshot-2',
      sourceScope: 'custom',
      ownerUserId: 'admin-user',
      visibility: 'private',
      enabled: true,
    }),
  );
  enablePlatformImageMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'platform-image-2',
      imageId: 'm-custom-002',
      displayName: 'Disabled Platform Image',
      sourceSnapshotId: 'custom-snapshot-2',
      sourceScope: 'custom',
      enabled: true,
    }),
  );
  disablePlatformImageMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'platform-image-1',
      imageId: 'm-custom-001',
      displayName: 'Blue Team Ubuntu 22.04',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
      enabled: false,
    }),
  );
  removePlatformImageMock.mockResolvedValue(undefined);
  deleteCustomImageSnapshotMock.mockResolvedValue(undefined);

});

afterEach(() => {
  cleanup();
});

describe('ImageCenterScreen', () => {
  it('renders 平台镜像 / 我的镜像 / 云上镜像来源 and loads all payloads', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('button', { name: '平台镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我的镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '云上镜像来源' })).toBeTruthy();
    expect(screen.getByText('Alibaba Cloud Linux 3')).toBeTruthy();
    expect(screen.getByText('创建人')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '我的镜像' }));
    expect(await screen.findByText('My Ubuntu 22.04')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '云上镜像来源' }));
    expect(await screen.findByRole('button', { name: '阿里云自定义镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '阿里云公共镜像' })).toBeTruthy();

    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'platform');
    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'mine');
    expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();
  });

  it('lazy-loads cloud image source tabs only when they are opened', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Alibaba Cloud Linux 3')).toBeTruthy();
    expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledTimes(0);
    expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getByRole('button', { name: '云上镜像来源' }));

    await waitFor(() => {
      expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    await waitFor(() => {
      expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledTimes(1);
    });
  });

  it('shows exporting private images in 我的镜像 with progress and without create-instance action', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine' ? exportingMyImagesPayload : platformImagesPayload,
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '我的镜像' }));

    expect(await screen.findByText('Exporting Ubuntu 22.04')).toBeTruthy();
    expect(screen.getByText('导出中 65%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建实例 Exporting Ubuntu 22.04' })).toBeNull();
    expect((screen.getByRole('button', { name: '发布到平台 Exporting Ubuntu 22.04' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps 我的镜像 rows compact by moving rename enable and delete into 更多操作', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '我的镜像' }));
    expect(await screen.findByText('My Ubuntu 22.04')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例 My Ubuntu 22.04' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布到平台 My Ubuntu 22.04' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重命名 My Ubuntu 22.04' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    expect(screen.getByRole('button', { name: '重命名' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '禁用' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('keeps 平台镜像 rows compact for owner-backed assets', async () => {
    sessionState.profile = {
      id: 'owner-user',
      username: 'owner-user',
      role: 'user',
    };
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({ items: [] } satisfies PlatformImageAssetListPayload)
        : ({
            items: [
              createPlatformImageAsset({
                id: 'owned-platform-image',
                imageId: 'm-owned-platform',
                displayName: 'Owned Platform Image',
                sourceSnapshotId: 'custom-snapshot-owner',
                sourceScope: 'custom',
                ownerUserId: 'owner-user',
                visibility: 'platform',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Owned Platform Image')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例 Owned Platform Image' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '回退为私有 Owned Platform Image' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重命名 Owned Platform Image' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    expect(screen.getByRole('button', { name: '重命名' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '禁用' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('routes 创建实例 from image rows into the single instance screen with a preselected image', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '创建实例 Alibaba Cloud Linux 3' }));

    expect(pushMock).toHaveBeenCalledWith('/admin/instances?create=1&platformImageAssetId=platform-image-1');
  });

  it('collects a custom snapshot and then shows it as already collected on the source tab', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine' ? myImagesPayload : ({ items: [] } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收录到平台 Blue Team Ubuntu 22.04' }));

    await waitFor(() => {
      expect(collectPlatformImageMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        snapshotId: 'custom-snapshot-1',
        displayName: 'Blue Team Ubuntu 22.04',
      });
    });

    const collectedButton = await screen.findByRole('button', { name: '已收录 Blue Team Ubuntu 22.04' });
    expect((collectedButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '平台镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByRole('button', { name: '收录到平台 Blue Team Ubuntu 22.04' })).toBeTruthy();
  });

  it('syncs public images and updates the public tab rows', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    expect(await screen.findByText('Alibaba Cloud Linux 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(syncPublicImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    });

    expect(await screen.findByText('Ubuntu 24.04 LTS')).toBeTruthy();
  });

  it('supports rename, disable, enable, and remove actions for platform assets', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? myImagesPayload
        : ({
            items: [
              createPlatformImageAsset({
                id: 'platform-image-1',
                imageId: 'm-custom-001',
                displayName: 'Blue Team Ubuntu 22.04',
                sourceSnapshotId: 'custom-snapshot-1',
                sourceScope: 'custom',
                enabled: true,
              }),
              createPlatformImageAsset({
                id: 'platform-image-2',
                imageId: 'm-custom-002',
                displayName: 'Disabled Platform Image',
                sourceSnapshotId: 'custom-snapshot-2',
                sourceScope: 'custom',
                enabled: false,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const platformTab = await screen.findByRole('button', { name: '平台镜像' });
    fireEvent.click(platformTab);

    const enabledRow = (await screen.findByText('Blue Team Ubuntu 22.04')).closest('article') as HTMLElement;
    fireEvent.click(within(enabledRow).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    const renameDialog = screen.getByRole('dialog', { name: '编辑镜像名称' });
    fireEvent.change(within(renameDialog).getByLabelText('镜像名'), {
      target: { value: 'Blue Team Ubuntu 22.04 Renamed' },
    });
    fireEvent.click(within(renameDialog).getByRole('button', { name: '保存信息' }));

    await waitFor(() => {
      expect(renamePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-1',
        'Blue Team Ubuntu 22.04 Renamed',
      );
    });

    expect(await screen.findByText('Blue Team Ubuntu 22.04 Renamed')).toBeTruthy();

    const renamedRow = (await screen.findByText('Blue Team Ubuntu 22.04 Renamed')).closest('article') as HTMLElement;
    fireEvent.click(within(renamedRow).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '禁用' }));

    await waitFor(() => {
      expect(disablePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-1',
      );
    });

    const disabledRow = (await screen.findByText('Disabled Platform Image')).closest('article') as HTMLElement;
    fireEvent.click(within(disabledRow).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '启用' }));

    await waitFor(() => {
      expect(enablePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-2',
      );
    });

    const enabledRowAgain = (await screen.findByText('Disabled Platform Image')).closest('article') as HTMLElement;
    fireEvent.click(within(enabledRowAgain).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const removeDialog = screen.getByRole('dialog', { name: '确认删除镜像' });
    fireEvent.click(within(removeDialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(removePlatformImageMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'platform-image-2');
    });

    expect(screen.queryByText('Disabled Platform Image')).toBeNull();
  });

  it('shows 发布到平台 and 回退为私有 actions inside 我的镜像 and calls the matching helpers', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({
            items: [
              createPlatformImageAsset({
                id: 'my-image-1',
                imageId: 'm-owned-001',
                displayName: 'My Ubuntu 22.04',
                sourceSnapshotId: 'custom-snapshot-1',
                sourceScope: 'custom',
                ownerUserId: 'admin-user',
                visibility: 'private',
                enabled: true,
              }),
              createPlatformImageAsset({
                id: 'my-image-2',
                imageId: 'm-owned-002',
                displayName: 'My Published Ubuntu 22.04',
                sourceSnapshotId: 'custom-snapshot-2',
                sourceScope: 'custom',
                ownerUserId: 'admin-user',
                visibility: 'platform',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload)
        : ({
            items: [
              createPlatformImageAsset({
                id: 'my-image-2',
                imageId: 'm-owned-002',
                displayName: 'My Published Ubuntu 22.04',
                sourceSnapshotId: 'custom-snapshot-2',
                sourceScope: 'custom',
                ownerUserId: 'admin-user',
                visibility: 'platform',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '我的镜像' }));

    expect(await screen.findByRole('button', { name: '发布到平台 My Ubuntu 22.04' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '回退为私有 My Published Ubuntu 22.04' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '发布到平台 My Ubuntu 22.04' }));
    await waitFor(() => {
      expect(publishPlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'my-image-1',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '回退为私有 My Published Ubuntu 22.04' }));
    await waitFor(() => {
      expect(unpublishPlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'my-image-2',
      );
    });
  });

  it('shows 回退为私有 for the owner on the 平台镜像 view', async () => {
    sessionState.profile = {
      id: 'owner-user',
      username: 'owner-user',
      role: 'user',
    };
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({
            items: [
              createPlatformImageAsset({
                id: 'owned-platform-image',
                imageId: 'm-owned-platform',
                displayName: 'Owned Platform Image',
                sourceSnapshotId: 'custom-snapshot-owner',
                sourceScope: 'custom',
                ownerUserId: 'owner-user',
                visibility: 'platform',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload)
        : ({
            items: [
              createPlatformImageAsset({
                id: 'owned-platform-image',
                imageId: 'm-owned-platform',
                displayName: 'Owned Platform Image',
                sourceSnapshotId: 'custom-snapshot-owner',
                sourceScope: 'custom',
                ownerUserId: 'owner-user',
                visibility: 'platform',
                enabled: true,
              }),
              createPlatformImageAsset({
                id: 'other-platform-image',
                imageId: 'm-other-platform',
                displayName: 'Other Platform Image',
                sourceSnapshotId: 'custom-snapshot-other',
                sourceScope: 'custom',
                ownerUserId: 'other-user',
                visibility: 'platform',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const ownedRow = (await screen.findByText('Owned Platform Image')).closest('article') as HTMLElement;
    expect(within(ownedRow).getByRole('button', { name: '回退为私有 Owned Platform Image' })).toBeTruthy();

    const otherRow = screen.getByText('Other Platform Image').closest('article') as HTMLElement;
    expect(within(otherRow).queryByRole('button', { name: '回退为私有 Other Platform Image' })).toBeNull();
  });

  it('deletes a custom image from the cloud tab', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '删除 Blue Team Ubuntu 22.04' }));
    const deleteDialog = screen.getByRole('dialog', { name: '确认删除阿里云自定义镜像' });
    fireEvent.click(within(deleteDialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(deleteCustomImageSnapshotMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'custom-snapshot-1',
      );
    });

    expect(screen.queryByText('Blue Team Ubuntu 22.04')).toBeNull();
  });

  it('changes rendered rows when the page-size selector changes', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? myImagesPayload
        : ({
            items: [
              createPlatformImageAsset({ id: 'platform-1', imageId: 'img-1', displayName: 'Platform Asset 1' }),
              createPlatformImageAsset({ id: 'platform-2', imageId: 'img-2', displayName: 'Platform Asset 2' }),
              createPlatformImageAsset({ id: 'platform-3', imageId: 'img-3', displayName: 'Platform Asset 3' }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );
    fetchCustomImageCatalogScopeMock.mockResolvedValue({
      snapshots: [
        createSnapshot({ id: 'custom-1', scope: 'custom', imageId: 'custom-1', sourceImageName: 'Custom 1' }),
        createSnapshot({ id: 'custom-2', scope: 'custom', imageId: 'custom-2', sourceImageName: 'Custom 2' }),
        createSnapshot({ id: 'custom-3', scope: 'custom', imageId: 'custom-3', sourceImageName: 'Custom 3' }),
      ],
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);
    fetchPublicImageCatalogScopeMock.mockResolvedValue({
      snapshots: [
        createSnapshot({ id: 'public-1', scope: 'public', imageId: 'public-1', sourceImageName: 'Public 1' }),
        createSnapshot({ id: 'public-2', scope: 'public', imageId: 'public-2', sourceImageName: 'Public 2' }),
        createSnapshot({ id: 'public-3', scope: 'public', imageId: 'public-3', sourceImageName: 'Public 3' }),
      ],
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Platform Asset 1')).toBeTruthy();

    const pageSizeSelector = screen.getByRole('combobox', { name: '每页条数' });
    fireEvent.change(pageSizeSelector, { target: { value: '50' } });

    expect(await screen.findByText('Platform Asset 3')).toBeTruthy();
  });

  it('uses page number controls to switch pages on the active tab', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? myImagesPayload
        : ({
            items: Array.from({ length: 51 }, (_, index) =>
              createPlatformImageAsset({
                id: `platform-${index + 1}`,
                imageId: `img-${index + 1}`,
                displayName: `Platform Asset ${index + 1}`,
              }),
            ),
          } satisfies PlatformImageAssetListPayload),
    );
    fetchCustomImageCatalogScopeMock.mockResolvedValue({
      snapshots: Array.from({ length: 51 }, (_, index) =>
        createSnapshot({
          id: `custom-${index + 1}`,
          scope: 'custom',
          imageId: `custom-${index + 1}`,
          sourceImageName: `Custom ${index + 1}`,
        }),
      ),
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Platform Asset 1')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: '每页条数' }), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));

    expect(await screen.findByText('Platform Asset 51')).toBeTruthy();
    expect(screen.queryByText('Platform Asset 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Custom 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));
    expect(await screen.findByText('Custom 51')).toBeTruthy();
  });

  it('jumps to a page number from the jump-to-page input', async () => {
    fetchPublicImageCatalogScopeMock.mockResolvedValue({
      snapshots: [
        createSnapshot({ id: 'public-1', scope: 'public', imageId: 'public-1', sourceImageName: 'Public 1' }),
        createSnapshot({ id: 'public-2', scope: 'public', imageId: 'public-2', sourceImageName: 'Public 2' }),
        createSnapshot({ id: 'public-3', scope: 'public', imageId: 'public-3', sourceImageName: 'Public 3' }),
        createSnapshot({ id: 'public-4', scope: 'public', imageId: 'public-4', sourceImageName: 'Public 4' }),
        createSnapshot({ id: 'public-5', scope: 'public', imageId: 'public-5', sourceImageName: 'Public 5' }),
      ],
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    expect(await screen.findByText('Public 1')).toBeTruthy();

    fireEvent.change(screen.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(await screen.findByText('Public 5')).toBeTruthy();
    expect(screen.queryByText('Public 1')).toBeNull();
  });

  it('logs out when sync or collect receives a 401 response after initial load', async () => {
    syncPublicImagesMock.mockRejectedValue(new AdminApiError(401, 'session expired'));
    collectPlatformImageMock.mockRejectedValue(new AdminApiError(401, 'session expired'));

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    fireEvent.click(await screen.findByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    fireEvent.click(await screen.findByRole('button', { name: '收录到平台 Blue Team Ubuntu 22.04' }));

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

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    resolvePublicScope?.(publicScopePayload);

    await waitFor(() => {
      expect(screen.getByText('Ubuntu 24.04 LTS')).toBeTruthy();
    });

    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
  });

  it('filters the active tab by image name or image id', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '云上镜像来源' }));
    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '筛选镜像名' }), {
      target: { value: 'm-custom-001' },
    });

    expect(screen.getByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
  });

  it('hides platform collection and platform management actions from ordinary users', async () => {
    sessionState.profile = {
      id: 'user-1',
      username: 'alice',
      role: 'user',
    };
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({
            items: [
              createPlatformImageAsset({
                id: 'my-image-1',
                imageId: 'm-owned-001',
                displayName: 'My Ubuntu 22.04',
                sourceSnapshotId: 'custom-snapshot-1',
                sourceScope: 'custom',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload)
        : ({
            items: [
              createPlatformImageAsset({
                id: 'platform-image-1',
                imageId: 'm-platform-001',
                displayName: 'Shared Ubuntu 22.04',
                sourceSnapshotId: 'public-snapshot-1',
                sourceScope: 'public',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('button', { name: '平台镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我的镜像' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '云上镜像来源' })).toBeNull();
    expect(fetchCustomImageCatalogScopeMock).not.toHaveBeenCalled();
    expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();

    expect(screen.queryByRole('button', { name: /重命名 Shared Ubuntu 22\.04/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /禁用 Shared Ubuntu 22\.04/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除 Shared Ubuntu 22\.04/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '我的镜像' }));
    expect(await screen.findByRole('button', { name: '更多操作' })).toBeTruthy();
  });

  it('still lets ordinary owners manage their own published image from 平台镜像', async () => {
    sessionState.profile = {
      id: 'user-1',
      username: 'alice',
      role: 'user',
    };
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({
            items: [
              createPlatformImageAsset({
                id: 'owner-image-1',
                imageId: 'm-owned-001',
                displayName: 'Alice Shared Ubuntu',
                ownerUserId: 'user-1',
                sourceSnapshotId: 'custom-snapshot-1',
                sourceScope: 'custom',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload)
        : ({
            items: [
              createPlatformImageAsset({
                id: 'owner-image-1',
                imageId: 'm-owned-001',
                displayName: 'Alice Shared Ubuntu',
                ownerUserId: 'user-1',
                sourceSnapshotId: 'custom-snapshot-1',
                sourceScope: 'custom',
                enabled: true,
              }),
              createPlatformImageAsset({
                id: 'platform-image-2',
                imageId: 'm-platform-002',
                displayName: 'Other Shared Ubuntu',
                ownerUserId: 'user-2',
                sourceSnapshotId: 'public-snapshot-1',
                sourceScope: 'public',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '平台镜像' }));

    const ownedRow = (await screen.findByText('Alice Shared Ubuntu')).closest('article') as HTMLElement;
    expect(within(ownedRow).queryByRole('button', { name: '重命名 Alice Shared Ubuntu' })).toBeNull();
    fireEvent.click(within(ownedRow).getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('button', { name: '重命名' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '禁用' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();

    const otherRow = screen.getByText('Other Shared Ubuntu').closest('article') as HTMLElement;
    expect(within(otherRow).queryByRole('button', { name: '回退为私有 Other Shared Ubuntu' })).toBeNull();
  });
});
