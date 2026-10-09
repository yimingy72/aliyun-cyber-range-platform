import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccountContext, TencentCloudImagesInput, TencentCloudImagesPayload } from '@/lib/admin-types';

const { list, images, save } = vi.hoisted(() => ({ list: vi.fn(), images: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ fetchCloudAccountContexts: list, fetchTencentCloudImages: images, saveTencentCloudAccount: save }));
vi.mock('../shared/admin-select-field', () => ({
  AdminSelectField: ({ ariaLabel, value, onValueChange, options, disabled, emptyOptionLabel, className }: {
    ariaLabel: string; value: string; onValueChange: (value: string) => void; options: Array<{ value: string; label: string; disabled?: boolean }>;
    disabled?: boolean; emptyOptionLabel?: string; className?: string;
  }) => <select aria-label={ariaLabel} className={className} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>
    {emptyOptionLabel ? <option value="">{emptyOptionLabel}</option> : null}
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>,
}));

import { TencentCloudPanel } from './tencent-cloud-panel';

const account: CloudAccountContext = { id: 'Tencent context 1', provider: 'tencent_cloud', displayName: '南京腾讯账号', accountUid: '100001',
  regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1', isActive: false, status: 'ready', imageImportBucket: '', bucketStatus: 'not_configured' };
const second: CloudAccountContext = { ...account, id: 'Tencent context 2', displayName: '上海腾讯账号', accountUid: '200002', regionId: 'ap-shanghai', zoneId: 'ap-shanghai-1' };
const alias: CloudAccountContext = { ...account, id: 'Aliyun context', provider: 'alibaba_cloud', displayName: '杭州阿里云账号', accountUid: '999999', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', isActive: true };

function result(input: TencentCloudImagesInput, displayName = '腾讯测试镜像', totalCount = 1): TencentCloudImagesPayload {
  const source = input.cloudAccountContextId === second.id ? second : account;
  return { provider: 'tencent_cloud', cloudAccountContextId: source.id, accountUid: source.accountUid,
    regionId: source.regionId, zoneId: source.zoneId, scope: input.scope, offset: input.offset ?? 0, limit: input.limit ?? 20, totalCount,
    items: totalCount ? [{ imageId: `img-${displayName}`, displayName, platform: 'Ubuntu', architecture: 'x86_64', status: 'NORMAL', isAvailable: true }] : [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fill() {
  for (const [label, value] of [['腾讯云地域', 'ap-nanjing'], ['腾讯云可用区', 'ap-nanjing-1'], ['SecretId', 'synthetic-Tencent-key'], ['SecretKey', 'synthetic-Tencent-secret']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
}
function submit() { fireEvent.submit(screen.getByLabelText('SecretId').closest('form')!); }
const onError = vi.fn(() => false);
function mount(token = 'token') { return render(<TencentCloudPanel apiBaseUrl="https://fixture.invalid" token={token} onError={onError} />); }

beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear();
  list.mockReset().mockResolvedValue([alias, account, second]);
  images.mockReset().mockImplementation(async (_url: string, _token: string, input: TencentCloudImagesInput) => result(input));
  save.mockReset().mockResolvedValue(account);
  onError.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Tencent settings panel isolation and request races', () => {
  it('starts with empty credentials and selects only a ready Tencent account, never Aliyun or degraded contexts', async () => {
    list.mockResolvedValue([alias, { ...account, status: 'degraded' }, second]);
    mount();
    for (const label of ['腾讯云地域', '腾讯云可用区', 'SecretId', 'SecretKey']) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    await screen.findByText('腾讯测试镜像');
    const select = screen.getByLabelText('腾讯云镜像账号') as HTMLSelectElement;
    expect(select.value).toBe(second.id);
    expect(within(select).queryByRole('option', { name: alias.displayName })).toBeNull();
    expect((within(select).getByRole('option', { name: account.displayName }) as HTMLOptionElement).disabled).toBe(true);
    expect(images).toHaveBeenCalledWith('https://fixture.invalid', 'token', { cloudAccountContextId: second.id, scope: 'custom', offset: 0, limit: 20 });
    expect((screen.getByLabelText('SecretKey') as HTMLInputElement).type).toBe('password');
  });

  it('does not query images when every Tencent account is unavailable', async () => {
    list.mockResolvedValue([alias, { ...account, status: 'disabled' }]);
    mount();
    await waitFor(() => expect((screen.getByLabelText('腾讯云镜像账号') as HTMLSelectElement).disabled).toBe(false));
    expect(images).not.toHaveBeenCalled();
    expect((screen.getByLabelText('腾讯云镜像账号') as HTMLSelectElement).value).toBe('');
  });

  it('prevents rapid duplicate saves, clears all successful credentials, and writes no secret to storage', async () => {
    const pending = deferred<CloudAccountContext>();
    save.mockReturnValue(pending.promise);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    mount(); await screen.findByText('腾讯测试镜像'); fill();
    submit(); submit(); submit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('https://fixture.invalid', 'token', { provider: 'tencent_cloud', regionId: account.regionId,
      zoneId: account.zoneId, accessKeyId: 'synthetic-Tencent-key', accessKeySecret: 'synthetic-Tencent-secret' });
    expect((screen.getByLabelText('SecretKey') as HTMLInputElement).disabled).toBe(true);
    await act(async () => pending.resolve(account));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '腾讯云账号已验证并保存，可查询镜像与可用机型。');
    for (const label of ['腾讯云地域', '腾讯云可用区', 'SecretId', 'SecretKey']) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    expect(JSON.stringify(storage.mock.calls)).not.toContain('synthetic-Tencent');
    expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
  });

  it('preserves editable fields on failed saves and allows a deliberate retry', async () => {
    save.mockRejectedValueOnce(new Error('腾讯云身份校验失败。'));
    mount(); await screen.findByText('腾讯测试镜像'); fill(); submit();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '腾讯云身份校验失败。');
    expect((screen.getByLabelText('SecretKey') as HTMLInputElement).value).toBe('synthetic-Tencent-secret');
    expect((screen.getByLabelText('SecretKey') as HTMLInputElement).disabled).toBe(false);
    submit(); await screen.findByRole('status'); expect(save).toHaveBeenCalledTimes(2);
  });

  it('keeps a successfully added account when an earlier initial account-list request finishes later', async () => {
    const pending = deferred<CloudAccountContext[]>(); list.mockReturnValue(pending.promise);
    mount(); fill(); submit(); await screen.findByRole('status');
    await act(async () => pending.resolve([alias]));
    const select = screen.getByLabelText('腾讯云镜像账号') as HTMLSelectElement;
    expect(select.value).toBe(account.id);
    expect(within(select).getByRole('option', { name: account.displayName })).toBeTruthy();
    expect(await screen.findByText('腾讯测试镜像')).toBeTruthy();
  });

  it('discards image results from the previous account after a switch', async () => {
    const pending = deferred<TencentCloudImagesPayload>();
    images.mockImplementationOnce(() => pending.promise);
    mount(); await waitFor(() => expect(images).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('腾讯云镜像账号'), { target: { value: second.id } });
    await screen.findByText('腾讯测试镜像');
    await act(async () => pending.resolve(result({ cloudAccountContextId: account.id, scope: 'custom', offset: 0, limit: 20 }, '旧账号镜像')));
    expect(screen.queryByText('旧账号镜像')).toBeNull();
    expect(screen.getByText(`账号 ${second.accountUid} · ${second.regionId} · ${second.zoneId}`)).toBeTruthy();
  });

  it('discards older page responses after changing scope and resets pagination', async () => {
    const pending = deferred<TencentCloudImagesPayload>();
    images.mockImplementationOnce(async (_url: string, _token: string, input: TencentCloudImagesInput) => result(input, '第一页', 50))
      .mockImplementationOnce(() => pending.promise);
    mount(); await screen.findByText('第一页'); fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(images).toHaveBeenLastCalledWith('https://fixture.invalid', 'token', { cloudAccountContextId: account.id, scope: 'custom', offset: 20, limit: 20 }));
    fireEvent.change(screen.getByLabelText('腾讯云镜像类型'), { target: { value: 'public' } });
    await screen.findByText('腾讯测试镜像');
    await act(async () => pending.resolve(result({ cloudAccountContextId: account.id, scope: 'custom', offset: 20, limit: 20 }, '旧页镜像', 50)));
    expect(screen.queryByText('旧页镜像')).toBeNull();
    expect(images).toHaveBeenLastCalledWith('https://fixture.invalid', 'token', { cloudAccountContextId: account.id, scope: 'public', offset: 0, limit: 20 });
  });

  it('clamps a removed final page and re-queries its valid offset', async () => {
    images.mockImplementation(async (_url: string, _token: string, input: TencentCloudImagesInput) =>
      input.offset ? result(input, '超出页', 1) : result(input, '第一页', images.mock.calls.length === 1 ? 50 : 1));
    mount(); await screen.findByText('第一页'); fireEvent.click(screen.getByRole('button', { name: '第 3 页' }));
    await waitFor(() => expect(images.mock.calls.some(call => call[2].offset === 40)).toBe(true));
    await waitFor(() => expect(images.mock.calls.at(-1)?.[2].offset).toBe(0));
    expect(screen.queryByText('超出页')).toBeNull();
  });

  it('resets to the first page when refreshing replaces an unavailable selected account', async () => {
    images.mockImplementation(async (_url: string, _token: string, input: TencentCloudImagesInput) => result(input, '腾讯测试镜像', 50));
    mount(); await screen.findByText('腾讯测试镜像'); fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(images.mock.calls.at(-1)?.[2].offset).toBe(20));
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false));
    list.mockResolvedValue([alias, { ...account, status: 'degraded' }, second]);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect((screen.getByLabelText('腾讯云镜像账号') as HTMLSelectElement).value).toBe(second.id));
    await waitFor(() => expect(images).toHaveBeenLastCalledWith('https://fixture.invalid', 'token', { cloudAccountContextId: second.id, scope: 'custom', offset: 0, limit: 20 }));
  });

  it('remounts source state on token changes and never queries the previous context with the new token', async () => {
    const pending = deferred<CloudAccountContext>(); save.mockReturnValue(pending.promise);
    const view = mount(); await screen.findByText('腾讯测试镜像'); fill(); submit();
    list.mockResolvedValue([second]);
    view.rerender(<TencentCloudPanel apiBaseUrl="https://fixture.invalid" token="new-token" onError={onError} />);
    await waitFor(() => expect(images).toHaveBeenCalledWith('https://fixture.invalid', 'new-token', expect.objectContaining({ cloudAccountContextId: second.id })));
    expect(images.mock.calls.some(call => call[1] === 'new-token' && call[2].cloudAccountContextId === account.id)).toBe(false);
    for (const label of ['SecretId', 'SecretKey']) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    await act(async () => pending.resolve(account));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('腾讯云镜像账号') as HTMLSelectElement).value).toBe(second.id);
  });

  it('reports account failures and recovers through refresh', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    mount(); expect(await screen.findByRole('alert')).toHaveProperty('textContent', '腾讯云账号加载失败，请重试。');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('腾讯测试镜像')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses wrong-cloud saves and mismatched image responses instead of showing success or foreign content', async () => {
    save.mockResolvedValue(alias);
    images.mockImplementation(async (_url: string, _token: string, input: TencentCloudImagesInput) => ({ ...result(input, '阿里云镜像'), provider: 'alibaba_cloud' }));
    mount(); expect(await screen.findByText('腾讯云镜像返回的账号或查询范围不一致，请刷新核对。')).toBeTruthy();
    expect(screen.queryByText('阿里云镜像')).toBeNull();
    fill(); submit(); expect(await screen.findByRole('alert')).toHaveProperty('textContent', '腾讯云账号返回状态异常，请刷新核对。');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps long catalog values inside shared fixed tables and responsive selector containers', async () => {
    const long = '很长的镜像名称'.repeat(50);
    images.mockImplementation(async (_url: string, _token: string, input: TencentCloudImagesInput) => result(input, long));
    const view = mount(); const text = await screen.findByText(long);
    expect(text.className).toContain('truncate');
    expect(screen.getByRole('table', { name: '腾讯云镜像目录' }).className).toContain('table-fixed');
    expect(screen.getByLabelText('腾讯云镜像账号').className).toContain('min-w-0');
    expect(view.container.firstElementChild?.className).toContain('min-w-0');
  });
});
