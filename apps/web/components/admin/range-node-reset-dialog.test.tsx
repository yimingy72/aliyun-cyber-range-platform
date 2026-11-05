import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {RangeNodeResetDialog} from './range-node-reset-dialog';
import type {RangeNodeResetPreview} from '@/lib/admin-types';
afterEach(cleanup);
const preview:RangeNodeResetPreview={rangeInstanceId:'r',nodeId:'n',nodeName:'Smoke Node',instanceId:'i-temp',systemDiskId:'d-temp',imageId:'m-source',planDigest:'a'.repeat(64),originalPowerState:'Running',dataDiskIds:['d-keep'],regionId:'cn-beijing',accountUid:'1',hasDns:false,expiresAt:null,destructive:true};
const defaults={nodeName:'Smoke Node',preview,loading:false,pending:false,error:null,uncertain:false,onClose:vi.fn(),onRetryPreview:vi.fn(),onConfirm:vi.fn()};
describe('destructive node reset dialog',()=>{
  it('names the irreversible system disk and requires the exact name, with cancel focused',()=>{
    const onConfirm=vi.fn();render(<RangeNodeResetDialog {...defaults} onConfirm={onConfirm}/>);
    expect(screen.getByText('d-temp')).toBeTruthy();expect(screen.getByText(/永久丢失/)).toBeTruthy();
    const confirm=screen.getByRole('button',{name:'确认清空系统盘并重置'}) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);expect(document.activeElement).toBe(screen.getByRole('button',{name:'取消'}));
    fireEvent.change(screen.getByLabelText('确认重置节点名称'),{target:{value:'Smoke Node'}});expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);expect(onConfirm).toHaveBeenCalledWith('Smoke Node');
  });
  it('blocks confirmation before preview and while submitting',()=>{
    const {rerender}=render(<RangeNodeResetDialog {...defaults} preview={null} loading/>);
    expect((screen.getByRole('button',{name:'确认清空系统盘并重置'}) as HTMLButtonElement).disabled).toBe(true);
    rerender(<RangeNodeResetDialog {...defaults} pending/>);expect((screen.getByRole('button',{name:'取消'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows unknown-result recovery without offering a new preview',()=>{
    render(<RangeNodeResetDialog {...defaults} uncertain error="结果尚未确认"/>);
    expect(screen.getByRole('button',{name:'核对原提交'})).toBeTruthy();expect(screen.queryByRole('button',{name:'重新核验'})).toBeNull();
  });
});
