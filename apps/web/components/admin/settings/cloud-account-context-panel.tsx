import type { ChangeEvent, FormEvent } from 'react';

import type { CloudAccountContext, CreateCloudAccountContextInput } from '../../../lib/admin-types';

type CloudAccountContextPanelProps = {
  contexts: CloudAccountContext[];
  draft: CreateCloudAccountContextInput;
  isLoading?: boolean;
  isSaving?: boolean;
  errorMessage?: string | null;
  successMessage?: string | null;
  pendingContextId?: string | null;
  onChange: (field: keyof CreateCloudAccountContextInput, value: string) => void;
  onCreate: () => void | Promise<void>;
  onActivate: (id: string) => void | Promise<void>;
  onRepair: (id: string) => void | Promise<void>;
};

function formatContextStatus(context: CloudAccountContext) {
  if (context.status === 'ready') {
    return context.isActive ? '当前使用中' : '可切换';
  }

  if (context.status === 'degraded') {
    return '需要修复 Bucket';
  }

  return context.status === 'disabled' ? '已停用' : '正在初始化';
}

export function CloudAccountContextPanel({
  contexts,
  draft,
  isLoading = false,
  isSaving = false,
  errorMessage = null,
  successMessage = null,
  pendingContextId = null,
  onChange,
  onCreate,
  onActivate,
  onRepair,
}: CloudAccountContextPanelProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onCreate();
  };
  const handleChange = (field: keyof CreateCloudAccountContextInput) => (event: ChangeEvent<HTMLInputElement>) => {
    onChange(field, event.target.value);
  };

  return (
    <section className="admin-workbench-panel settings-workbench-panel cloud-context-workbench-panel" aria-labelledby="cloud-account-context-title">
      <div className="admin-workbench-panel-header settings-workbench-header">
        <div className="settings-workbench-header-copy">
          <h2 id="cloud-account-context-title">阿里云账号与镜像存储</h2>
          <span>{contexts.length} 个云账号上下文</span>
        </div>
      </div>

      <p className="settings-workbench-description">
        保存新云账号时，平台会校验账号身份并创建或复用同地域的私有 OSS Bucket，供本地镜像导入使用。
      </p>

      <div className="cloud-context-list" aria-live="polite">
        {isLoading ? <p className="admin-empty">正在加载云账号配置…</p> : null}
        {!isLoading && contexts.length === 0 ? <p className="admin-empty">还没有可用于镜像导入的云账号配置。</p> : null}
        {contexts.map((context) => {
          const isPending = pendingContextId === context.id;
          return (
            <article key={context.id} className="cloud-context-row">
              <div>
                <strong>{context.displayName} · {context.accountUid} · {context.regionId}</strong>
                <span>{context.imageImportBucket}</span>
                {context.lastError ? <p role="alert">{context.lastError}</p> : null}
              </div>
              <div className="cloud-context-row-actions">
                <span className={`template-workbench-status-pill ${context.status === 'ready' ? 'is-published' : 'is-draft'}`}>
                  {formatContextStatus(context)}
                </span>
                {context.status === 'ready' && !context.isActive ? (
                  <button type="button" disabled={isPending} onClick={() => void onActivate(context.id)}>
                    切换到此账号
                  </button>
                ) : null}
                {context.status !== 'ready' ? (
                  <button type="button" disabled={isPending} onClick={() => void onRepair(context.id)}>
                    {isPending ? '正在修复…' : '修复 Bucket'}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <form className="settings-workbench-rows cloud-context-form" onSubmit={handleSubmit}>
        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">账号名称</span>
          <div className="settings-workbench-row-control">
            <input aria-label="账号名称" value={draft.displayName} onChange={handleChange('displayName')} disabled={isSaving} placeholder="训练环境账号" required />
          </div>
        </label>
        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">地域 / 可用区</span>
          <div className="settings-workbench-row-control cloud-context-dual-control">
            <input aria-label="镜像导入地域" value={draft.regionId} onChange={handleChange('regionId')} disabled={isSaving} placeholder="cn-hangzhou" required />
            <input aria-label="镜像导入可用区" value={draft.zoneId} onChange={handleChange('zoneId')} disabled={isSaving} placeholder="cn-hangzhou-h" required />
          </div>
        </label>
        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">AccessKey ID</span>
          <div className="settings-workbench-row-control">
            <input aria-label="镜像导入 AccessKey ID" value={draft.accessKeyId} onChange={handleChange('accessKeyId')} disabled={isSaving} autoComplete="off" required />
          </div>
        </label>
        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">AccessKey Secret</span>
          <div className="settings-workbench-row-control">
            <input aria-label="镜像导入 AccessKey Secret" type="password" value={draft.accessKeySecret} onChange={handleChange('accessKeySecret')} disabled={isSaving} autoComplete="new-password" required />
          </div>
        </label>
        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">导入 Bucket（可选）</span>
          <div className="settings-workbench-row-control">
            <input aria-label="导入 Bucket" value={draft.imageImportBucket ?? ''} onChange={handleChange('imageImportBucket')} disabled={isSaving} placeholder="留空则由平台生成私有 Bucket" />
          </div>
        </label>
        <div className="settings-workbench-submit-row">
          <button type="submit" className="template-workbench-primary-action" disabled={isSaving}>
            {isSaving ? '正在校验并初始化…' : '添加并初始化 OSS Bucket'}
          </button>
        </div>
      </form>

      {errorMessage ? <p className="admin-error settings-workbench-feedback" role="alert">{errorMessage}</p> : null}
      {successMessage ? <p className="admin-success settings-workbench-feedback" aria-live="polite">{successMessage}</p> : null}
    </section>
  );
}
