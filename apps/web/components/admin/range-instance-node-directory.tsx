import React from 'react';
import { useEffect, useRef, useState } from 'react';

type NodeActionName = 'start' | 'stop' | 'reboot' | 'open-vnc' | 'reset' | 'pack-image';

type RangeInstanceWorkbenchNode = {
  id: string;
  label: string;
  kind: string;
  statusLabel?: string;
  cloudStatus?: string;
  ipAddresses?: string[];
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
  onNodeAction?: (nodeId: string, action: NodeActionName) => void;
  allowActions?: boolean;
  pendingAction?: { nodeId: string; action: NodeActionName } | null;
};

export function RangeInstanceNodeDirectory({
  nodes,
  onNodeAction,
  allowActions = true,
  pendingAction = null,
}: RangeInstanceNodeDirectoryProps) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [copiedPasswordNodeId, setCopiedPasswordNodeId] = useState<string | null>(null);
  const copiedPasswordTimerRef = useRef<number | null>(null);
  const hostNodes = nodes.filter((node) => node.kind === 'ecs');

  useEffect(() => {
    return () => {
      if (copiedPasswordTimerRef.current !== null) {
        window.clearTimeout(copiedPasswordTimerRef.current);
      }
    };
  }, []);

  async function handleCopyPassword(node: RangeInstanceWorkbenchNode) {
    const password = node.password?.trim();

    if (!password || !navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(password);
      setCopiedPasswordNodeId(node.id);

      if (copiedPasswordTimerRef.current !== null) {
        window.clearTimeout(copiedPasswordTimerRef.current);
      }

      copiedPasswordTimerRef.current = window.setTimeout(() => {
        setCopiedPasswordNodeId((current) => (current === node.id ? null : current));
        copiedPasswordTimerRef.current = null;
      }, 1600);
    } catch {
      // Keep the visible password tooltip available when the browser denies clipboard access.
    }
  }

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
          const isPendingNode = pendingAction?.nodeId === node.id;
          const pendingActionName = isPendingNode ? pendingAction.action : null;
          const isStopped = node.cloudStatus === 'Stopped';

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
                {node.ipAddresses?.length ? (
                  <div className="range-instance-ip-list">
                    {node.ipAddresses.map((ipAddress) => (
                      <span key={ipAddress}>{ipAddress}</span>
                    ))}
                  </div>
                ) : (
                  <span>暂无</span>
                )}
              </div>
              <div className="range-instance-directory-cell">
                <div className="single-instance-credential-cell range-instance-credential-cell">
                  <span className="single-instance-credential-mask">
                    {node.account?.trim() || '暂无'} / {node.password?.trim() ? '******' : '暂无'}
                  </span>
                  <span className="single-instance-credential-tooltip">
                    {node.account?.trim() || '暂无'} / {node.password?.trim() || '暂无'}
                  </span>
                  <button
                    type="button"
                    aria-label="复制密码"
                    className="single-instance-copy-button"
                    disabled={!node.password?.trim()}
                    onClick={() => void handleCopyPassword(node)}
                  >
                    {copiedPasswordNodeId === node.id ? '已复制' : '复制'}
                  </button>
                </div>
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
                      disabled={isPendingNode || isStopped}
                      onClick={() => onNodeAction?.(node.id, 'open-vnc')}
                    >
                      {pendingActionName === 'open-vnc' ? '处理中...' : '打开VNC'}
                    </button>

                    <div className="template-workbench-row-menu range-instance-directory-row-menu">
                      <button
                        type="button"
                        className="template-workbench-secondary-action"
                        aria-expanded={menuOpen}
                        disabled={isPendingNode}
                        onClick={() => setExpandedNodeId((current) => (current === node.id ? null : node.id))}
                      >
                        更多操作
                      </button>

                      {menuOpen ? (
                        <div className="template-workbench-action-menu range-instance-directory-action-menu">
                          {isStopped ? (
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedNodeId(null);
                                onNodeAction?.(node.id, 'start');
                              }}
                            >
                              开机
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setExpandedNodeId(null);
                                  onNodeAction?.(node.id, 'stop');
                                }}
                              >
                                关机
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setExpandedNodeId(null);
                                  onNodeAction?.(node.id, 'reboot');
                                }}
                              >
                                重启
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedNodeId(null);
                              onNodeAction?.(node.id, 'reset');
                            }}
                          >
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
