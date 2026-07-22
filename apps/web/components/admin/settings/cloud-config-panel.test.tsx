import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CloudConfigSnapshot } from '../../../lib/admin-types';
import { CloudConfigPanel } from './cloud-config-panel';

const cloudConfig = {
  provider: 'alibaba_cloud',
  defaultRegion: 'cn-hangzhou',
  defaultZoneId: 'cn-hangzhou-h',
  accessKeyId: 'test-access-key',
  accessKeySecret: '********',
  imageImportBucket: '',
} as unknown as CloudConfigSnapshot;

describe('CloudConfigPanel', () => {
  it('lets administrators configure an existing custom OSS Bucket without implying that the platform creates it', () => {
    const html = renderToStaticMarkup(
      <CloudConfigPanel
        value={cloudConfig}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="自定义 OSS 存储桶名"');
    expect(html).toContain('name="accessKeyId"');
    expect(html).toContain('name="accessKeySecret"');
    expect(html).toContain('type="password"');
    expect(html).toContain('仅使用已存在的 Bucket。留空将关闭镜像上传；平台不会创建 Bucket 或修改其权限、CORS。');
  });

  it('renders a stable form skeleton instead of empty cloud configuration fields while loading', () => {
    const html = renderToStaticMarkup(
      <CloudConfigPanel
        isLoading
        value={cloudConfig}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="cloud-config-form-skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('aria-label="AccessKey ID"');
  });
});
