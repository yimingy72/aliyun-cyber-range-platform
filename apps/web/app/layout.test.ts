import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { metadata } from './layout';

describe('root metadata', () => {
  it('declares the ICO favicon and ships 16px, 32px, and 48px icon entries', () => {
    expect(metadata.icons).toMatchObject({ icon: '/favicon.ico' });

    const icon = readFileSync(resolve(process.cwd(), 'app/favicon.ico'));
    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(icon.readUInt16LE(4)).toBe(3);

    const entryWidths = [6, 22, 38].map((offset) => icon[offset]);
    expect(entryWidths).toEqual([16, 32, 48]);
  });
});
