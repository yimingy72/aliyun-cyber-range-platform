import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError } from './admin-api';
import { clearBillingReadCache, fetchBillingEntries, fetchBillingEntryDetail, readCachedBillingDetail, reconcileBillingEntries } from './billing-lifecycle-api';
import { setCloudWorkspaceSelection } from './cloud-workspace-selection';

const context = { apiBaseUrl: 'http://api:3001', token: 'fixture-token', workspaceId: 'frozen-space' };
const range = { startAt: '2026-10-01', endAt: '2026-10-28' };
afterEach(() => { clearBillingReadCache(); vi.unstubAllGlobals(); setCloudWorkspaceSelection('fixture-user', null); });

describe('billing lifecycle API contract', () => {
  it('reuses a recent list when returning to the same filter, but refresh and workspace changes still fetch', async () => {
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({items:[],page:1,total:0})));vi.stubGlobal('fetch',fetchMock);
    const query={...range,view:'user' as const,page:1,pageSize:20 as const};
    const first=await fetchBillingEntries(context,query);
    await fetchBillingEntries(context,{...query,billStatus:'partial'});
    expect(await fetchBillingEntries(context,query)).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fetchBillingEntries(context,query,undefined,{refresh:true});
    await fetchBillingEntries({...context,workspaceId:'other-space'},query);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('reuses detail data across a same-session token refresh but isolates other sessions, roles and workspaces', async () => {
    const jwt=(extra:Record<string,unknown>)=>'header.'+btoa(JSON.stringify({sub:'subject-a',sid:'session-a',scope:'billing:read',...extra}))+'.signature';
    const fetchMock=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({entry:{name:'cached'},resources:[],events:[]}))));vi.stubGlobal('fetch',fetchMock);
    const first={...context,token:jwt({exp:100,jti:'first'})};await fetchBillingEntryDetail(first,'same-entry',range);
    const refreshed={...context,token:jwt({exp:200,jti:'second'})};await fetchBillingEntryDetail(refreshed,'same-entry',range);expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchBillingEntryDetail({...refreshed,workspaceId:'other-space'},'same-entry',range);
    await fetchBillingEntryDetail({...context,token:jwt({sid:'other-session'})},'same-entry',range);
    await fetchBillingEntryDetail({...context,token:jwt({scope:'different:permission'})},'same-entry',range);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('does not replace a refreshed detail with a late earlier response and forwards an explicit cache bypass', async () => {
    let complete!:(value:Response)=>void;const old=new Promise<Response>(resolve=>{complete=resolve;});
    const fetchMock=vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(new Response(JSON.stringify({entry:{name:'latest'},resources:[],events:[]})));vi.stubGlobal('fetch',fetchMock);
    const pending=fetchBillingEntryDetail(context,'one',range);
    await fetchBillingEntryDetail(context,'one',range,undefined,{refresh:true});
    complete(new Response(JSON.stringify({entry:{name:'old'},resources:[],events:[]})));await pending;
    expect(readCachedBillingDetail(context,'one',range)?.entry.name).toBe('latest');
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('cache-control')).toBe('no-cache');
  });
  it('encodes opaque entry ids as one segment and passes the GET abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await fetchBillingEntryDetail(context, 'range:a/b?#% 中', range, controller.signal);
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/admin/billing/entries/${encodeURIComponent('range:a/b?#% 中')}`);
    expect(Object.fromEntries(url.searchParams)).toEqual(range);
    expect(init.signal).toBe(controller.signal);
    expect(init.cache).toBe('no-store');
  });

  it('uses frozen authorization and workspace for both reads and reconciliation', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    setCloudWorkspaceSelection('fixture-user', 'another-space');
    await fetchBillingEntries(context, { ...range, view: 'platform', userId: 'must-not-leak', page: 3, pageSize: 50 });
    await reconcileBillingEntries(context, { ...range, entryId: 'single:one' });
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-token');
      expect(new Headers(init.headers).get('x-cloud-workspace-id')).toBe('frozen-space');
    }
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...range, view: 'platform', page: '3', pageSize: '50' });
    expect(fetchMock.mock.calls[1]![0]).toBe('http://api:3001/admin/billing/reconcile');
    expect(fetchMock.mock.calls[1]![1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ ...range, entryId: 'single:one' });
  });

  it.each([401, 403, 404, 500, 501])('preserves HTTP %s for the caller to decide fallback', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(fetchBillingEntries(context, { ...range, view: 'user', page: 1, pageSize: 20 })).rejects.toEqual(expect.objectContaining({ name: 'AdminApiError', status } satisfies Partial<AdminApiError>));
  });
});
