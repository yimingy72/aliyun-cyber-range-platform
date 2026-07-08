import React from 'react';
import { useState } from 'react';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
  statusLabel?: string;
  ipAddress?: string;
  specLabel?: string;
  account?: string;
  password?: string;
  imageName?: string;
  createdBy?: string;
  expiresAt?: string;
  createdAt?: string;
};

type RangeInstanceNodeDirectoryProps = {
  nodes: RangeInstanceWorkbenchNode[];
  onNodeAction?: (nodeId: string, action: 'stop' | 'reboot' | 'open-vnc' | 'pack-image') => void;
  allowActions?: boolean;
};

export function RangeInstanceNodeDirectory({
  nodes,
  onNodeAction,
  allowActions = true,
}: RangeInstanceNodeDirectoryProps) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const hostNodes = nodes.filter((node) => node.kind === 'ecs');

  return (
    <div className="range-instance-directory-table">
      <div className="range-instance-directory-head">
        <div>实例名</div>
        <div>状态</div>
        <div>镜像信息</div>
        <div>IP 地址</div>
        <div>账号信息</div>
        <div>有效期</div>
        <div>创建时间</div>
        <div>操作</div>
      </div>

      <div className="range-instance-directory-body">
        {hostNodes.map((node) => {
          const menuOpen = expandedNodeId === node.id;

          return (
            <div key={node.id} className={`range-instance-directory-row${menuOpen ? ' is-menu-open' : ''}`}>
              <div className="range-instance-directory-cell range-instance-directory-primary">
                <strong>{node.label}</strong>
              </div>
              <div className="range-instance-directory-cell">
                <span>{node.statusLabel ?? '未知状态'}</span>
              </div>
              <div className="range-instance-directory-cell">
                <span>{node.imageName ?? '暂无'}</span>
              </div>
              <div className="range-instance-directory-cell">
                <span>{node.ipAddress ?? '暂无'}</span>
              </div>
              <div className="range-instance-directory-cell">
                <strong>
                  {node.account ?? '暂无'}/{node.password ?? '暂无'}
                </strong>
              </div>
              <div className="range-instance-directory-cell">
                <span>{node.expiresAt ?? '暂无'}</span>
              </div>
              <div className="range-instance-directory-cell">
                <span>{node.createdAt ?? '暂无'}</span>
              </div>
              <div className="range-instance-directory-cell range-instance-directory-actions">
                {allowActions ? (
                  <>
                    <button
                      type="button"
                      className="template-workbench-secondary-action"
                      onClick={() => onNodeAction?.(node.id, 'stop')}
                    >
                      关机
                    </button>
                    <button
                      type="button"
                      className="template-workbench-secondary-action"
                      onClick={() => onNodeAction?.(node.id, 'reboot')}
                    >
                      重启
                    </button>
                    <button
                      type="button"
                      className="template-workbench-secondary-action"
                      onClick={() => onNodeAction?.(node.id, 'open-vnc')}
                    >
                      打开VNC
                    </button>

                    <div className="template-workbench-row-menu range-instance-directory-row-menu">
                      <button
                        type="button"
                        className="template-workbench-secondary-action"
                        aria-expanded={menuOpen}
                        onClick={() => setExpandedNodeId((current) => (current === node.id ? null : node.id))}
                      >
                        更多
                      </button>

                      {menuOpen ? (
                        <div className="template-workbench-action-menu range-instance-directory-action-menu">
                          <button type="button" onClick={() => setExpandedNodeId(null)}>
                            重置
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedNodeId(null);
                              onNodeAction?.(node.id, 'pack-image');
                            }}
                          >
                            二次打包镜像
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <span>仅查看</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
