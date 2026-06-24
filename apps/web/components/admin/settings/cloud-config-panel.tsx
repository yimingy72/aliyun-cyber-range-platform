import type { CloudConfigSnapshot } from '../../../lib/admin-types';

type CloudConfigPanelProps = {
  config: CloudConfigSnapshot | null;
};

function renderValue(value: string | null | undefined) {
  if (!value || value === 'unset') {
    return '未配置';
  }

  return value;
}

export function CloudConfigPanel({ config }: CloudConfigPanelProps) {
  const preferences = config?.instanceTypePreferences.filter(Boolean) ?? [];

  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>云配置</h2>
        <span>只读快照</span>
      </div>

      {config ? (
        <ul className="admin-list">
          <li>
            <div className="admin-list-copy">
              <strong>默认地域</strong>
              <span>{renderValue(config.region)}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>默认可用区</strong>
              <span>{renderValue(config.zoneId)}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>编排模式</strong>
              <span>{renderValue(config.provisionerMode)}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>实例规格策略</strong>
              <span>{renderValue(config.instanceTypeStrategy)}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>实例规格偏好</strong>
              <span>{preferences.length ? preferences.join(' / ') : '未配置'}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>系统镜像</strong>
              <span>{renderValue(config.imageId)}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>实例密码</strong>
              <span>{config.instancePasswordConfigured ? '已配置' : '未配置'}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>Provider 离线包</strong>
              <span>{config.providerZipPathConfigured ? '已配置' : '未配置'}</span>
            </div>
          </li>
          <li>
            <div className="admin-list-copy">
              <strong>计划前校验</strong>
              <span>{config.readyForPlan ? '已满足' : '缺少配置'}</span>
            </div>
          </li>
          {config.checks.map((check) => (
            <li key={check.key}>
              <div className="admin-list-copy">
                <strong>{check.label}</strong>
                <span>{check.configured ? `${check.label}已配置` : `${check.label}未配置`}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">暂无云配置。</p>
      )}
    </section>
  );
}
