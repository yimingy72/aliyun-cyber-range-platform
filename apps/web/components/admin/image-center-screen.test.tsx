import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminApiError } from '../../lib/admin-api';
import { ADMIN_PAGE_SIZE_STORAGE_KEY } from './admin-pagination';
import type {
  ImageCatalogItem,
  ImageCatalogScopePayload,
  ImageSnapshot,
  PlatformImageAsset,
  PlatformImageAssetListPayload,
} from '../../lib/admin-types';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

const {
  fetchPublicImageCatalogScopeMock,
  fetchCustomImageCatalogScopeMock,
  fetchPlatformImagesMock,
  fetchPlatformImageTagsMock,
  fetchCloudAccountContextsMock,
  fetchImageImportJobsMock,
  createImageImportMock,
  completeImageImportMock,
  retryImageImportMock,
  syncPublicImagesMock,
  syncCustomImagesMock,
  collectPlatformImageMock,
  createPlatformImageTagMock,
  renamePlatformImageMock,
  publishPlatformImageMock,
  unpublishPlatformImageMock,
  enablePlatformImageMock,
  disablePlatformImageMock,
  removePlatformImageMock,
  setPlatformImageTagsMock,
  deleteCustomImageSnapshotMock,
  logoutMock,
  pushMock,
  sessionState,
} = vi.hoisted(() => ({
  fetchPublicImageCatalogScopeMock: vi.fn(),
  fetchCustomImageCatalogScopeMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  fetchPlatformImageTagsMock: vi.fn(),
  fetchCloudAccountContextsMock: vi.fn(),
  fetchImageImportJobsMock: vi.fn(),
  createImageImportMock: vi.fn(),
  completeImageImportMock: vi.fn(),
  retryImageImportMock: vi.fn(),
  syncPublicImagesMock: vi.fn(),
  syncCustomImagesMock: vi.fn(),
  collectPlatformImageMock: vi.fn(),
  createPlatformImageTagMock: vi.fn(),
  renamePlatformImageMock: vi.fn(),
  publishPlatformImageMock: vi.fn(),
  unpublishPlatformImageMock: vi.fn(),
  enablePlatformImageMock: vi.fn(),
  disablePlatformImageMock: vi.fn(),
  removePlatformImageMock: vi.fn(),
  setPlatformImageTagsMock: vi.fn(),
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
    fetchPlatformImageTags: fetchPlatformImageTagsMock,
    fetchCloudAccountContexts: fetchCloudAccountContextsMock,
    fetchImageImportJobs: fetchImageImportJobsMock,
    createImageImport: createImageImportMock,
    completeImageImport: completeImageImportMock,
    retryImageImport: retryImageImportMock,
    syncPublicImages: syncPublicImagesMock,
    syncCustomImages: syncCustomImagesMock,
    collectPlatformImage: collectPlatformImageMock,
    createPlatformImageTag: createPlatformImageTagMock,
    renamePlatformImage: renamePlatformImageMock,
    publishPlatformImage: publishPlatformImageMock,
    unpublishPlatformImage: unpublishPlatformImageMock,
    enablePlatformImage: enablePlatformImageMock,
    disablePlatformImage: disablePlatformImageMock,
    removePlatformImage: removePlatformImageMock,
    setPlatformImageTags: setPlatformImageTagsMock,
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
    tags: [],
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
  window.localStorage.removeItem(ADMIN_PAGE_SIZE_STORAGE_KEY);
  fetchPublicImageCatalogScopeMock.mockReset();
  fetchCustomImageCatalogScopeMock.mockReset();
  fetchPlatformImagesMock.mockReset();
  fetchPlatformImageTagsMock.mockReset();
  fetchCloudAccountContextsMock.mockReset();
  fetchImageImportJobsMock.mockReset();
  createImageImportMock.mockReset();
  completeImageImportMock.mockReset();
  retryImageImportMock.mockReset();
  syncPublicImagesMock.mockReset();
  syncCustomImagesMock.mockReset();
  collectPlatformImageMock.mockReset();
  createPlatformImageTagMock.mockReset();
  renamePlatformImageMock.mockReset();
  publishPlatformImageMock.mockReset();
  unpublishPlatformImageMock.mockReset();
  enablePlatformImageMock.mockReset();
  disablePlatformImageMock.mockReset();
  removePlatformImageMock.mockReset();
  setPlatformImageTagsMock.mockReset();
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
  fetchCloudAccountContextsMock.mockResolvedValue([
    {
      id: 'cloud-context-1',
      displayName: '测试阿里云账号',
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      imageImportBucket: 'cyber-range-image-test',
      isActive: true,
      status: 'ready',
      bucketStatus: 'ready',
    },
  ]);
  fetchImageImportJobsMock.mockResolvedValue({ items: [] });
  fetchPlatformImageTagsMock.mockResolvedValue({
    items: [{ id: 'tag-critical', name: '关键资产' }],
  });
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
  createPlatformImageTagMock.mockResolvedValue({ id: 'tag-new', name: '渗透测试' });
  setPlatformImageTagsMock.mockResolvedValue(
    createPlatformImageAsset({
      id: 'platform-image-1',
      imageId: 'aliyun-linux-3',
      displayName: 'Alibaba Cloud Linux 3',
      createdBy: 'admin',
      sourceSnapshotId: 'public-snapshot-1',
      sourceScope: 'public',
      enabled: true,
      tags: [
        { id: 'tag-critical', name: '关键资产' },
        { id: 'tag-new', name: '渗透测试' },
      ],
    }),
  );
  deleteCustomImageSnapshotMock.mockResolvedValue(undefined);

});

afterEach(() => {
  cleanup();
});

describe('ImageCenterScreen', () => {
  it('keeps the active tab table frame and domain headers when the platform image list is empty', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine' ? myImagesPayload : ({ items: [] } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('当前没有平台镜像。')).toBeTruthy();

    const table = screen.getByRole('table', { name: '平台镜像' });
    expect(within(table).getByRole('columnheader', { name: '镜像名' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '镜像 ID' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '创建人' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '标签' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '操作' })).toBeTruthy();
    expect(within(table).getByText('当前没有平台镜像。')).toBeTruthy();
  });

  it('only renders nested cloud tab panels for cloud source views', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const platformPanel = await screen.findByRole('tabpanel', { name: '平台镜像' });
    expect(within(platformPanel).queryByRole('tabpanel')).toBeNull();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

    fireEvent.mouseDown(screen.getByRole('tab', { name: '我的镜像' }));

    const minePanel = await screen.findByRole('tabpanel', { name: '我的镜像' });
    expect(within(minePanel).queryByRole('tabpanel')).toBeNull();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

    fireEvent.mouseDown(screen.getByRole('tab', { name: '云上镜像来源' }));

    const cloudPanel = await screen.findByRole('tabpanel', { name: '云上镜像来源' });
    expect(within(cloudPanel).getByRole('tabpanel', { name: '阿里云自定义镜像' })).toBeTruthy();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(2);
  });

  it('renders 平台镜像 / 我的镜像 / 云上镜像来源 and loads all payloads', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('tab', { name: '平台镜像' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我的镜像' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '云上镜像来源' })).toBeTruthy();
    expect(screen.getByTestId('admin-list-toolbar-view-action').className).not.toContain('w-36');
    expect(screen.getByText('Alibaba Cloud Linux 3')).toBeTruthy();
    expect(screen.getByText('创建人')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();

    const platformWidths = Array.from(screen.getByRole('table', { name: '平台镜像' }).querySelectorAll('col')).map((column) =>
      column.getAttribute('style'),
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: '我的镜像' }));
    expect(await screen.findByText('My Ubuntu 22.04')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();

    const mineWidths = Array.from(screen.getByRole('table', { name: '我的镜像' }).querySelectorAll('col')).map((column) =>
      column.getAttribute('style'),
    );

    expect(mineWidths).toEqual(platformWidths);
    expect(platformWidths.at(-1) ?? '').toContain('width: 11rem');

    fireEvent.mouseDown(screen.getByRole('tab', { name: '云上镜像来源' }));
    expect(await screen.findByRole('tab', { name: '阿里云自定义镜像' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '阿里云公共镜像' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '同步镜像' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '同步自定义镜像' })).toBeNull();

    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'platform');
    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'mine');
    expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();
  });

  it('filters platform images by creator and existing tag', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? myImagesPayload
        : ({
            items: [
              createPlatformImageAsset({
                id: 'platform-image-alice',
                imageId: 'm-alice',
                displayName: 'Alice Linux',
                createdBy: 'alice',
                tags: [{ id: 'tag-critical', name: '关键资产' }],
              }),
              createPlatformImageAsset({
                id: 'platform-image-bob',
                imageId: 'm-bob',
                displayName: 'Bob Linux',
                createdBy: 'bob',
                tags: [],
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Alice Linux')).toBeTruthy();
    expect(screen.getByText('关键资产')).toBeTruthy();
    expect(screen.getByText('Bob Linux')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('combobox', { name: '按创建人筛选' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'alice' }));

    expect(screen.getByText('Alice Linux')).toBeTruthy();
    expect(screen.queryByText('Bob Linux')).toBeNull();

    fireEvent.keyDown(screen.getByRole('combobox', { name: '按标签筛选' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '关键资产' }));

    expect(screen.getByText('Alice Linux')).toBeTruthy();
  });

  it('filters 我的镜像 by existing tag', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({
            items: [
              createPlatformImageAsset({
                id: 'my-image-critical',
                imageId: 'm-my-critical',
                displayName: 'My Critical Ubuntu',
                createdBy: 'admin',
                tags: [{ id: 'tag-critical', name: '关键资产' }],
              }),
              createPlatformImageAsset({
                id: 'my-image-base',
                imageId: 'm-my-base',
                displayName: 'My Base Ubuntu',
                createdBy: 'admin',
                tags: [],
              }),
            ],
          } satisfies PlatformImageAssetListPayload)
        : platformImagesPayload,
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));
    expect(await screen.findByText('My Critical Ubuntu')).toBeTruthy();
    expect(screen.getByText('My Base Ubuntu')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('combobox', { name: '按标签筛选' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '关键资产' }));

    expect(screen.getByText('My Critical Ubuntu')).toBeTruthy();
    expect(screen.queryByText('My Base Ubuntu')).toBeNull();
  });

  it('lets admins create and assign image tags from the inline tag dropdown', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const imageRow = (await screen.findByText('Alibaba Cloud Linux 3')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(imageRow).getByRole('button', { name: '编辑标签 Alibaba Cloud Linux 3' }), {
      key: 'ArrowDown',
    });

    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: '关键资产' }));
    fireEvent.change(within(menu).getByLabelText('新标签名称 Alibaba Cloud Linux 3'), { target: { value: '渗透测试' } });
    fireEvent.click(within(menu).getByRole('button', { name: '新建标签 Alibaba Cloud Linux 3' }));

    await waitFor(() => {
      expect(createPlatformImageTagMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', '渗透测试');
    });

    expect(within(menu).getByRole('menuitemcheckbox', { name: '渗透测试' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: '保存标签' }));

    await waitFor(() => {
      expect(setPlatformImageTagsMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-1',
        ['tag-critical', 'tag-new'],
      );
    });

    expect(await screen.findByText('渗透测试')).toBeTruthy();
  });

  it('only lets ordinary owners edit tags from 我的镜像 and does not expose tag creation', async () => {
    sessionState.profile = {
      id: 'owner-user',
      username: 'owner',
      role: 'user',
    };
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      ({
        items: [
          createPlatformImageAsset({
            id: 'owner-image-1',
            imageId: 'm-owner-001',
            displayName: 'Owner Ubuntu',
            ownerUserId: 'owner-user',
            createdBy: 'owner',
            canManage: true,
            visibility: 'platform',
          }),
        ],
      } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const platformRow = (await screen.findByText('Owner Ubuntu')).closest('tr') as HTMLElement;
    expect(within(platformRow).queryByRole('button', { name: '编辑标签 Owner Ubuntu' })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '我的镜像' }));
    const myImageRow = (await screen.findByText('Owner Ubuntu')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(myImageRow).getByRole('button', { name: '编辑标签 Owner Ubuntu' }), {
      key: 'ArrowDown',
    });

    const menu = screen.getByRole('menu');
    expect(within(menu).queryByLabelText('新标签名称 Owner Ubuntu')).toBeNull();
    expect(within(menu).queryByRole('button', { name: '新建标签 Owner Ubuntu' })).toBeNull();

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: '关键资产' }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: '保存标签' }));

    await waitFor(() => {
      expect(setPlatformImageTagsMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'owner-image-1',
        ['tag-critical'],
      );
    });
  });

  it('lets administrators edit tags on their own images from 我的镜像 without exposing tag creation', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      ({
        items: [
          createPlatformImageAsset({
            id: 'admin-image-1',
            imageId: 'm-admin-001',
            displayName: 'Admin Private Ubuntu',
            ownerUserId: 'admin-user',
            createdBy: 'admin',
            canManage: true,
            visibility: view === 'mine' ? 'private' : 'platform',
          }),
        ],
      } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    const myImageRow = (await screen.findByText('Admin Private Ubuntu')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(myImageRow).getByRole('button', { name: '编辑标签 Admin Private Ubuntu' }), {
      key: 'ArrowDown',
    });

    const menu = screen.getByRole('menu');
    expect(within(menu).queryByLabelText('新标签名称 Admin Private Ubuntu')).toBeNull();
    expect(within(menu).queryByRole('button', { name: '新建标签 Admin Private Ubuntu' })).toBeNull();

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: '关键资产' }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: '保存标签' }));

    await waitFor(() => {
      expect(setPlatformImageTagsMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'admin-image-1',
        ['tag-critical'],
      );
    });
  });

  it('lazy-loads cloud image source tabs only when they are opened', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Alibaba Cloud Linux 3')).toBeTruthy();
    expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledTimes(0);
    expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledTimes(0);

    fireEvent.mouseDown(screen.getByRole('tab', { name: '云上镜像来源' }));

    await waitFor(() => {
      expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云公共镜像' }));
    await waitFor(() => {
      expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledTimes(1);
    });
  });

  it('opens an accessible local image upload form from 我的镜像', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));
    fireEvent.click(await screen.findByRole('button', { name: '上传镜像' }));

    const dialog = screen.getByRole('dialog', { name: '上传本地镜像' });
    expect(dialog.querySelector('select[aria-label]')).toBeNull();
    expect(within(dialog).getByLabelText('系统盘镜像文件')).toBeTruthy();
    expect(within(dialog).getByLabelText('上传镜像名')).toBeTruthy();
    expect(within(dialog).getByLabelText('上传镜像默认主机名')).toBeTruthy();
    expect(within(dialog).getByLabelText('上传镜像默认登录密码')).toBeTruthy();
    expect(within(dialog).getByLabelText('上传镜像备注')).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: '上传镜像操作系统' })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: '上传镜像架构' })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: '上传镜像启动模式' })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: '上传镜像格式' })).toBeTruthy();
    expect(screen.getByText('文件会直接上传到当前云账号的私有 OSS Bucket，再由阿里云导入为自定义镜像。主机名和密码会作为后续创建实例的默认值，不会修改原始镜像文件。')).toBeTruthy();
  });

  it('opens the same local image upload form from 平台镜像', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '上传镜像' }));

    expect(screen.getByRole('dialog', { name: '上传本地镜像' })).toBeTruthy();
  });

  it('disables image upload when the active cloud account has no custom import Bucket', async () => {
    fetchCloudAccountContextsMock.mockResolvedValue([
      {
        id: 'cloud-context-1',
        displayName: '测试阿里云账号',
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        imageImportBucket: '',
        isActive: true,
        status: 'ready',
        bucketStatus: 'unconfigured',
      },
    ]);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    const uploadButton = await screen.findByRole('button', { name: '上传镜像' });
    expect((uploadButton as HTMLButtonElement).disabled).toBe(true);
    expect(uploadButton.getAttribute('title')).toBe('当前阿里云账号未配置镜像导入 Bucket，请先在云配置中填写自定义 OSS 存储桶名。');
  });

  it('disables image upload when the configured import Bucket is unavailable', async () => {
    fetchCloudAccountContextsMock.mockResolvedValue([
      {
        id: 'cloud-context-1',
        displayName: '测试阿里云账号',
        provider: 'alibaba_cloud',
        accountUid: '1234567890',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-h',
        imageImportBucket: 'missing-image-imports',
        isActive: true,
        status: 'ready',
        bucketStatus: 'unavailable',
        lastError: '无法验证镜像导入 Bucket 的对象读取权限（HTTP 403）。',
      },
    ]);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    const uploadButton = await screen.findByRole('button', { name: '上传镜像' });
    expect((uploadButton as HTMLButtonElement).disabled).toBe(true);
    expect(uploadButton.getAttribute('title')).toBe('无法验证镜像导入 Bucket 的对象读取权限（HTTP 403）。');
  });

  it('creates a direct-OSS upload session and completes the Alibaba Cloud import after a file upload', async () => {
    const openUpload = vi.fn();
    const setUploadHeader = vi.fn();
    const sendUpload = vi.fn();
    class SuccessfulXmlHttpRequest {
      status = 200;
      upload: {
        onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
      } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      open = openUpload;
      setRequestHeader = setUploadHeader;
      send(file: File) {
        sendUpload(file);
        this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
        this.onload?.();
      }
    }

    const createdJob = {
      id: 'image-import-job-1',
      cloudAccountContextId: 'cloud-context-1',
      ownerUserId: 'admin-user',
      displayName: 'ubuntu',
      osType: 'linux',
      architecture: 'x86_64',
      bootMode: 'BIOS',
      imageFormat: 'raw',
      systemDiskSize: 40,
      sourceFileName: 'ubuntu.raw',
      sourceContentType: 'application/octet-stream',
      sourceSizeBytes: 4,
      uploadExpiresAt: '2026-07-20T00:30:00.000Z',
      status: 'awaiting_upload' as const,
    };
    createImageImportMock.mockResolvedValue({
      job: createdJob,
      upload: {
        method: 'PUT',
        url: 'https://example.oss-cn-hangzhou.aliyuncs.com/image-imports/ubuntu.raw',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: '2026-07-20T00:30:00.000Z',
      },
    });
    completeImageImportMock.mockResolvedValue({
      ...createdJob,
      status: 'importing',
      imageId: 'm-importing-image',
      platformImageAssetId: 'my-image-importing-1',
    });
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine'
        ? ({
            items: [
              createPlatformImageAsset({
                id: 'my-image-importing-1',
                imageId: 'm-importing-image',
                displayName: 'ubuntu',
                createdBy: 'admin',
                sourceSnapshotId: 'custom-snapshot-importing-1',
                sourceScope: 'custom',
                sourceSnapshotStatus: 'Creating 65%',
                sourceSnapshotAvailable: false,
                enabled: false,
              }),
            ],
          } satisfies PlatformImageAssetListPayload)
        : platformImagesPayload,
    );
    vi.stubGlobal('XMLHttpRequest', SuccessfulXmlHttpRequest);

    try {
      render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));
      fireEvent.click(await screen.findByRole('button', { name: '上传镜像' }));
      fireEvent.change(screen.getByLabelText('系统盘镜像文件'), {
        target: { files: [new File(['disk'], 'ubuntu.raw', { type: 'application/octet-stream' })] },
      });
      fireEvent.click(screen.getByRole('combobox', { name: '上传镜像操作系统' }));
      fireEvent.click(screen.getByRole('option', { name: 'Windows' }));
      fireEvent.click(screen.getByRole('combobox', { name: '上传镜像架构' }));
      fireEvent.click(screen.getByRole('option', { name: 'arm64' }));
      fireEvent.click(screen.getByRole('combobox', { name: '上传镜像启动模式' }));
      fireEvent.click(screen.getByRole('option', { name: 'UEFI' }));
      fireEvent.click(screen.getByRole('combobox', { name: '上传镜像格式' }));
      fireEvent.click(screen.getByRole('option', { name: 'RAW' }));
      expect(screen.getByRole('combobox', { name: '上传镜像格式' }).textContent).toContain('RAW');
      const submitButton = screen.getByRole('button', { name: '上传并导入' });
      expect((submitButton as HTMLButtonElement).form?.id).toBe('image-import-form');
      // Synthetic files in jsdom do not satisfy native file-input validation; submit the associated form.
      fireEvent.submit((submitButton as HTMLButtonElement).form!);

      await waitFor(() => {
        expect(createImageImportMock).toHaveBeenCalledWith(
          'http://localhost:3001',
          'dev-admin-token',
          expect.objectContaining({
            cloudContextId: 'cloud-context-1',
            displayName: 'ubuntu',
            osType: 'windows',
            architecture: 'arm64',
            bootMode: 'UEFI',
            imageFormat: 'raw',
            sourceFileName: 'ubuntu.raw',
            sourceSizeBytes: 4,
          }),
        );
      });
      await waitFor(() => {
        expect(completeImageImportMock).toHaveBeenCalledWith(
          'http://localhost:3001',
          'dev-admin-token',
          'image-import-job-1',
        );
      });
      expect(openUpload).toHaveBeenCalledWith('PUT', expect.stringContaining('image-imports/ubuntu.raw'));
      expect(setUploadHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
      expect(sendUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'ubuntu.raw', size: 4 }));
      expect(sendUpload.mock.invocationCallOrder[0]).toBeLessThan(completeImageImportMock.mock.invocationCallOrder[0]);
      expect(await screen.findByText('镜像文件已上传，阿里云正在导入；导入完成后会自动启用“我的镜像”。')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: '上传本地镜像' })).toBeNull();
      expect(await screen.findByText('ubuntu')).toBeTruthy();
      expect(screen.getByText('65%')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a selected import format that does not match the file before creating an upload job', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);
    fireEvent.click(await screen.findByRole('button', { name: '上传镜像' }));
    fireEvent.change(screen.getByLabelText('系统盘镜像文件'), {
      target: { files: [new File(['disk'], 'ubuntu.qcow2', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('combobox', { name: '上传镜像格式' }));
    fireEvent.click(screen.getByRole('option', { name: 'RAW' }));
    fireEvent.submit((screen.getByRole('button', { name: '上传并导入' }) as HTMLButtonElement).form!);
    expect((await screen.findByRole('alert')).textContent).toContain('所选镜像格式与文件扩展名不一致，请选择 QCOW2。');
    expect(createImageImportMock).not.toHaveBeenCalled();
  });

  it('hides fully cleaned cancelled import jobs from 我的镜像', async () => {
    fetchImageImportJobsMock.mockResolvedValue({
      items: [
        {
          id: 'image-import-job-cancelled',
          cloudAccountContextId: 'cloud-context-1',
          ownerUserId: 'admin-user',
          displayName: 'CentOS6.10-阿里云基础镜像',
          osType: 'linux',
          architecture: 'x86_64',
          bootMode: 'BIOS',
          imageFormat: 'qcow2',
          systemDiskSize: 40,
          sourceFileName: 'centos.qcow2',
          sourceContentType: 'application/octet-stream',
          sourceSizeBytes: 4096,
          uploadExpiresAt: '2026-07-20T00:30:00.000Z',
          status: 'cancelled' as const,
          imageId: null,
          taskId: null,
          sourceSnapshotId: null,
          platformImageAssetId: null,
          temporaryObjectDeletedAt: '2026-07-20T00:40:00.000Z',
          errorMessage: '上传地址已过期，临时镜像文件已进入清理流程。',
        },
      ],
    });
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine' ? ({ items: [] } satisfies PlatformImageAssetListPayload) : platformImagesPayload,
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    expect(await screen.findByText('当前没有我的镜像。')).toBeTruthy();
    expect(screen.queryByText('CentOS6.10-阿里云基础镜像')).toBeNull();
    expect(screen.queryByText('上传地址已过期，临时镜像文件已进入清理流程。')).toBeNull();
  });

  it('keeps a matching import task visible when the backend reports a synchronisation error', async () => {
    fetchImageImportJobsMock.mockResolvedValue({
      items: [
        {
          id: 'image-import-job-sync-error',
          cloudAccountContextId: 'cloud-context-1',
          ownerUserId: 'admin-user',
          displayName: 'My Ubuntu 22.04',
          osType: 'linux',
          architecture: 'x86_64',
          bootMode: 'BIOS',
          imageFormat: 'qcow2',
          systemDiskSize: 40,
          sourceFileName: 'ubuntu.qcow2',
          sourceContentType: 'application/octet-stream',
          sourceSizeBytes: 4096,
          uploadExpiresAt: '2026-07-20T00:30:00.000Z',
          status: 'importing' as const,
          imageId: 'm-owned-001',
          platformImageAssetId: 'my-image-1',
          errorMessage: 'asset update unavailable',
        },
      ],
    });

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    await screen.findAllByText('My Ubuntu 22.04');
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('asset update unavailable');
    });
  });

  it('keeps an available task visible until its temporary OSS cleanup succeeds', async () => {
    fetchImageImportJobsMock.mockResolvedValue({
      items: [
        {
          id: 'image-import-job-cleanup',
          cloudAccountContextId: 'cloud-context-1',
          ownerUserId: 'admin-user',
          displayName: 'My Ubuntu 22.04',
          osType: 'linux',
          architecture: 'x86_64',
          bootMode: 'BIOS',
          imageFormat: 'qcow2',
          systemDiskSize: 40,
          sourceFileName: 'ubuntu.qcow2',
          sourceContentType: 'application/octet-stream',
          sourceSizeBytes: 4096,
          uploadExpiresAt: '2026-07-20T00:30:00.000Z',
          status: 'available' as const,
          imageId: 'm-owned-001',
          platformImageAssetId: 'my-image-1',
          temporaryObjectDeletedAt: null,
          errorMessage: '临时 OSS 文件清理失败：删除 OSS 临时镜像文件失败。',
        },
      ],
    });

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    await screen.findAllByText('My Ubuntu 22.04');
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('临时 OSS 文件清理失败');
    });
  });

  it('does not let a delayed initial import-task response replace a newer 我的镜像 refresh', async () => {
    let resolveInitialJobs: ((value: { items: [] }) => void) | undefined;
    const initialJobs = new Promise<{ items: [] }>((resolve) => {
      resolveInitialJobs = resolve;
    });
    const currentJob = {
      id: 'image-import-job-current',
      cloudAccountContextId: 'cloud-context-1',
      ownerUserId: 'admin-user',
      displayName: 'Current Import',
      osType: 'linux',
      architecture: 'x86_64',
      bootMode: 'BIOS',
      imageFormat: 'qcow2',
      systemDiskSize: 40,
      sourceFileName: 'current.qcow2',
      sourceContentType: 'application/octet-stream',
      sourceSizeBytes: 4096,
      uploadExpiresAt: '2026-07-20T00:30:00.000Z',
      status: 'importing' as const,
      imageId: 'm-current-import',
      errorMessage: null,
    };
    fetchImageImportJobsMock.mockImplementationOnce(() => initialJobs).mockResolvedValue({ items: [currentJob] });

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));
    expect(await screen.findByText('Current Import')).toBeTruthy();

    resolveInitialJobs?.({ items: [] });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(screen.getByText('Current Import')).toBeTruthy();
  });

  it('keeps my image rows during a failed import poll and revises the table body after a successful retry', async () => {
    let rejectPoll: ((error: Error) => void) | undefined;
    let mineRequestCount = 0;
    const importingJob = {
      id: 'image-import-job-poll-failure',
      cloudAccountContextId: 'cloud-context-1',
      ownerUserId: 'admin-user',
      displayName: 'Polling Ubuntu',
      osType: 'linux' as const,
      architecture: 'x86_64' as const,
      bootMode: 'BIOS' as const,
      imageFormat: 'qcow2' as const,
      systemDiskSize: 40,
      sourceFileName: 'polling-ubuntu.qcow2',
      sourceContentType: 'application/octet-stream',
      sourceSizeBytes: 4096,
      uploadExpiresAt: '2026-07-20T00:30:00.000Z',
      status: 'importing' as const,
      imageId: 'm-owned-001',
      platformImageAssetId: 'my-image-1',
      errorMessage: null,
    };

    fetchImageImportJobsMock
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [importingJob] });
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') => {
      if (view !== 'mine') {
        return platformImagesPayload;
      }

      mineRequestCount += 1;
      if (mineRequestCount === 1) {
        return myImagesPayload;
      }

      if (mineRequestCount === 2) {
        return new Promise<PlatformImageAssetListPayload>((_resolve, reject) => {
          rejectPoll = reject;
        });
      }

      return myImagesPayload;
    });

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    const table = await screen.findByRole('table', { name: '我的镜像' });
    expect(await within(table).findByText('My Ubuntu 22.04')).toBeTruthy();

    await waitFor(() => {
      expect(rejectPoll).toBeTypeOf('function');
      expect(table.getAttribute('aria-busy')).toBe('true');
    });

    rejectPoll?.(new Error('镜像轮询刷新失败'));

    await waitFor(() => {
      expect(within(table).getByText('My Ubuntu 22.04')).toBeTruthy();
      expect(within(table).getByText('镜像轮询刷新失败')).toBeTruthy();
      expect(within(table).getByRole('button', { name: '重试加载我的镜像' })).toBeTruthy();
      expect((within(table).getByRole('cell', { name: /镜像轮询刷新失败/ }) as HTMLTableCellElement).colSpan).toBe(6);
      expect(table.getAttribute('aria-busy')).toBeNull();
    });

    fireEvent.click(within(table).getByRole('button', { name: '重试加载我的镜像' }));

    await waitFor(() => {
      expect(mineRequestCount).toBe(3);
      expect(within(table).queryByText('镜像轮询刷新失败')).toBeNull();
      expect(table.querySelector('tbody')?.className).toContain('admin-data-table-body-enter');
    });
  });

  it('offers a retry action when ImportImage failed before an Alibaba Cloud ImageId was returned', async () => {
    const failedJob = {
      id: 'image-import-job-retry',
      cloudAccountContextId: 'cloud-context-1',
      ownerUserId: 'admin-user',
      displayName: 'Retry Ubuntu',
      osType: 'linux',
      architecture: 'x86_64',
      bootMode: 'BIOS',
      imageFormat: 'qcow2',
      systemDiskSize: 40,
      sourceFileName: 'retry.qcow2',
      sourceContentType: 'application/octet-stream',
      sourceSizeBytes: 4096,
      uploadExpiresAt: '2026-07-20T00:30:00.000Z',
      status: 'failed' as const,
      imageId: null,
      errorMessage: 'Aliyun throttling',
    };
    fetchImageImportJobsMock.mockResolvedValue({ items: [failedJob] });
    retryImageImportMock.mockResolvedValue({ ...failedJob, status: 'importing', errorMessage: null });

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    fireEvent.click(await screen.findByRole('button', { name: '重试导入' }));

    await waitFor(() => {
      expect(retryImageImportMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'image-import-job-retry',
      );
    });
  });

  it('shows importing private images with progress but without destructive asset actions', async () => {
    fetchPlatformImagesMock.mockImplementation(async (_apiBaseUrl: string, _token: string, view: 'platform' | 'mine' = 'platform') =>
      view === 'mine' ? exportingMyImagesPayload : platformImagesPayload,
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    expect(await screen.findByText('Exporting Ubuntu 22.04')).toBeTruthy();
    expect(screen.getByText('65%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建实例 Exporting Ubuntu 22.04' })).toBeNull();
    expect(screen.queryByRole('button', { name: '发布到平台 Exporting Ubuntu 22.04' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
  });

  it('keeps 我的镜像 rows compact by moving rename enable and delete into 更多操作', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));
    expect(await screen.findByText('My Ubuntu 22.04')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例 My Ubuntu 22.04' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发布到平台 My Ubuntu 22.04' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重命名 My Ubuntu 22.04' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });

    expect(screen.getByRole('menuitem', { name: '发布到平台' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '禁用' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy();
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
                canManage: true,
                visibility: 'platform',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Owned Platform Image')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例 Owned Platform Image' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '回退为私有 Owned Platform Image' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重命名 Owned Platform Image' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });

    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '禁用' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy();
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

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
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

    fireEvent.mouseDown(screen.getByRole('tab', { name: '平台镜像' }));
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

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
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

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云公共镜像' }));
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

    const platformTab = await screen.findByRole('tab', { name: '平台镜像' });
    fireEvent.click(platformTab);

    const enabledRow = (await screen.findByText('Blue Team Ubuntu 22.04')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(enabledRow).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
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

    const renamedRow = (await screen.findByText('Blue Team Ubuntu 22.04 Renamed')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(renamedRow).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '禁用' }));

    await waitFor(() => {
      expect(disablePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-1',
      );
    });

    const disabledRow = (await screen.findByText('Disabled Platform Image')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(disabledRow).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '启用' }));

    await waitFor(() => {
      expect(enablePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-2',
      );
    });

    const enabledRowAgain = (await screen.findByText('Disabled Platform Image')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(enabledRowAgain).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
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

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '我的镜像' }));

    const privateImageRow = (await screen.findByText('My Ubuntu 22.04')).closest('tr') as HTMLElement;
    fireEvent.keyDown(within(privateImageRow).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });

    fireEvent.click(await screen.findByRole('menuitem', { name: '发布到平台' }));
    await waitFor(() => {
      expect(publishPlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'my-image-1',
      );
    });

    const publishedImageRow = screen.getByText('My Published Ubuntu 22.04').closest('tr') as HTMLElement;
    fireEvent.keyDown(within(publishedImageRow).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });

    fireEvent.click(await screen.findByRole('menuitem', { name: '回退为私有' }));
    await waitFor(() => {
      expect(unpublishPlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'my-image-2',
      );
    });
  });

  it('does not show publish or unpublish actions to ordinary owners', async () => {
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

    const ownedRow = (await screen.findByText('Owned Platform Image')).closest('tr') as HTMLElement;
    expect(within(ownedRow).queryByRole('button', { name: '回退为私有 Owned Platform Image' })).toBeNull();

    const otherRow = screen.getByText('Other Platform Image').closest('tr') as HTMLElement;
    expect(within(otherRow).queryByRole('button', { name: '回退为私有 Other Platform Image' })).toBeNull();
  });

  it('deletes a custom image from the cloud tab', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
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
    fireEvent.keyDown(pageSizeSelector, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '50 条' }));

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
    fireEvent.keyDown(screen.getByRole('combobox', { name: '每页条数' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: '50 条' }));
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));

    expect(await screen.findByText('Platform Asset 51')).toBeTruthy();
    expect(screen.queryByText('Platform Asset 1')).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Custom 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));
    expect(await screen.findByText('Custom 51')).toBeTruthy();
  });

  it('jumps to a page number from the jump-to-page input', async () => {
    fetchPublicImageCatalogScopeMock.mockResolvedValue({
      snapshots: Array.from({ length: 45 }, (_, index) => createSnapshot({
        id: `public-${index + 1}`, scope: 'public', imageId: `public-${index + 1}`, sourceImageName: `Public ${index + 1}`,
      })),
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云公共镜像' }));
    expect(await screen.findByText('Public 1')).toBeTruthy();

    fireEvent.change(screen.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(await screen.findByText('Public 41')).toBeTruthy();
    expect(screen.queryByText('Public 1')).toBeNull();
    expect(screen.getByRole('button', { name: '第 3 页' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));
    expect(screen.getByText('Public 41')).toBeTruthy();
  });

  it('logs out when sync or collect receives a 401 response after initial load', async () => {
    syncPublicImagesMock.mockRejectedValue(new AdminApiError(401, 'session expired'));
    collectPlatformImageMock.mockRejectedValue(new AdminApiError(401, 'session expired'));

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云公共镜像' }));
    fireEvent.click(await screen.findByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
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

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云公共镜像' }));
    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    resolvePublicScope?.(publicScopePayload);

    await waitFor(() => {
      expect(screen.getByText('Ubuntu 24.04 LTS')).toBeTruthy();
    });

    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
  });

  it('filters the active tab by image name or image id', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '云上镜像来源' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: '筛选镜像名' }), {
      target: { value: 'm-custom-001' },
    });

    expect(screen.getByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '阿里云公共镜像' }));
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

    expect(await screen.findByRole('tab', { name: '平台镜像' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我的镜像' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '云上镜像来源' })).toBeNull();
    expect(fetchCustomImageCatalogScopeMock).not.toHaveBeenCalled();
    expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();

    expect(screen.queryByRole('button', { name: /重命名 Shared Ubuntu 22\.04/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /禁用 Shared Ubuntu 22\.04/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除 Shared Ubuntu 22\.04/ })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: '我的镜像' }));
    expect(await screen.findByRole('button', { name: '更多操作' })).toBeTruthy();
  });

  it('still lets ordinary owners manage their own published image from 平台镜像', async () => {
    sessionState.profile = {
      id: 'oidc-subject-alice',
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
                ownerUserId: 'platform-user-alice',
                canManage: true,
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
                ownerUserId: 'platform-user-alice',
                canManage: true,
                sourceSnapshotId: 'custom-snapshot-1',
                sourceScope: 'custom',
                enabled: true,
              }),
              createPlatformImageAsset({
                id: 'platform-image-2',
                imageId: 'm-platform-002',
                displayName: 'Other Shared Ubuntu',
                ownerUserId: 'user-2',
                canManage: false,
                sourceSnapshotId: 'public-snapshot-1',
                sourceScope: 'public',
                enabled: true,
              }),
            ],
          } satisfies PlatformImageAssetListPayload),
    );

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '平台镜像' }));

    const ownedRow = (await screen.findByText('Alice Shared Ubuntu')).closest('tr') as HTMLElement;
    expect(within(ownedRow).queryByRole('button', { name: '重命名 Alice Shared Ubuntu' })).toBeNull();
    fireEvent.keyDown(within(ownedRow).getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '禁用' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy();

    const otherRow = screen.getByText('Other Shared Ubuntu').closest('tr') as HTMLElement;
    expect(within(otherRow).queryByRole('button', { name: '回退为私有 Other Shared Ubuntu' })).toBeNull();
  });
});
