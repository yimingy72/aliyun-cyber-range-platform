import type { RangeInstance, RangeInstanceLaunchInput } from './admin-types';

export type RangeLaunchBatchRequest = {
  fingerprint: string;
  key: string;
  payload: RangeInstanceLaunchInput;
  quantity: number;
  expiresAtInput: string;
  accepted: Array<{ id: string }>;
};

export function readRangeLaunchBatch(scope: string): RangeLaunchBatchRequest | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(`range-launch-batch:${scope}`) ?? 'null');
    return value && typeof value.fingerprint === 'string' && typeof value.key === 'string' && value.key.length > 0
      && typeof value.payload?.templateId === 'string' && typeof value.payload.name === 'string' && typeof value.payload.expiresAt === 'string'
      && typeof value.expiresAtInput === 'string' && Number.isInteger(value.quantity) && value.quantity >= 1 && value.quantity <= 99
      && Array.isArray(value.accepted) && value.accepted.length <= value.quantity && value.accepted.every((item: { id?: unknown }) => typeof item?.id === 'string') ? value : null;
  } catch { return null; }
}

export function saveRangeLaunchBatch(scope: string, request: RangeLaunchBatchRequest) {
  window.sessionStorage.setItem(`range-launch-batch:${scope}`, JSON.stringify(request));
}

export function clearRangeLaunchBatch(scope: string, key: string) {
  if (readRangeLaunchBatch(scope)?.key === key) window.sessionStorage.removeItem(`range-launch-batch:${scope}`);
}

export async function submitRangeLaunchBatch(
  request: RangeLaunchBatchRequest,
  launch: (payload: RangeInstanceLaunchInput, key: string) => Promise<RangeInstance>,
  isCurrent: () => boolean,
  onProgress: (accepted: number) => void,
) {
  if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 99) throw new Error('创建数量必须是 1–99 的整数。');
  while (request.accepted.length < request.quantity) {
    if (!isCurrent()) throw new Error('当前页面或云账号已切换，已停止提交剩余实例。');
    const index = request.accepted.length;
    const payload = request.quantity === 1 ? request.payload : { ...request.payload, name: `${request.payload.name}-${index + 1}` };
    // An unknown member is replayed with the same key; acknowledged members are never submitted again.
    const instance = await launch(payload, request.quantity === 1 ? request.key : `${request.key}-${index + 1}`);
    if (!instance?.id) throw new Error('创建结果尚未确认，请继续查询原请求。');
    request.accepted.push({ id: instance.id });
    onProgress(request.accepted.length);
  }
  return request.accepted;
}
