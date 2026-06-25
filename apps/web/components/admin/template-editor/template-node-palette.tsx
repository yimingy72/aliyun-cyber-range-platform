'use client';

const NODE_TYPES = [
  { key: 'host', label: '主机', description: 'ECS / 跳板机 / 域控 / 数据库' },
  { key: 'switch', label: '交换机', description: '子网 / 网段 / ACL / NAT' },
  { key: 'router', label: '路由器', description: 'DNS / 出口 / 路由策略' },
  { key: 'nat_gateway', label: 'NAT 网关', description: '子网 SNAT / DNAT / 出口能力' },
  { key: 'eip', label: 'EIP', description: '公网 IP / 入口绑定 / 出口绑定' },
  { key: 'acl', label: 'ACL', description: '子网访问控制 / 方向策略 / 端口规则' },
  { key: 'security_group_rule', label: '安全组规则', description: '主机入站 / 出站 / 端口放行' },
];

type TemplateNodePaletteProps = {
  onAddNode: (kind: string) => void;
};

export function TemplateNodePalette({ onAddNode }: TemplateNodePaletteProps) {
  return (
    <aside className="template-editor-panel">
      <div className="admin-section-header">
        <h2>节点库</h2>
        <span>{NODE_TYPES.length} 类</span>
      </div>

      <div className="template-node-palette">
        {NODE_TYPES.map((nodeType) => (
          <button key={nodeType.key} type="button" className="template-node-card" onClick={() => onAddNode(nodeType.key)}>
            <strong>{nodeType.label}</strong>
            <span>{nodeType.description}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
