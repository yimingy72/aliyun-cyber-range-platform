import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { metadata } from './layout';

describe('root metadata', () => {
  it('uses the yellow shield favicon for every route without a competing default icon', () => {
    const faviconUrl = '/platform-favicon.svg?v=cel-v1';

    expect(metadata.icons).toMatchObject({
      icon: [{ url: faviconUrl, type: 'image/svg+xml', sizes: 'any' }],
      shortcut: faviconUrl,
    });
    expect(existsSync(resolve(process.cwd(), 'app/favicon.ico'))).toBe(false);
    expect(readFileSync(resolve(process.cwd(), 'public/platform-favicon.svg'), 'utf8'))
      .toMatch(/<svg[\s\S]*fill="#f1c40f"/);
  });
});
