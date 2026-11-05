import {describe,expect,it,vi} from 'vitest';
import {PlatformApiError} from '@aliyun-cyber-range/platform-api-client';
import {createToolRegistry} from '../src/server';
describe('proven system disk reset MCP boundary',()=>{
  it('has separate read-only preview and destructive confirmed action without arbitrary cloud IDs or scripts',async()=>{
    const preview={version:1,rangeInstanceId:'r',cloudWorkspaceId:'space',ownerUserId:'u',nodeId:'n',nodeName:'Smoke Node',instanceId:'i-temp',systemDiskId:'d-temp',imageId:'m-image',
      sourceJobId:'birth',tagJobId:'birth',cloudAccountContextId:'ctx',accountUid:'1',regionId:'cn-beijing',originalPowerState:'Running',dataDiskIds:[],networkDigest:'a'.repeat(64),autoReleaseTime:null,
      expiresAt:null,hasDns:false,planDigest:'b'.repeat(64),destructive:true};
    const run=vi.fn().mockRejectedValueOnce(new PlatformApiError(409,'confirm',{code:'CONFIRMATION_REQUIRED',confirmationId:'confirm',idempotencyKey:'reset-1'}))
      .mockResolvedValue({status:'accepted',action:'reset',jobId:'reset-job'});
    const registry=createToolRegistry({previewRangeInstanceNodeReset:vi.fn(async()=>preview),runRangeInstanceNodeAction:run} as any);
    await expect(registry.callTool('range_instance_node_reset_preview',['ranges:read'],{rangeInstanceId:'r',nodeId:'n'})).resolves.toMatchObject({structuredContent:{result:{systemDiskId:'d-temp'}}});
    const input={rangeInstanceId:'r',nodeId:'n',planDigest:preview.planDigest,confirmedNodeName:'Smoke Node',idempotencyKey:'reset-1'};
    const tool=registry.listTools(['ranges:control']).find(tool=>tool.name==='range_instance_node_reset');
    expect(tool?.annotations).toMatchObject({destructiveHint:true,idempotentHint:true});
    await expect(registry.callTool('range_instance_node_reset',['ranges:read'],input)).rejects.toThrow('Forbidden');
    for(const extra of [{instanceId:'i-foreign'},{diskId:'d-foreign'},{password:'secret'},{command:'wipe'}])
      await expect(registry.callTool('range_instance_node_reset',['ranges:control'],{...input,...extra})).rejects.toThrow('Invalid input');
    await expect(registry.callTool('range_instance_node_reset',['ranges:control'],input)).resolves.toMatchObject({isError:true,structuredContent:{result:{error:{code:'CONFIRMATION_REQUIRED'}}}});
    await expect(registry.callTool('range_instance_node_reset',['ranges:control'],{...input,confirmationId:'confirm'})).resolves.toMatchObject({structuredContent:{result:{jobId:'reset-job'}}});
    expect(run).toHaveBeenLastCalledWith('r','n','reset',{planDigest:preview.planDigest,confirmedNodeName:'Smoke Node'},{idempotencyKey:'reset-1',confirmationId:'confirm'});
  });
});
