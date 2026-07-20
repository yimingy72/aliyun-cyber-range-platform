import type { ChangeEvent, FormEvent } from 'react';

import type { CloudConfigSnapshot } from '../../../lib/admin-types';

type CloudConfigPanelProps = {
  value: CloudConfigSnapshot;
  isLoading?: boolean;
  isSaving?: boolean;
  isManagedByAccountContext?: boolean;
  saveErrorMessage?: string | null;
  saveSuccessMessage?: string | null;
  onChange: (field: keyof CloudConfigSnapshot, value: string) => void;
  onSubmit: () => void | Promise<void>;
};

function handleInputChange(
  field: keyof CloudConfigSnapshot,
  onChange: CloudConfigPanelProps['onChange'],
) {
  return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    onChange(field, event.target.value);
  };
}

export function CloudConfigPanel({
  value,
  isLoading = false,
  isSaving = false,
  isManagedByAccountContext = false,
  saveErrorMessage = null,
  saveSuccessMessage = null,
  onChange,
  onSubmit,
}: CloudConfigPanelProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit();
  };

  return (
    <form className="admin-workbench-panel settings-workbench-panel" onSubmit={handleSubmit}>
      <div className="admin-workbench-panel-header settings-workbench-header">
        <div className="settings-workbench-header-copy">
          <h2>云配置</h2>
          <span>5 项配置</span>
        </div>

        <button type="submit" className="template-workbench-primary-action" disabled={isLoading || isSaving || isManagedByAccountContext}>
          {isSaving ? '正在保存...' : '保存云配置'}
        </button>
      </div>

      <div className="settings-workbench-rows">
        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">云平台</span>
          <div className="settings-workbench-row-control">
            <select
              aria-label="云平台"
              value={value.provider}
              onChange={handleInputChange('provider', onChange)}
              disabled={isLoading || isSaving || isManagedByAccountContext}
            >
              <option value="alibaba_cloud">阿里云</option>
            </select>
          </div>
        </label>

        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">默认地域</span>
          <div className="settings-workbench-row-control">
            <input
              aria-label="默认地域"
              value={value.defaultRegion}
              onChange={handleInputChange('defaultRegion', onChange)}
              disabled={isLoading || isSaving || isManagedByAccountContext}
              placeholder="cn-hangzhou"
            />
          </div>
        </label>

        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">默认可用区</span>
          <div className="settings-workbench-row-control">
            <input
              aria-label="默认可用区"
              value={value.defaultZoneId}
              onChange={handleInputChange('defaultZoneId', onChange)}
              disabled={isLoading || isSaving || isManagedByAccountContext}
              placeholder="cn-hangzhou-h"
            />
          </div>
        </label>

        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">AccessKey ID</span>
          <div className="settings-workbench-row-control">
            <input
              aria-label="AccessKey ID"
              value={value.accessKeyId}
              onChange={handleInputChange('accessKeyId', onChange)}
              disabled={isLoading || isSaving || isManagedByAccountContext}
              autoComplete="off"
            />
          </div>
        </label>

        <label className="settings-workbench-row">
          <span className="settings-workbench-row-label">AccessKey Secret</span>
          <div className="settings-workbench-row-control">
            <input
              aria-label="AccessKey Secret"
              type="password"
              value={value.accessKeySecret}
              onChange={handleInputChange('accessKeySecret', onChange)}
              disabled={isLoading || isSaving || isManagedByAccountContext}
              autoComplete="new-password"
            />
          </div>
        </label>
      </div>

      {isManagedByAccountContext ? <p className="settings-workbench-feedback">当前默认云账号由下方“阿里云账号与镜像存储”管理。</p> : null}
      {saveErrorMessage ? <p className="admin-error settings-workbench-feedback">{saveErrorMessage}</p> : null}
      {saveSuccessMessage ? <p className="admin-success settings-workbench-feedback">{saveSuccessMessage}</p> : null}
    </form>
  );
}
