import {afterEach,describe,expect,it,vi} from 'vitest';
import {previewRangeInstanceNodeReset,resetRangeInstanceNode,type RangeNodeResetOperation} from './admin-api';
import type {RangeNodeResetPreview} from './admin-types';
const preview:RangeNodeResetPreview={rangeInstanceId:'range/1',nodeId:'host/1',nodeName:'临时节点',instanceId:'i-temp',systemDiskId:'d-temp',imageId:'m-image',planDigest:'a'.repeat(64),
  originalPowerState:'Running',dataDiskIds:[],regionId:'cn-beijing',accountUid:'1001',hasDns:false,expiresAt:null,destructive:true};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const challenge=(summary:unknown={...preview,systemDiskDataWillBeLost:true,dataDisksReset:false})=>json({code:'CONFIRMATION_REQUIRED',confirmationId:'confirm-1',idempotencyKey:'reset-1',summary},409);
afterEach(()=>vi.unstubAllGlobals());
describe('node reset confirmation transport',()=>{
  it('previews read-only with the captured workspace',async()=>{
    const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>json(preview));vi.stubGlobal('fetch',fetcher);
    await previewRangeInstanceNodeReset('http://api','token',preview.rangeInstanceId,preview.nodeId,'original-workspace');
    expect(fetcher.mock.calls[0]).toEqual(['http://api/admin/ranges/range%2F1/nodes/host%2F1/reset-preview',expect.objectContaining({headers:expect.objectContaining({'x-cloud-workspace-id':'original-workspace'})})]);
  });
  it('replays only the confirmed target with identical payload, key and workspace',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(challenge()).mockResolvedValueOnce(json({status:'accepted',action:'reset',jobId:'job-1'}));vi.stubGlobal('fetch',fetcher);
    await expect(resetRangeInstanceNode('http://api','token',preview,preview.nodeName,'original-workspace',{idempotencyKey:'reset-1'})).resolves.toMatchObject({jobId:'job-1'});
    const first=fetcher.mock.calls[0][1],second=fetcher.mock.calls[1][1];
    expect(second.body).toBe(first.body);expect(JSON.parse(second.body)).toEqual({planDigest:preview.planDigest,confirmedNodeName:preview.nodeName});
    expect(second.headers).toMatchObject({'x-cloud-workspace-id':'original-workspace','x-idempotency-key':'reset-1','x-confirmation-id':'confirm-1'});
  });
  it('never confirms a challenge for a different disk',async()=>{
    const fetcher=vi.fn(async()=>challenge({...preview,systemDiskId:'d-foreign',systemDiskDataWillBeLost:true,dataDisksReset:false}));vi.stubGlobal('fetch',fetcher);
    await expect(resetRangeInstanceNode('http://api','token',preview,preview.nodeName,'space',{idempotencyKey:'reset-1'})).rejects.toThrow('不符');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not automatically retry an uncertain submission and retains its original confirmation for lookup',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new TypeError('network lost')).mockResolvedValueOnce(json({jobId:'original-job'}));vi.stubGlobal('fetch',fetcher);
    const operation:RangeNodeResetOperation={idempotencyKey:'reset-1'};
    await expect(resetRangeInstanceNode('http://api','token',preview,preview.nodeName,'space',operation)).rejects.toThrow('network lost');
    expect(fetcher).toHaveBeenCalledTimes(2);expect(operation.confirmationId).toBe('confirm-1');
    await expect(resetRangeInstanceNode('http://api','token',preview,preview.nodeName,'space',operation)).resolves.toMatchObject({jobId:'original-job'});
    expect(fetcher.mock.calls[2][1].headers['x-idempotency-key']).toBe('reset-1');
  });
  it('does not submit without the exact typed node name',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(resetRangeInstanceNode('http://api','token',preview,'wrong','space',{idempotencyKey:'reset-1'})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
});
