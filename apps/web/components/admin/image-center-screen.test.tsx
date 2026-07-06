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
  collectImageCatalogItemMock,
  renamePlatformImageMock,
  enablePlatformImageMock,
  disablePlatformImageMock,
  removePlatformImageMock,
  deleteCustomImageSnapshotMock,
  logoutMock,
  promptMock,
  confirmMock,
} = vi.hoisted(() => ({
  fetchPublicImageCatalogScopeMock: vi.fn(),
  fetchCustomImageCatalogScopeMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  syncPublicImagesMock: vi.fn(),
  syncCustomImagesMock: vi.fn(),
  collectImageCatalogItemMock: vi.fn(),
  renamePlatformImageMock: vi.fn(),
  enablePlatformImageMock: vi.fn(),
  disablePlatformImageMock: vi.fn(),
  removePlatformImageMock: vi.fn(),
  deleteCustomImageSnapshotMock: vi.fn(),
  logoutMock: vi.fn(),
  promptMock: vi.fn(),
  confirmMock: vi.fn(),
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
    renamePlatformImage: renamePlatformImageMock,
    enablePlatformImage: enablePlatformImageMock,
    disablePlatformImage: disablePlatformImageMock,
    removePlatformImage: removePlatformImageMock,
    deleteCustomImageSnapshot: deleteCustomImageSnapshotMock,
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
      imageId: 'm-custom-001',
      displayName: 'Blue Team Ubuntu 22.04',
      sourceSnapshotId: 'custom-snapshot-1',
      sourceScope: 'custom',
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
  collectImageCatalogItemMock.mockReset();
  renamePlatformImageMock.mockReset();
  enablePlatformImageMock.mockReset();
  disablePlatformImageMock.mockReset();
  removePlatformImageMock.mockReset();
  deleteCustomImageSnapshotMock.mockReset();
  logoutMock.mockReset();
  promptMock.mockReset();
  confirmMock.mockReset();

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

  vi.stubGlobal('prompt', promptMock);
  vi.stubGlobal('confirm', confirmMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ImageCenterScreen', () => {
  it('renders tabs in the approved order and loads all three payloads', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const tabs = await screen.findAllByRole('button', {
      name: /平台收录镜像|阿里云自定义镜像|阿里云公共镜像/,
    });

    expect(tabs.map((tab) => tab.textContent)).toEqual([
      '平台收录镜像',
      '阿里云自定义镜像',
      '阿里云公共镜像',
    ]);
    expect(screen.getByText('Blue Team Ubuntu 22.04')).toBeTruthy();
    expect(fetchPlatformImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
  });

  it('collects a custom snapshot and then shows it as already collected on the source tab', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收录到目录 Blue Team Ubuntu 22.04' }));

    await waitFor(() => {
      expect(collectImageCatalogItemMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
        snapshotId: 'custom-snapshot-1',
        displayName: 'Blue Team Ubuntu 22.04',
      });
    });

    const collectedButton = await screen.findByRole('button', { name: '已收录 Blue Team Ubuntu 22.04' });
    expect((collectedButton as HTMLButtonElement).disabled).toBe(true);
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

    fireEvent.click(await screen.findByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByRole('button', { name: '收录到目录 Blue Team Ubuntu 22.04' })).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: '阿里云公共镜像' }));
    expect(await screen.findByText('Alibaba Cloud Linux 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(syncPublicImagesMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token');
    });

    expect(await screen.findByText('Ubuntu 24.04 LTS')).toBeTruthy();
  });

  it('supports rename, disable, enable, and remove actions for platform assets', async () => {
    fetchPlatformImagesMock.mockResolvedValue({
      items: [
        platformImagesPayload.items[0],
        createPlatformImageAsset({
          id: 'platform-image-2',
          imageId: 'm-custom-002',
          displayName: 'Disabled Platform Image',
          sourceSnapshotId: 'custom-snapshot-2',
          sourceScope: 'custom',
          enabled: false,
        }),
      ],
    } satisfies PlatformImageAssetListPayload);
    promptMock.mockReturnValue('Blue Team Ubuntu 22.04 Renamed');
    confirmMock.mockReturnValue(true);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    const platformTab = await screen.findByRole('button', { name: '平台收录镜像' });
    fireEvent.click(platformTab);

    const enabledRow = await screen.findByRole('article', { name: /Blue Team Ubuntu 22.04/ });
    fireEvent.click(within(enabledRow).getByRole('button', { name: '重命名 Blue Team Ubuntu 22.04' }));

    await waitFor(() => {
      expect(renamePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-1',
        'Blue Team Ubuntu 22.04 Renamed',
      );
    });

    expect(await screen.findByText('Blue Team Ubuntu 22.04 Renamed')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '禁用 Blue Team Ubuntu 22.04 Renamed' }));

    await waitFor(() => {
      expect(disablePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-1',
      );
    });

    const disabledRow = await screen.findByRole('article', { name: /Disabled Platform Image/ });
    fireEvent.click(within(disabledRow).getByRole('button', { name: '启用 Disabled Platform Image' }));

    await waitFor(() => {
      expect(enablePlatformImageMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        'platform-image-2',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '移出目录 Disabled Platform Image' }));

    await waitFor(() => {
      expect(removePlatformImageMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', 'platform-image-2');
    });

    expect(screen.queryByText('Disabled Platform Image')).toBeNull();
  });

  it('deletes a custom image from the cloud tab', async () => {
    confirmMock.mockReturnValue(true);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '删除云上镜像 Blue Team Ubuntu 22.04' }));

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
    fetchPlatformImagesMock.mockResolvedValue({
      items: [
        createPlatformImageAsset({ id: 'platform-1', imageId: 'img-1', displayName: 'Platform Asset 1' }),
        createPlatformImageAsset({ id: 'platform-2', imageId: 'img-2', displayName: 'Platform Asset 2' }),
        createPlatformImageAsset({ id: 'platform-3', imageId: 'img-3', displayName: 'Platform Asset 3' }),
      ],
    } satisfies PlatformImageAssetListPayload);
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
    expect(screen.queryByText('Platform Asset 3')).toBeNull();

    const pageSizeSelector = screen.getByRole('combobox', { name: '每页条数' });
    fireEvent.change(pageSizeSelector, { target: { value: '3' } });

    expect(await screen.findByText('Platform Asset 3')).toBeTruthy();
  });

  it('uses page number controls to switch pages on the active tab', async () => {
    fetchPlatformImagesMock.mockResolvedValue({
      items: [
        createPlatformImageAsset({ id: 'platform-1', imageId: 'img-1', displayName: 'Platform Asset 1' }),
        createPlatformImageAsset({ id: 'platform-2', imageId: 'img-2', displayName: 'Platform Asset 2' }),
        createPlatformImageAsset({ id: 'platform-3', imageId: 'img-3', displayName: 'Platform Asset 3' }),
      ],
    } satisfies PlatformImageAssetListPayload);
    fetchCustomImageCatalogScopeMock.mockResolvedValue({
      snapshots: [
        createSnapshot({ id: 'custom-1', scope: 'custom', imageId: 'custom-1', sourceImageName: 'Custom 1' }),
        createSnapshot({ id: 'custom-2', scope: 'custom', imageId: 'custom-2', sourceImageName: 'Custom 2' }),
        createSnapshot({ id: 'custom-3', scope: 'custom', imageId: 'custom-3', sourceImageName: 'Custom 3' }),
      ],
      catalogItems: [],
    } satisfies ImageCatalogScopePayload);

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByText('Platform Asset 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));

    expect(await screen.findByText('Platform Asset 3')).toBeTruthy();
    expect(screen.queryByText('Platform Asset 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Custom 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));
    expect(await screen.findByText('Custom 3')).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: '阿里云公共镜像' }));
    expect(await screen.findByText('Public 1')).toBeTruthy();

    fireEvent.change(screen.getByRole('spinbutton', { name: '跳转到页码' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));

    expect(await screen.findByText('Public 5')).toBeTruthy();
    expect(screen.queryByText('Public 1')).toBeNull();
  });

  it('logs out when sync or collect receives a 401 response after initial load', async () => {
    syncPublicImagesMock.mockRejectedValue(new AdminApiError(401, 'session expired'));
    collectImageCatalogItemMock.mockRejectedValue(new AdminApiError(401, 'session expired'));

    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    fireEvent.click(await screen.findByRole('button', { name: '同步公共镜像' }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '阿里云自定义镜像' }));
    fireEvent.click(await screen.findByRole('button', { name: '收录到目录 Blue Team Ubuntu 22.04' }));

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

    fireEvent.click(await screen.findByRole('button', { name: '阿里云公共镜像' }));
    fireEvent.click(screen.getByRole('button', { name: '同步公共镜像' }));

    expect(await screen.findByText('Ubuntu 24.04 LTS')).toBeTruthy();

    resolvePublicScope?.(publicScopePayload);

    await waitFor(() => {
      expect(screen.getByText('Ubuntu 24.04 LTS')).toBeTruthy();
    });

    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
  });

  it('filters the active tab by image name or image id', async () => {
    render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

    fireEvent.click(await screen.findByRole('button', { name: '阿里云自定义镜像' }));
    expect(await screen.findByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '筛选镜像名' }), {
      target: { value: 'm-custom-001' },
    });

    expect(screen.getByText('Blue Team Ubuntu 22.04')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '阿里云公共镜像' }));
    expect(screen.queryByText('Alibaba Cloud Linux 3')).toBeNull();
  });
});
