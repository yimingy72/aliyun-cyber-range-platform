'use client';

type TemplateNodeBase = {
  id: string;
  kind: 'host' | 'switch' | 'router' | 'nat_gateway' | 'eip' | 'acl' | 'security_group_rule';
  label: string;
};

export type HostTemplateNode = TemplateNodeBase & {
  kind: 'host';
  zoneKey: string;
  role: string;
  privateIp: string;
  exposePublic: boolean;
  image: string;
};

export type SwitchTemplateNode = TemplateNodeBase & {
  kind: 'switch';
  zoneKey: string;
  cidr: string;
  purpose: string;
  enableNat: boolean;
};

export type RouterTemplateNode = TemplateNodeBase & {
  kind: 'router';
  routeRole: string;
  egressType: string;
  bindEip: boolean;
};

export type NatGatewayTemplateNode = TemplateNodeBase & {
  kind: 'nat_gateway';
  zoneKey: string;
  snatEnabled: boolean;
};

export type EipTemplateNode = TemplateNodeBase & {
  kind: 'eip';
  bindTargetType: 'host' | 'nat_gateway';
  bindTargetKey: string;
  bandwidthMbps: number;
};

export type AclTemplateNode = TemplateNodeBase & {
  kind: 'acl';
  zoneKey: string;
  direction: string;
  policy: string;
  protocol: string;
  portRange: string;
  sourceCidr: string;
  priority: number;
};

export type SecurityGroupRuleTemplateNode = TemplateNodeBase & {
  kind: 'security_group_rule';
  targetHostKey: string;
  direction: string;
  policy: string;
  protocol: string;
  portRange: string;
  sourceCidr: string;
  priority: number;
};

export type TemplateNode =
  | HostTemplateNode
  | SwitchTemplateNode
  | RouterTemplateNode
  | NatGatewayTemplateNode
  | EipTemplateNode
  | AclTemplateNode
  | SecurityGroupRuleTemplateNode;

type TemplatePropertyPanelProps = {
  selectedNode: TemplateNode | null;
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void;
};

function renderHostFields(selectedNode: HostTemplateNode, onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void) {
  return (
    <>
      <label>
        <span>主机名称</span>
        <input
          aria-label="主机名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>所属区域</span>
        <input
          aria-label="所属区域"
          value={selectedNode.zoneKey}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              zoneKey: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>主机角色</span>
        <input
          aria-label="主机角色"
          value={selectedNode.role}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              role: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>私网 IP</span>
        <input
          aria-label="私网 IP"
          value={selectedNode.privateIp}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              privateIp: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>镜像</span>
        <input
          aria-label="镜像"
          value={selectedNode.image}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              image: event.target.value,
            })
          }
        />
      </label>
      <label className="template-property-check">
        <input
          type="checkbox"
          checked={selectedNode.exposePublic}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              exposePublic: event.target.checked,
            })
          }
        />
        <span>允许公网暴露</span>
      </label>
    </>
  );
}

function renderSwitchFields(selectedNode: SwitchTemplateNode, onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void) {
  return (
    <>
      <label>
        <span>交换机名称</span>
        <input
          aria-label="交换机名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>区域标识</span>
        <input
          aria-label="区域标识"
          value={selectedNode.zoneKey}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              zoneKey: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>子网 CIDR</span>
        <input
          aria-label="子网 CIDR"
          value={selectedNode.cidr}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              cidr: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>区域用途</span>
        <input
          aria-label="区域用途"
          value={selectedNode.purpose}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              purpose: event.target.value,
            })
          }
        />
      </label>
      <label className="template-property-check">
        <input
          type="checkbox"
          checked={selectedNode.enableNat}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              enableNat: event.target.checked,
            })
          }
        />
        <span>启用 NAT 能力</span>
      </label>
    </>
  );
}

function renderRouterFields(selectedNode: RouterTemplateNode, onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void) {
  return (
    <>
      <label>
        <span>路由节点名称</span>
        <input
          aria-label="路由节点名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>路由角色</span>
        <input
          aria-label="路由角色"
          value={selectedNode.routeRole}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              routeRole: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>出口类型</span>
        <input
          aria-label="出口类型"
          value={selectedNode.egressType}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              egressType: event.target.value,
            })
          }
        />
      </label>
      <label className="template-property-check">
        <input
          type="checkbox"
          checked={selectedNode.bindEip}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              bindEip: event.target.checked,
            })
          }
        />
        <span>绑定公网出口 EIP</span>
      </label>
    </>
  );
}

function renderNatGatewayFields(
  selectedNode: NatGatewayTemplateNode,
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void,
) {
  return (
    <>
      <label>
        <span>NAT 网关名称</span>
        <input
          aria-label="NAT 网关名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>所属区域</span>
        <input
          aria-label="所属区域"
          value={selectedNode.zoneKey}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              zoneKey: event.target.value,
            })
          }
        />
      </label>
      <label className="template-property-check">
        <input
          type="checkbox"
          checked={selectedNode.snatEnabled}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              snatEnabled: event.target.checked,
            })
          }
        />
        <span>启用 SNAT</span>
      </label>
    </>
  );
}

function renderEipFields(selectedNode: EipTemplateNode, onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void) {
  return (
    <>
      <label>
        <span>EIP 名称</span>
        <input
          aria-label="EIP 名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>绑定目标类型</span>
        <input
          aria-label="绑定目标类型"
          value={selectedNode.bindTargetType}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              bindTargetType: event.target.value === 'nat_gateway' ? 'nat_gateway' : 'host',
            })
          }
        />
      </label>
      <label>
        <span>绑定目标标识</span>
        <input
          aria-label="绑定目标标识"
          value={selectedNode.bindTargetKey}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              bindTargetKey: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>带宽 Mbps</span>
        <input
          aria-label="带宽 Mbps"
          type="number"
          value={selectedNode.bandwidthMbps}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              bandwidthMbps: Number(event.target.value) || 0,
            })
          }
        />
      </label>
    </>
  );
}

function renderAclFields(selectedNode: AclTemplateNode, onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void) {
  return (
    <>
      <label>
        <span>ACL 名称</span>
        <input
          aria-label="ACL 名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>所属区域</span>
        <input
          aria-label="所属区域"
          value={selectedNode.zoneKey}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              zoneKey: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>方向</span>
        <input
          aria-label="方向"
          value={selectedNode.direction}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              direction: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>策略</span>
        <input
          aria-label="策略"
          value={selectedNode.policy}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              policy: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>协议</span>
        <input
          aria-label="协议"
          value={selectedNode.protocol}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              protocol: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>端口范围</span>
        <input
          aria-label="端口范围"
          value={selectedNode.portRange}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              portRange: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>来源网段</span>
        <input
          aria-label="来源网段"
          value={selectedNode.sourceCidr}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              sourceCidr: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>优先级</span>
        <input
          aria-label="优先级"
          type="number"
          value={selectedNode.priority}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              priority: Number(event.target.value) || 0,
            })
          }
        />
      </label>
    </>
  );
}

function renderSecurityGroupRuleFields(
  selectedNode: SecurityGroupRuleTemplateNode,
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void,
) {
  return (
    <>
      <label>
        <span>安全组规则名称</span>
        <input
          aria-label="安全组规则名称"
          value={selectedNode.label}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              label: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>目标主机标识</span>
        <input
          aria-label="目标主机标识"
          value={selectedNode.targetHostKey}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              targetHostKey: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>方向</span>
        <input
          aria-label="方向"
          value={selectedNode.direction}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              direction: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>策略</span>
        <input
          aria-label="策略"
          value={selectedNode.policy}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              policy: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>协议</span>
        <input
          aria-label="协议"
          value={selectedNode.protocol}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              protocol: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>端口范围</span>
        <input
          aria-label="端口范围"
          value={selectedNode.portRange}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              portRange: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>来源网段</span>
        <input
          aria-label="来源网段"
          value={selectedNode.sourceCidr}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              sourceCidr: event.target.value,
            })
          }
        />
      </label>
      <label>
        <span>优先级</span>
        <input
          aria-label="优先级"
          type="number"
          value={selectedNode.priority}
          onChange={(event) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              priority: Number(event.target.value) || 0,
            })
          }
        />
      </label>
    </>
  );
}

export function TemplatePropertyPanel({ selectedNode, onUpdateNode }: TemplatePropertyPanelProps) {
  return (
    <aside className="template-editor-panel">
      <div className="admin-section-header">
        <h2>属性面板</h2>
        <span>节点配置</span>
      </div>

      <div className="template-property-placeholder">
        {selectedNode ? (
          <div className="template-property-form">
            {selectedNode.kind === 'host' ? renderHostFields(selectedNode, onUpdateNode) : null}
            {selectedNode.kind === 'switch' ? renderSwitchFields(selectedNode, onUpdateNode) : null}
            {selectedNode.kind === 'router' ? renderRouterFields(selectedNode, onUpdateNode) : null}
            {selectedNode.kind === 'nat_gateway' ? renderNatGatewayFields(selectedNode, onUpdateNode) : null}
            {selectedNode.kind === 'eip' ? renderEipFields(selectedNode, onUpdateNode) : null}
            {selectedNode.kind === 'acl' ? renderAclFields(selectedNode, onUpdateNode) : null}
            {selectedNode.kind === 'security_group_rule'
              ? renderSecurityGroupRuleFields(selectedNode, onUpdateNode)
              : null}
          </div>
        ) : (
          <>
            <p>选择一个节点后在这里编辑参数。</p>
            <ul>
              <li>主机：ECS、边界入口、域控、数据库</li>
              <li>交换机：子网、区域、ACL、NAT</li>
              <li>路由器：出口、DNS、路由策略</li>
              <li>NAT 网关 / EIP / ACL / 安全组规则：云侧网络控制资源</li>
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
