import React from 'react';

type RangeInstancePropertyPanelProps = {
  selectedNode: {
    label: string;
    kind: string;
    hostName?: string;
    imageName?: string;
    cpu?: number;
    memory?: number;
    ipAddress?: string;
    account?: string;
    password?: string;
    cidr?: string;
    purpose?: string;
    routeRole?: string;
    egressType?: string;
    aclRuleCount?: number;
    dnatCount?: number;
    snatEnabled?: boolean;
  };
  onEditedNodeFieldChange: (
    field: 'label' | 'hostName' | 'imageName' | 'cpu' | 'memory' | 'ipAddress' | 'account' | 'password',
    value: string,
  ) => void;
  readOnly?: boolean;
};

export function RangeInstancePropertyPanel({
  selectedNode,
  onEditedNodeFieldChange,
  readOnly = false,
}: RangeInstancePropertyPanelProps) {
  return (
    <aside className="range-instance-property-panel">
      <div className="template-workbench-list-header-copy">
        <h2>属性面板</h2>
        <p>{selectedNode.label}</p>
      </div>

      {selectedNode.kind === 'ecs' ? (
        <div className="range-instance-property-section">
          <strong>基础信息</strong>
          <label className="template-workbench-search-field">
            <span>名称</span>
            <input
              aria-label="名称"
              value={selectedNode.label}
              readOnly={readOnly}
              onChange={(event) => onEditedNodeFieldChange('label', event.target.value)}
            />
          </label>
          <label className="template-workbench-search-field">
            <span>主机名</span>
            <input
              aria-label="主机名"
              value={selectedNode.hostName ?? ''}
              readOnly={readOnly}
              onChange={(event) => onEditedNodeFieldChange('hostName', event.target.value)}
            />
          </label>
          <label className="template-workbench-search-field">
            <span>镜像名</span>
            <input
              aria-label="镜像名"
              value={selectedNode.imageName ?? ''}
              readOnly={readOnly}
              onChange={(event) => onEditedNodeFieldChange('imageName', event.target.value)}
            />
          </label>
          <div className="range-instance-property-inline">
            <label className="template-workbench-search-field">
              <span>CPU</span>
              <input
                aria-label="CPU"
                value={selectedNode.cpu ?? ''}
                readOnly={readOnly}
                onChange={(event) => onEditedNodeFieldChange('cpu', event.target.value)}
              />
            </label>
            <label className="template-workbench-search-field">
              <span>内存</span>
              <input
                aria-label="内存"
                value={selectedNode.memory ?? ''}
                readOnly={readOnly}
                onChange={(event) => onEditedNodeFieldChange('memory', event.target.value)}
              />
            </label>
          </div>
          <label className="template-workbench-search-field">
            <span>私网IP</span>
            <input
              aria-label="私网IP"
              value={selectedNode.ipAddress ?? ''}
              readOnly={readOnly}
              onChange={(event) => onEditedNodeFieldChange('ipAddress', event.target.value)}
            />
          </label>
          <div className="range-instance-property-inline">
            <label className="template-workbench-search-field">
              <span>账号</span>
              <input
                aria-label="账号"
                value={selectedNode.account ?? ''}
                readOnly={readOnly}
                onChange={(event) => onEditedNodeFieldChange('account', event.target.value)}
              />
            </label>
            <label className="template-workbench-search-field">
              <span>密码</span>
              <input
                aria-label="密码"
                value={selectedNode.password ?? ''}
                readOnly={readOnly}
                onChange={(event) => onEditedNodeFieldChange('password', event.target.value)}
              />
            </label>
          </div>
        </div>
      ) : null}

      {selectedNode.kind === 'switch' ? (
        <div className="range-instance-property-section">
          <strong>交换机配置</strong>
          <label className="template-workbench-search-field">
            <span>名称</span>
            <input
              aria-label="名称"
              value={selectedNode.label}
              readOnly={readOnly}
              onChange={(event) => onEditedNodeFieldChange('label', event.target.value)}
            />
          </label>
          <label className="template-workbench-search-field">
            <span>网段</span>
            <input aria-label="网段" value={selectedNode.cidr ?? ''} readOnly />
          </label>
          <label className="template-workbench-search-field">
            <span>用途</span>
            <input aria-label="用途" value={selectedNode.purpose ?? ''} readOnly />
          </label>
          <div className="range-instance-property-kv">
            <span>ACL 规则</span>
            <strong>{selectedNode.aclRuleCount ?? 0}</strong>
          </div>
          <div className="range-instance-property-kv">
            <span>SNAT</span>
            <strong>{selectedNode.snatEnabled ? '已启用' : '未启用'}</strong>
          </div>
          <div className="range-instance-property-kv">
            <span>DNAT</span>
            <strong>{selectedNode.dnatCount ?? 0}</strong>
          </div>
        </div>
      ) : null}

      {selectedNode.kind === 'router' ? (
        <div className="range-instance-property-section">
          <strong>路由器信息</strong>
          <label className="template-workbench-search-field">
            <span>名称</span>
            <input
              aria-label="名称"
              value={selectedNode.label}
              readOnly={readOnly}
              onChange={(event) => onEditedNodeFieldChange('label', event.target.value)}
            />
          </label>
          <label className="template-workbench-search-field">
            <span>路由角色</span>
            <input aria-label="路由角色" value={selectedNode.routeRole ?? ''} readOnly />
          </label>
          <label className="template-workbench-search-field">
            <span>出口类型</span>
            <input aria-label="出口类型" value={selectedNode.egressType ?? ''} readOnly />
          </label>
        </div>
      ) : null}
    </aside>
  );
}
