import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteCustomImageSnapshot } from './admin-api';

afterEach(() => vi.unstubAllGlobals());

describe('custom image deletion scope', () => {
  it('keeps the legacy image-only request as the default', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ removed: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await deleteCustomImageSnapshot('http://fixture', 'fixture-token', 'source-1');
    expect(fetch).toHaveBeenCalledWith('http://fixture/admin/image-catalog/custom/source-1', expect.objectContaining({ method: 'DELETE' }));
  });
  it('sends explicit owned-snapshot intent and requires confirmed completion', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ removed: true, status: 'deleted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await deleteCustomImageSnapshot('http://fixture', 'fixture-token', 'source-1', { deleteOwnedSnapshots: true });
    expect(fetch).toHaveBeenCalledWith('http://fixture/admin/image-catalog/custom/source-1?deleteOwnedSnapshots=true', expect.objectContaining({ method: 'DELETE' }));
  });
  it.each([{ removed: false, status: 'deleting' }, { removed: true, status: 'deleting' }, { removed: false, status: 'deleted' }])('does not turn accepted or partial cleanup into UI success: %j', async result => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 })));
    await expect(deleteCustomImageSnapshot('http://fixture', 'fixture-token', 'source-1', { deleteOwnedSnapshots: true })).rejects.toThrow('尚未全部确认');
  });
  it('preserves the server ownership/dependency refusal for the dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '快照被其它镜像共享，拒绝回收。' }), { status: 409 })));
    await expect(deleteCustomImageSnapshot('http://fixture', 'fixture-token', 'source-1', { deleteOwnedSnapshots: true })).rejects.toThrow('快照被其它镜像共享');
  });
});
