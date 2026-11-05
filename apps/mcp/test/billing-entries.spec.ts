import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

describe('read-only billing entry MCP contract',()=>{
  it('uses the page read model, preserves classifications and encodes exact detail IDs',async()=>{
    const entry={id:'instance:failed',billingStatus:'not_applicable',amounts:[],resourceCount:0};
    const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('entries/')?{entry,resources:[],events:[]}:{version:2,items:[entry],total:1})));
    const registry=createToolRegistry(new PlatformApiClient({baseUrl:'https://platform.example',token:'fixture',cloudWorkspaceId:'workspace',fetch:fetch as typeof globalThis.fetch}));
    expect(await registry.callTool('billing_entry_list',['billing:read'],{startAt:'2026-10-01',endAt:'2026-10-31',view:'user',groupBy:'batch',billStatus:'not_applicable',pageSize:100},'admin'))
      .toMatchObject({structuredContent:{result:{items:[entry]}}});
    const url=new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/admin/billing/entries');expect(url.searchParams.get('billStatus')).toBe('not_applicable');expect(url.searchParams.get('groupBy')).toBe('batch');
    expect(await registry.callTool('billing_entry_get',['billing:read'],{entryId:entry.id},'admin')).toMatchObject({structuredContent:{result:{entry,resources:[],events:[]}}});
    expect(fetch.mock.calls[1][0]).toBe('https://platform.example/admin/billing/entries/instance%3Afailed');
    expect(registry.listTools(['billing:read'],'admin').filter(tool=>['billing_entry_list','billing_entry_get'].includes(tool.name)).every(tool=>tool.annotations.readOnlyHint)).toBe(true);
  });
  it('requires billing read/admin and rejects owner overrides, invalid statuses and incomplete dates',async()=>{
    const listBillingEntries=vi.fn(),getBillingEntryDetail=vi.fn(),registry=createToolRegistry({listBillingEntries,getBillingEntryDetail} as any);
    expect(registry.listTools(['billing:read'],'user').map(tool=>tool.name)).not.toContain('billing_entry_list');
    await expect(registry.callTool('billing_entry_list',['jobs:read'],{},'admin')).rejects.toThrow('Forbidden');
    for(const input of [{cloudAccountUid:'foreign'},{billStatus:'free'},{startAt:'2026-10-01'},{startAt:'2026-10-02',endAt:'2026-10-01'}])
      await expect(registry.callTool('billing_entry_list',['billing:read'],input,'admin')).rejects.toThrow('Invalid input');
    await expect(registry.callTool('billing_entry_get',['billing:read'],{entryId:'instance:failed',raw:true},'admin')).rejects.toThrow('Invalid input');
    expect(listBillingEntries).not.toHaveBeenCalled();expect(getBillingEntryDetail).not.toHaveBeenCalled();
  });
});
