import { describe, expect, it, vi } from 'vitest';

import { createAdminScreenCache } from './admin-screen-cache';

describe('AdminScreenCache', () => {
  it('returns a fresh value without starting another request', async () => {
    const cache = createAdminScreenCache({ now: () => 100, staleTimeMs: 1_000 });
    const load = vi.fn().mockResolvedValue({ items: ['image-1'] });

    await expect(cache.load('image-center:platform', load)).resolves.toEqual({ items: ['image-1'] });
    await expect(cache.load('image-center:platform', load)).resolves.toEqual({ items: ['image-1'] });

    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.read<{ items: string[] }>('image-center:platform')).toEqual({
      data: { items: ['image-1'] },
      isFresh: true,
    });
  });

  it('shares an in-flight request for the same resource', async () => {
    const cache = createAdminScreenCache();
    let resolve!: (value: string[]) => void;
    const load = vi.fn(
      () =>
        new Promise<string[]>((nextResolve) => {
          resolve = nextResolve;
        }),
    );

    const first = cache.load('range-instances:active', load);
    const second = cache.load('range-instances:active', load);
    resolve(['range-1']);

    await expect(Promise.all([first, second])).resolves.toEqual([['range-1'], ['range-1']]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a stale snapshot available while it revalidates', async () => {
    let now = 100;
    const cache = createAdminScreenCache({ now: () => now, staleTimeMs: 1_000 });
    const firstLoad = vi.fn().mockResolvedValue(['template-1']);
    const secondLoad = vi.fn().mockResolvedValue(['template-1', 'template-2']);

    await cache.load('templates:mine', firstLoad);
    now = 1_101;

    expect(cache.read<string[]>('templates:mine')).toEqual({
      data: ['template-1'],
      isFresh: false,
    });
    await expect(cache.load('templates:mine', secondLoad)).resolves.toEqual(['template-1', 'template-2']);
  });

  it('allows an explicit retry to bypass a fresh snapshot', async () => {
    const cache = createAdminScreenCache();
    const firstLoad = vi.fn().mockResolvedValue(['range-1']);
    const retryLoad = vi.fn().mockResolvedValue(['range-1', 'range-2']);

    await cache.load('range-instances:active', firstLoad);
    await expect(cache.load('range-instances:active', retryLoad, { force: true })).resolves.toEqual([
      'range-1',
      'range-2',
    ]);

    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(retryLoad).toHaveBeenCalledTimes(1);
  });

  it('does not retain failed requests and supports prefix invalidation', async () => {
    const cache = createAdminScreenCache();

    await expect(cache.load('image-center:platform', () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(cache.read('image-center:platform')).toBeNull();

    await cache.load('image-center:platform', () => Promise.resolve(['image-1']));
    await cache.load('instances:active', () => Promise.resolve(['instance-1']));
    cache.invalidate('image-center:');

    expect(cache.read('image-center:platform')).toBeNull();
    expect(cache.read<string[]>('instances:active')?.data).toEqual(['instance-1']);
  });
});
