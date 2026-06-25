'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { AdminApiError, fetchAdminBootstrap, publishRangeTemplate, updateRangeTemplate } from '../../../lib/admin-api';
import type { RangeTemplate } from '../../../lib/admin-types';
import { compileTopologyGraph } from '../../../lib/template-compiler';
import { syncTopologySpecFromNodes } from '../../../lib/template-topology-sync';
import { createEnterpriseRangeSkeleton } from '../../../lib/template-topology-skeleton';
import { useAdminSession } from '../use-admin-session';
import { TemplateCanvas } from './template-canvas';
import { TemplateNodePalette } from './template-node-palette';
import { TemplatePropertyPanel, type TemplateNode } from './template-property-panel';

type TemplateEditorScreenProps = {
  templateId?: string;
  apiBaseUrl?: string;
  template?: RangeTemplate;
};

type DraftTopologyGraph = {
  schemaVersion: string;
  nodes: TemplateNode[];
  edges: Array<Record<string, unknown>>;
};

function readPublishErrorMessage(error: unknown) {
  if (error instanceof AdminApiError) {
    const details = error.details;

    if (details && typeof details === 'object' && 'message' in details) {
      const message = (details as { message?: unknown }).message;

      if (Array.isArray(message) && message.every((item) => typeof item === 'string')) {
        return `模板发布失败：${message.join('；')}`;
      }

      if (typeof message === 'string' && message.trim().length > 0) {
        return `模板发布失败：${message}`;
      }
    }

    if (error.message.trim().length > 0) {
      return `模板发布失败：${error.message}`;
    }
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return `模板发布失败：${error.message}`;
  }

  return '模板发布失败，请检查模板拓扑与编译结果';
}

function readNodesFromTemplate(template: RangeTemplate | null): TemplateNode[] {
  const topologyGraph = template?.currentDraftVersion?.topologyGraph;
  const rawNodes = topologyGraph && typeof topologyGraph === 'object' ? (topologyGraph as { nodes?: unknown }).nodes : [];

  if (!Array.isArray(rawNodes)) {
    return [];
  }

  return rawNodes
    .map((node, index) => {
      if (!node || typeof node !== 'object') {
        return null;
      }

      const candidate = node as Partial<TemplateNode> & { id?: unknown; kind?: unknown; label?: unknown };
      const kind =
        candidate.kind === 'switch' ||
        candidate.kind === 'router' ||
        candidate.kind === 'nat_gateway' ||
        candidate.kind === 'eip' ||
        candidate.kind === 'acl' ||
        candidate.kind === 'security_group_rule'
          ? candidate.kind
          : 'host';

      if (kind === 'switch') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'switch',
          label: typeof candidate.label === 'string' ? candidate.label : `交换机 ${index + 1}`,
          zoneKey: typeof candidate.zoneKey === 'string' ? candidate.zoneKey : `zone-${index + 1}`,
          cidr: typeof candidate.cidr === 'string' ? candidate.cidr : `10.10.${index + 1}.0/24`,
          purpose: typeof candidate.purpose === 'string' ? candidate.purpose : 'business-zone',
          enableNat: typeof candidate.enableNat === 'boolean' ? candidate.enableNat : false,
        } satisfies TemplateNode;
      }

      if (kind === 'router') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'router',
          label: typeof candidate.label === 'string' ? candidate.label : `路由器 ${index + 1}`,
          routeRole: typeof candidate.routeRole === 'string' ? candidate.routeRole : 'egress',
          egressType: typeof candidate.egressType === 'string' ? candidate.egressType : 'internet',
          bindEip: typeof candidate.bindEip === 'boolean' ? candidate.bindEip : false,
        } satisfies TemplateNode;
      }

      if (kind === 'nat_gateway') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'nat_gateway',
          label: typeof candidate.label === 'string' ? candidate.label : `NAT 网关 ${index + 1}`,
          zoneKey: typeof candidate.zoneKey === 'string' ? candidate.zoneKey : 'dmz',
          snatEnabled: typeof candidate.snatEnabled === 'boolean' ? candidate.snatEnabled : false,
        } satisfies TemplateNode;
      }

      if (kind === 'eip') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'eip',
          label: typeof candidate.label === 'string' ? candidate.label : `EIP ${index + 1}`,
          bindTargetType: candidate.bindTargetType === 'nat_gateway' ? 'nat_gateway' : 'host',
          bindTargetKey: typeof candidate.bindTargetKey === 'string' ? candidate.bindTargetKey : 'host-dmz-entry',
          bandwidthMbps: typeof candidate.bandwidthMbps === 'number' ? candidate.bandwidthMbps : 10,
        } satisfies TemplateNode;
      }

      if (kind === 'acl') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'acl',
          label: typeof candidate.label === 'string' ? candidate.label : `ACL ${index + 1}`,
          zoneKey: typeof candidate.zoneKey === 'string' ? candidate.zoneKey : 'dmz',
          direction: typeof candidate.direction === 'string' ? candidate.direction : 'inbound',
          policy: typeof candidate.policy === 'string' ? candidate.policy : 'allow',
          protocol: typeof candidate.protocol === 'string' ? candidate.protocol : 'tcp',
          portRange: typeof candidate.portRange === 'string' ? candidate.portRange : '22/22',
          sourceCidr: typeof candidate.sourceCidr === 'string' ? candidate.sourceCidr : '0.0.0.0/0',
          priority: typeof candidate.priority === 'number' ? candidate.priority : 1,
        } satisfies TemplateNode;
      }

      if (kind === 'security_group_rule') {
        return {
          id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
          kind: 'security_group_rule',
          label: typeof candidate.label === 'string' ? candidate.label : `安全组规则 ${index + 1}`,
          targetHostKey: typeof candidate.targetHostKey === 'string' ? candidate.targetHostKey : 'host-dmz-entry',
          direction: typeof candidate.direction === 'string' ? candidate.direction : 'ingress',
          policy: typeof candidate.policy === 'string' ? candidate.policy : 'accept',
          protocol: typeof candidate.protocol === 'string' ? candidate.protocol : 'tcp',
          portRange: typeof candidate.portRange === 'string' ? candidate.portRange : '22/22',
          sourceCidr: typeof candidate.sourceCidr === 'string' ? candidate.sourceCidr : '0.0.0.0/0',
          priority: typeof candidate.priority === 'number' ? candidate.priority : 1,
        } satisfies TemplateNode;
      }

      return {
        id: typeof candidate.id === 'string' ? candidate.id : `node-${index + 1}`,
        kind: 'host',
        label: typeof candidate.label === 'string' ? candidate.label : `主机 ${index + 1}`,
        zoneKey: typeof candidate.zoneKey === 'string' ? candidate.zoneKey : 'dmz',
        role: typeof candidate.role === 'string' ? candidate.role : 'host',
        privateIp: typeof candidate.privateIp === 'string' ? candidate.privateIp : `10.10.${index + 1}.10`,
        exposePublic: typeof candidate.exposePublic === 'boolean' ? candidate.exposePublic : false,
        image: typeof candidate.image === 'string' ? candidate.image : 'ubuntu_22_04_x64_20G_alibase',
      } satisfies TemplateNode;
    })
    .filter((node): node is TemplateNode => node !== null);
}

export function TemplateEditorScreen({
  templateId,
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
  template: providedTemplate,
}: TemplateEditorScreenProps) {
  const session = useAdminSession();
  const [template, setTemplate] = useState<RangeTemplate | null>(providedTemplate ?? null);
  const [nodes, setNodes] = useState<TemplateNode[]>(() => readNodesFromTemplate(providedTemplate ?? null));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (providedTemplate) {
      setTemplate(providedTemplate);
      setNodes(readNodesFromTemplate(providedTemplate));
    }
  }, [providedTemplate]);

  useEffect(() => {
    if (providedTemplate || !templateId || !session.isReady || !session.token) {
      return;
    }

    let isActive = true;

    fetchAdminBootstrap(apiBaseUrl, session.token).then((payload) => {
      if (!isActive) {
        return;
      }

      const nextTemplate = payload.rangeTemplates.find((item) => item.id === templateId) ?? null;
      setTemplate(nextTemplate);
      setNodes(readNodesFromTemplate(nextTemplate));
    });

    return () => {
      isActive = false;
    };
  }, [apiBaseUrl, providedTemplate, session.isReady, session.token, templateId]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  function handleAddNode(kind: string) {
    const nextIndex = nodes.length + 1;
    const nextNode: TemplateNode =
      kind === 'switch'
        ? {
            id: `${kind}-${nextIndex}`,
            kind: 'switch',
            label: `交换机 ${nextIndex}`,
            zoneKey: `zone-${nextIndex}`,
            cidr: `10.10.${nextIndex}.0/24`,
            purpose: 'business-zone',
            enableNat: false,
          }
        : kind === 'router'
          ? {
              id: `${kind}-${nextIndex}`,
              kind: 'router',
              label: `路由器 ${nextIndex}`,
              routeRole: 'egress',
              egressType: 'internet',
              bindEip: false,
            }
          : kind === 'nat_gateway'
            ? {
                id: `${kind}-${nextIndex}`,
                kind: 'nat_gateway',
                label: `NAT 网关 ${nextIndex}`,
                zoneKey: 'dmz',
                snatEnabled: false,
              }
            : kind === 'eip'
              ? {
                  id: `${kind}-${nextIndex}`,
                  kind: 'eip',
                  label: `EIP ${nextIndex}`,
                  bindTargetType: 'host',
                  bindTargetKey: 'host-dmz-entry',
                  bandwidthMbps: 10,
                }
              : kind === 'acl'
                ? {
                    id: `${kind}-${nextIndex}`,
                    kind: 'acl',
                    label: `ACL ${nextIndex}`,
                    zoneKey: 'dmz',
                    direction: 'inbound',
                    policy: 'allow',
                    protocol: 'tcp',
                    portRange: '22/22',
                    sourceCidr: '0.0.0.0/0',
                    priority: 1,
                  }
                : kind === 'security_group_rule'
                  ? {
                      id: `${kind}-${nextIndex}`,
                      kind: 'security_group_rule',
                      label: `安全组规则 ${nextIndex}`,
                      targetHostKey: 'host-dmz-entry',
                      direction: 'ingress',
                      policy: 'accept',
                      protocol: 'tcp',
                      portRange: '22/22',
                      sourceCidr: '0.0.0.0/0',
                      priority: 1,
                    }
          : {
              id: `${kind}-${nextIndex}`,
              kind: 'host',
              label: `主机 ${nextIndex}`,
              zoneKey: 'dmz',
              role: 'host',
              privateIp: `10.10.${nextIndex}.10`,
              exposePublic: nextIndex === 1,
              image: 'ubuntu_22_04_x64_20G_alibase',
            };

    setNodes((previous) => [...previous, nextNode]);
    setSelectedNodeId(nextNode.id);
  }

  function handleUpdateNode(nodeId: string, nextNode: TemplateNode) {
    setNodes((previous) => previous.map((node) => (node.id === nodeId ? nextNode : node)));
  }

  function handleBootstrapEnterpriseSkeleton() {
    const nextNodes = createEnterpriseRangeSkeleton();
    setNodes(nextNodes);
    setSelectedNodeId(nextNodes[0]?.id ?? null);
    setStatusMessage('已生成企业靶场默认骨架');
  }

  async function handleSaveDraft() {
    if (!template || !session.token) {
      return;
    }

    setIsSubmitting(true);

    const topologyGraph: DraftTopologyGraph = {
      schemaVersion: '1.0.0',
      nodes,
      edges: [],
    };
    const topologySpec = syncTopologySpecFromNodes({
      nodes,
    });
    const compiledSpec = compileTopologyGraph({
      nodes,
    });

    try {
      const nextTemplate = await updateRangeTemplate(apiBaseUrl, session.token, template.id, {
        topologyGraph,
        compiledSpec,
        topologySpec,
      });

      setTemplate(nextTemplate);
      setStatusMessage('草稿已保存');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePublishTemplate() {
    if (!template || !session.token) {
      return;
    }

    setIsSubmitting(true);

    try {
      const nextTemplate = await publishRangeTemplate(apiBaseUrl, session.token, template.id);
      setTemplate(nextTemplate);
      setNodes(readNodesFromTemplate(nextTemplate));
      setStatusMessage('模板已发布，并已生成新的草稿版本');
    } catch (error) {
      setStatusMessage(readPublishErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!template && session.isReady && !session.token) {
    return (
      <section className="admin-panel admin-login-panel">
        <h2>请先登录管理员后台</h2>
        <p className="admin-empty">当前没有有效会话，无法打开模板编辑器。</p>
        <Link href="/admin/login">返回登录页</Link>
      </section>
    );
  }

  const topologyGraph = {
    schemaVersion: '1.0.0',
    ...(template?.currentDraftVersion?.topologyGraph ?? {}),
    nodes,
    edges: [],
  };

  if (!template) {
    return (
      <section className="admin-panel">
        <h2>正在加载模板编辑器...</h2>
        <p className="admin-empty">请稍候，正在读取模板草稿。</p>
      </section>
    );
  }

  return (
    <section className="template-editor-screen">
      <header className="admin-hero">
        <p className="auth-eyebrow">模板编辑器</p>
        <h1>{template.name ?? template.slug}</h1>
        <p className="admin-description">编辑草稿版本，发布后再供实例化使用。</p>
      </header>

      <div className="template-editor-toolbar admin-panel">
        <div>
          <strong>当前模板</strong>
          <p className="admin-empty">{template.slug}</p>
          <p className="admin-empty">
            {template.currentPublishedVersion ? `已发布 ${template.currentPublishedVersion.version}` : '尚未发布'}
            {template.currentDraftVersion ? ` / 草稿 ${template.currentDraftVersion.version}` : ''}
          </p>
        </div>
        <div className="admin-inline-actions">
          <button type="button" disabled={isSubmitting} onClick={handleBootstrapEnterpriseSkeleton}>
            生成企业骨架
          </button>
          <button type="button" disabled={isSubmitting} onClick={() => void handleSaveDraft()}>
            保存草稿
          </button>
          <button type="button" disabled={isSubmitting} onClick={() => void handlePublishTemplate()}>
            发布模板
          </button>
        </div>
      </div>

      {statusMessage ? <p className="admin-empty">{statusMessage}</p> : null}

      <div className="template-editor-grid">
        <TemplateNodePalette onAddNode={handleAddNode} />
        <TemplateCanvas
          topologyGraph={topologyGraph}
          nodes={nodes}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
        <TemplatePropertyPanel selectedNode={selectedNode} onUpdateNode={handleUpdateNode} />
      </div>
    </section>
  );
}
