import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { metadata } from './layout';

describe('root metadata', () => {
  it('declares a versioned ICO favicon and ships 16px, 32px, and 48px icon entries', () => {
    const faviconUrl = '/platform-favicon.ico?v=shield-v1';

    expect(metadata.icons).toMatchObject({
      icon: [{ url: faviconUrl, type: 'image/x-icon', sizes: 'any' }],
      shortcut: faviconUrl,
    });
    expect(existsSync(resolve(process.cwd(), 'app/favicon.ico'))).toBe(false);

    const icon = readFileSync(resolve(process.cwd(), 'public/platform-favicon.ico'));
    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(icon.readUInt16LE(4)).toBe(3);

    const entryWidths = [6, 22, 38].map((offset) => icon[offset]);
    expect(entryWidths).toEqual([16, 32, 48]);
  });
});
