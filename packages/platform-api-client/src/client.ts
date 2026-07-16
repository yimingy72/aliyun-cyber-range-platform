import type {
  InstanceMode,
  InstanceView,
  LaunchRangeInput,
  LaunchSingleInstancesInput,
  OperationRequest,
  PlatformApiClientLike,
  PlatformApiClientOptions,
  PlatformImageAsset,
  PlatformImageView,
  ProvisionJob,
  RangeAccessPayload,
  RangeInstance,
  RangeTemplate,
  RangeTemplateView,
  SingleInstanceActionPayload,
  SingleInstanceListPayload,
} from './types';

export class PlatformApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export class PlatformApiClient implements PlatformApiClientLike {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlatformApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  listRangeTemplates(view: RangeTemplateView = 'platform') {
    return this.request<RangeTemplate[]>(`/admin/scenarios?view=${encodeURIComponent(view)}`);
  }

  async getRangeTemplate(id: string) {
    const lists = await Promise.all([this.listRangeTemplates('platform'), this.listRangeTemplates('mine')]);
    return lists.flat().find((item) => item.id === id) ?? null;
  }

  async listPlatformImages(view: PlatformImageView = 'platform') {
    const result = await this.request<{ items: PlatformImageAsset[] }>(`/admin/platform-images?view=${encodeURIComponent(view)}`);
    return result.items;
  }

  listRangeInstances(view: InstanceView = 'active') {
    return this.request<RangeInstance[]>(`/admin/ranges?view=${encodeURIComponent(view)}`);
  }

  getRangeInstance(id: string) {
    return this.request<RangeInstance>(`/admin/ranges/${encodeURIComponent(id)}`);
  }

  async getRangeInstanceAccess(id: string): Promise<RangeAccessPayload> {
    return this.pickAccess(await this.getRangeInstance(id));
  }

  listSingleInstances(view: InstanceView = 'active') {
    return this.request<SingleInstanceListPayload>(`/admin/instances?view=${encodeURIComponent(view)}`);
  }

  async getSingleInstance(id: string) {
    const lists = await Promise.all([this.listSingleInstances('active'), this.listSingleInstances('history')]);
    for (const list of lists) {
      const found = [...list.standaloneInstances, ...list.batches.flatMap((entry) => entry.instances)].find((item) => item.id === id);

      if (found) {
        return found;
      }
    }

    return null;
  }

  async getSingleInstanceAccess(id: string): Promise<RangeAccessPayload> {
    const instance = await this.getSingleInstance(id);

    if (!instance) {
      throw new PlatformApiError(404, 'Single instance not found');
    }

    return this.pickAccess(instance);
  }

  listProvisionJobs(instanceMode?: InstanceMode) {
    const query = instanceMode ? `?instanceMode=${encodeURIComponent(instanceMode)}` : '';
    return this.request<ProvisionJob[]>(`/admin/provision-jobs${query}`);
  }

  getProvisionJob(id: string) {
    return this.request<ProvisionJob>(`/admin/provision-jobs/${encodeURIComponent(id)}`);
  }

  launchRange(payload: LaunchRangeInput, operation?: OperationRequest) {
    return this.request<RangeInstance>('/admin/ranges/launch', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  destroyRange(rangeInstanceId: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/ranges/${encodeURIComponent(rangeInstanceId)}/destroy`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  launchSingleInstances(payload: LaunchSingleInstancesInput, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>('/admin/instances/launch', {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  destroySingleInstance(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/${encodeURIComponent(id)}/destroy`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  destroySingleInstanceBatch(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/batches/${encodeURIComponent(id)}/destroy-all`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  retrySingleInstance(id: string, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: '{}',
      operation,
    });
  }

  rebootSingleInstance(id: string, payload: SingleInstanceActionPayload = {}, operation?: OperationRequest) {
    return this.action(id, 'reboot', payload, operation);
  }

  openSingleInstanceVnc(id: string, payload: SingleInstanceActionPayload = {}) {
    return this.action(id, 'open-vnc', payload);
  }

  packSingleInstanceImage(id: string, payload: SingleInstanceActionPayload = {}, operation?: OperationRequest) {
    return this.action(id, 'pack-image', payload, operation);
  }

  private action(id: string, action: 'reboot' | 'open-vnc' | 'pack-image', payload: SingleInstanceActionPayload, operation?: OperationRequest) {
    return this.request<Record<string, unknown>>(`/admin/instances/${encodeURIComponent(id)}/actions/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      operation,
    });
  }

  private async request<T>(path: string, init?: { method?: string; body?: string; operation?: OperationRequest }) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: this.buildHeaders(init?.operation),
      body: init?.body,
    });

    if (!response.ok) {
      let details: unknown = null;

      try {
        details = await response.json();
      } catch {
        details = await response.text().catch(() => null);
      }

      const message =
        details && typeof details === 'object' && 'message' in details && typeof (details as { message?: unknown }).message === 'string'
          ? (details as { message: string }).message
          : `Platform API request failed with status ${response.status}`;

      throw new PlatformApiError(response.status, message, details);
    }

    return (await response.json()) as T;
  }

  private buildHeaders(operation?: OperationRequest) {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...(operation?.idempotencyKey ? { 'x-idempotency-key': operation.idempotencyKey } : {}),
      ...(operation?.confirmationId ? { 'x-confirmation-id': operation.confirmationId } : {}),
    };
  }

  private pickAccess(instance: RangeInstance): RangeAccessPayload {
    return {
      defaultInstancePassword: (instance.defaultInstancePassword as string | null | undefined) ?? null,
      accessEntry: (instance.accessEntry as Record<string, unknown> | null | undefined) ?? null,
      runtimeCredentials: (instance.runtimeCredentials as Record<string, unknown> | null | undefined) ?? null,
    };
  }
}
