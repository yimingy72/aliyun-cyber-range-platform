import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, fetchPackedImageTasks, verifyPackedImageTask, packedImageTaskIdFromError, isPackedImageSubmissionUnconfirmed } from './admin-api';

afterEach(() => vi.unstubAllGlobals());
describe('Packed-image task API', () => {
  it('encodes exact original targets and only sends an empty reconciliation body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchPackedImageTasks('http://localhost:3001', 'fixture-token', 'range/source');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/admin/packed-images?sourceRangeInstanceId=range%2Fsource');
    fetchMock.mockResolvedValue(new Response('{"id":"original/task"}', { status: 200 }));
    await verifyPackedImageTask('http://localhost:3001', 'fixture-token', 'original/task');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:3001/admin/packed-images/original%2Ftask/verify');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' });
  });
  it('only permits a fresh submission after a structured official rejection, not error prose', () => {
    const unknown = new AdminApiError(502, 'unknown', { packedImageArtifactId: 'original' });
    const rejected = new AdminApiError(502, 'rejected', { packedImageArtifactId: 'original', submissionRejected: true });
    expect(packedImageTaskIdFromError(unknown)).toBe('original');
    expect(isPackedImageSubmissionUnconfirmed(unknown)).toBe(true);
    expect(isPackedImageSubmissionUnconfirmed(rejected)).toBe(false);
    expect(isPackedImageSubmissionUnconfirmed(new Error('云端明确拒绝'))).toBe(true);
    expect(packedImageTaskIdFromError(new Error('original'))).toBeNull();
  });
});
