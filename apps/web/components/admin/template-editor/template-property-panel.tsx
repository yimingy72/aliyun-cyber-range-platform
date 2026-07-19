'use client';

import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import { validateAliyunEcsPassword } from '@aliyun-cyber-range/scenario-runtime';
import type { InstanceTypeAvailabilitySnapshot, PlatformImageAsset } from '../../../lib/admin-types';
import type {
  DnatExternalPortConflict,
  EcsTemplateNode,
  RouterTemplateNode,
  SwitchTemplateNode,
  TemplateNode,
} from '../../../lib/scenario-graph';
import { findDuplicateDnatExternalPorts } from '../../../lib/scenario-graph';
export type {
  EcsTemplateNode,
  RouterTemplateNode,
  SwitchTemplateNode,
  TemplateNode,
} from '../../../lib/scenario-graph';

type TemplatePropertyPanelProps = {
  selectedNode: TemplateNode | null;
  allNodes: TemplateNode[];
  platformImageAssets?: PlatformImageAsset[];
  instanceTypeAvailability?: InstanceTypeAvailabilitySnapshot | null;
  linkedSwitchIdsByHostId?: Record<string, string[]>;
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void;
  readOnly?: boolean;
  instanceDetailMode?: boolean;
  runtimeNodeStatus?: string | null;
};

type EcsTemplateNodeWithPlatformImageAssetId = EcsTemplateNode & {
  platformImageAssetId?: string;
};

type PropertyFieldProps = {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
};

type PropertyGroupProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  actionClassName?: string;
  formClassName?: string;
  headClassName?: string;
  children: ReactNode;
};

function parseMultiLineList(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatMultiLineList(values: string[] | undefined) {
  return (values ?? []).join('\n');
}

function parseCidrParts(cidr: string) {
  const [ipPart = '', prefixPart = '24'] = cidr.split('/');
  const octets = ipPart.split('.');

  return {
    first: octets[0] || '10',
    second: octets[1] || '10',
    third: octets[2] || '1',
    prefix: prefixPart || '24',
  };
}

function buildCidrFromParts(parts: { first: string; second: string; third: string; prefix: string }) {
  const first = String(Math.max(0, Math.min(255, Number(parts.first) || 0)));
  const second = String(Math.max(0, Math.min(255, Number(parts.second) || 0)));
  const third = String(Math.max(0, Math.min(255, Number(parts.third) || 0)));
  const prefix = String(Math.max(17, Math.min(29, Number(parts.prefix) || 24)));

  return `${first}.${second}.${third}.0/${prefix}`;
}

function parseIpv4ToNumber(value: string) {
  const octets = value.split('.').map((item) => Number(item));

  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    return null;
  }

  return (((octets[0]! << 24) >>> 0) + ((octets[1]! << 16) >>> 0) + ((octets[2]! << 8) >>> 0) + (octets[3] ?? 0)) >>> 0;
}

function isIpv4InCidr(ip: string, cidr: string) {
  const [networkIp = '', prefixText = ''] = cidr.split('/');
  const ipNumber = parseIpv4ToNumber(ip);
  const networkNumber = parseIpv4ToNumber(networkIp);
  const prefix = Number(prefixText);

  if (ipNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

function isCompleteIpv4(value: string) {
  return parseIpv4ToNumber(value) !== null;
}

function PropertyField({ label, hint, className, children }: PropertyFieldProps) {
  return (
    <label className={className ? `template-property-field ${className}` : 'template-property-field'}>
      <span className="template-property-field-label">{label}</span>
      {children}
      {hint ? <small className="template-property-field-hint">{hint}</small> : null}
    </label>
  );
}

function PropertyGroup({
  title,
  description,
  action,
  actionClassName,
  formClassName,
  headClassName,
  children,
}: PropertyGroupProps) {
  return (
    <section className="template-property-group">
      <div className={headClassName ? `template-property-group-head ${headClassName}` : 'template-property-group-head'}>
        <div className="template-property-group-copy">
          <strong>{title}</strong>
          {description ? <span>{description}</span> : null}
        </div>
        {action ? (
          <div className={actionClassName ? `template-property-group-action ${actionClassName}` : 'template-property-group-action'}>
            {action}
          </div>
        ) : null}
      </div>
      <div className={formClassName ? `template-property-form ${formClassName}` : 'template-property-form'}>{children}</div>
    </section>
  );
}

type TemplateImageComboboxProps = {
  selectedImageAsset: PlatformImageAsset | null;
  imageOptions: PlatformImageAsset[];
  onSelectImageAsset: (asset: PlatformImageAsset | null) => void;
};

function TemplateImageCombobox({
  selectedImageAsset,
  imageOptions,
  onSelectImageAsset,
}: TemplateImageComboboxProps) {
  const [query, setQuery] = useState(selectedImageAsset?.displayName ?? '');
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQuery(selectedImageAsset?.displayName ?? '');
  }, [selectedImageAsset?.displayName]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const matchedOptions =
    normalizedQuery.length === 0
      ? []
      : imageOptions.filter(
          (item) =>
            item.displayName.toLowerCase().includes(normalizedQuery) ||
            item.imageId.toLowerCase().includes(normalizedQuery),
        );
  const exactMatchedOption =
    normalizedQuery.length === 0
      ? null
      : imageOptions.find(
          (item) =>
            item.displayName.toLowerCase() === normalizedQuery ||
            item.imageId.toLowerCase() === normalizedQuery,
        ) ?? null;

  function applySelection(asset: PlatformImageAsset | null) {
    onSelectImageAsset(asset);
    setQuery(asset?.displayName ?? '');
    setIsOpen(false);
  }

  return (
    <div className="template-image-combobox" ref={rootRef}>
      <input
        aria-label="镜像名"
        aria-autocomplete="list"
        aria-expanded={isOpen}
        autoComplete="off"
        className="template-image-combobox-input"
        placeholder="请选择平台镜像"
        role="combobox"
        value={query}
        onChange={(event) => {
          const nextValue = event.target.value;
          setQuery(nextValue);
          setIsOpen(nextValue.trim().length > 0);

          const normalizedValue = nextValue.trim().toLowerCase();
          const nextExactMatchedOption =
            normalizedValue.length === 0
              ? null
              : imageOptions.find(
                  (item) =>
                    item.displayName.toLowerCase() === normalizedValue ||
                    item.imageId.toLowerCase() === normalizedValue,
                ) ?? null;

          if (nextExactMatchedOption) {
            onSelectImageAsset(nextExactMatchedOption);
            return;
          }

          if (nextValue.trim().length === 0) {
            onSelectImageAsset(null);
          }
        }}
        onFocus={() => {
          if (query.trim().length > 0) {
            setIsOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setIsOpen(false);
          }

          if (event.key === 'Enter' && exactMatchedOption) {
            event.preventDefault();
            applySelection(exactMatchedOption);
          }
        }}
      />

      {isOpen && matchedOptions.length > 0 ? (
        <div className="template-image-combobox-list" role="listbox" aria-label="平台镜像候选列表">
          {matchedOptions.slice(0, 8).map((item) => {
            const isSelected = selectedImageAsset?.id === item.id;

            return (
              <button
                key={item.id}
                type="button"
                className={isSelected ? 'template-image-combobox-option is-selected' : 'template-image-combobox-option'}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applySelection(item)}
              >
                <span>{item.displayName}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type EcsCustomPasswordFieldProps = {
  nodeId: string;
  value: string | undefined;
  onChange: (nextValue: string) => void;
};

function EcsCustomPasswordField({ nodeId, value, onChange }: EcsCustomPasswordFieldProps) {
  const [isVisible, setIsVisible] = useState(false);
  const customPassword = value ?? '';
  const validationResult =
    customPassword.length > 0 ? validateAliyunEcsPassword(customPassword) : { valid: true, message: null };
  const hint =
    customPassword.length === 0
      ? '留空时，生成实例会为当前 ECS 自动生成随机密码'
      : validationResult.message ?? undefined;

  useEffect(() => {
    setIsVisible(false);
  }, [nodeId]);

  return (
    <PropertyField label="自定义密码" hint={hint} className="template-property-field-full">
      <div>
        <input
          aria-label="自定义密码"
          autoComplete="new-password"
          type={isVisible ? 'text' : 'password'}
          value={customPassword}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label={isVisible ? '隐藏密码' : '显示密码'}
          className="template-property-inline-button"
          onClick={() => setIsVisible((previous) => !previous)}
        >
          {isVisible ? '隐藏' : '显示'}
        </button>
      </div>
    </PropertyField>
  );
}

function renderHostFields(
  selectedNode: EcsTemplateNode,
  allNodes: TemplateNode[],
  platformImageAssets: PlatformImageAsset[],
  instanceTypeAvailability: InstanceTypeAvailabilitySnapshot | null,
  linkedSwitchIdsByHostId: Record<string, string[]>,
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void,
  options?: {
    instanceDetailMode?: boolean;
    runtimeNodeStatus?: string | null;
  },
) {
  const instanceDetailMode = options?.instanceDetailMode ?? false;
  const isLockedByInstanceDetail = instanceDetailMode;
  const selectedNodeWithPlatformImageAsset = selectedNode as EcsTemplateNodeWithPlatformImageAssetId;
  const nicItems = selectedNode.nics ?? [];
  const allSwitchOptions = allNodes.filter((node): node is SwitchTemplateNode => node.kind === 'switch');
  const linkedSwitchIds = linkedSwitchIdsByHostId[selectedNode.id] ?? [];
  const switchOptions =
    linkedSwitchIds.length > 0
      ? allSwitchOptions.filter((node) => linkedSwitchIds.includes(node.id))
      : allSwitchOptions;
  const switchById = new Map(allSwitchOptions.map((node) => [node.id, node]));
  const enabledPlatformImageAssets = platformImageAssets.filter((item) => item.enabled);
  const fallbackPlatformImageAsset =
    selectedNode.imageId || selectedNode.imageName || selectedNode.image
      ? {
          id:
            selectedNodeWithPlatformImageAsset.platformImageAssetId ??
            selectedNode.imageId ??
            selectedNode.image ??
            `${selectedNode.id}-current-image`,
          displayName: selectedNode.imageName ?? selectedNode.image,
          imageId: selectedNode.imageId ?? selectedNode.image,
          provider: 'alibaba_cloud' as const,
          accountUid: null,
          accountScopeKey: '',
          regionId: '',
          sourceScope: 'public' as const,
          enabled: true,
          sourceSnapshotId: null,
          createdAt: null,
          updatedAt: null,
        }
      : null;
  const selectedPlatformImageAsset =
    (selectedNodeWithPlatformImageAsset.platformImageAssetId
      ? enabledPlatformImageAssets.find((item) => item.id === selectedNodeWithPlatformImageAsset.platformImageAssetId) ?? null
      : null) ??
    (selectedNode.imageId
      ? enabledPlatformImageAssets.find((item) => item.imageId === selectedNode.imageId) ?? null
      : null) ??
    fallbackPlatformImageAsset;
  const platformImageOptions =
    selectedPlatformImageAsset && !enabledPlatformImageAssets.some((item) => item.id === selectedPlatformImageAsset.id)
      ? [selectedPlatformImageAsset, ...enabledPlatformImageAssets]
      : enabledPlatformImageAssets;

  function handleSelectPlatformImageAsset(nextPlatformImageAsset: PlatformImageAsset | null) {
    const nextNode: EcsTemplateNodeWithPlatformImageAssetId = {
      ...selectedNode,
      platformImageAssetId: nextPlatformImageAsset?.id,
      image: nextPlatformImageAsset?.displayName ?? selectedNode.image,
      imageName: nextPlatformImageAsset?.displayName ?? selectedNode.imageName,
      imageId: nextPlatformImageAsset?.imageId ?? selectedNode.imageId,
      imageStrategy: {
        mode: 'fixed',
        imageId: nextPlatformImageAsset?.imageId ?? selectedNode.imageId,
      },
    };

    onUpdateNode(selectedNode.id, nextNode);
  }

  function handleAddNic() {
    const nextIndex = nicItems.length + 1;
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nics: [
        ...nicItems,
        {
          id: `${selectedNode.id}-nic-${nextIndex}`,
          switchId: '',
          privateIp: '',
          secondaryIps: [],
          securityGroupRules: [],
        },
      ],
    });
  }

  function handleDeleteNic(nicId: string) {
    if (nicItems.length <= 1) {
      return;
    }

    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nics: nicItems.filter((item) => item.id !== nicId),
    });
  }

  function handleAddNicSecurityRule(nicId: string) {
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nics: nicItems.map((item) =>
        item.id === nicId
          ? {
              ...item,
              securityGroupRules: [
                ...item.securityGroupRules,
                {
                  key: `${nicId}-sg-${item.securityGroupRules.length + 1}`,
                  direction: 'ingress',
                  protocol: 'tcp',
                  portRange: '22/22',
                  sourceCidr: '0.0.0.0/0',
                  policy: 'accept',
                  priority: item.securityGroupRules.length + 1,
                },
              ],
            }
          : item,
      ),
    });
  }

  function buildNodeWithUpdatedCompute(nextPatch: Partial<EcsTemplateNode>) {
    return {
      ...selectedNode,
      ...nextPatch,
      // ponytail: CPU/内存是规格源，改它们时清掉旧实例规格，避免旧 instanceType 把新规格覆盖掉。
      instanceType: undefined,
      instanceTypeStrategy: {
        ...selectedNode.instanceTypeStrategy,
        instanceType: undefined,
      },
    };
  }

  return (
    <>
      <PropertyGroup
        title="基础信息"
        action={<span className="template-property-group-badge">ECS</span>}
        actionClassName="template-property-group-action-badge"
        formClassName="template-property-form-grid"
        headClassName="template-property-group-head-badge"
      >
        <PropertyField label="名称">
          <input
            aria-label="名称"
            disabled={isLockedByInstanceDetail}
            value={selectedNode.label}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                label: event.target.value,
                instanceName: event.target.value,
              })
            }
          />
        </PropertyField>
        <PropertyField label="主机名">
          <input
            aria-label="主机名"
            disabled={isLockedByInstanceDetail}
            value={selectedNode.hostName ?? ''}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                hostName: event.target.value,
              })
            }
          />
        </PropertyField>
        <PropertyField label="镜像名" className="template-property-field-full">
          {instanceDetailMode ? (
            <input aria-label="镜像名" disabled value={selectedNode.imageName ?? selectedNode.image ?? ''} />
          ) : (
            <TemplateImageCombobox
              selectedImageAsset={selectedPlatformImageAsset}
              imageOptions={platformImageOptions}
              onSelectImageAsset={handleSelectPlatformImageAsset}
            />
          )}
        </PropertyField>
        <PropertyField label="CPU">
          <input
            aria-label="CPU"
            type="number"
            value={selectedNode.cpu ?? 1}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, buildNodeWithUpdatedCompute({
                cpu: Number(event.target.value) || 1,
              }))
            }
          />
        </PropertyField>
        <PropertyField label="内存">
          <input
            aria-label="内存"
            type="number"
            value={selectedNode.memory ?? 2}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, buildNodeWithUpdatedCompute({
                memory: Number(event.target.value) || 1,
              }))
            }
          />
        </PropertyField>
        {instanceDetailMode ? (
          <PropertyField label="自定义密码" hint="实例详情页不支持实时修改自定义密码。">
            <input aria-label="自定义密码" disabled value={selectedNode.customPassword ?? ''} />
          </PropertyField>
        ) : (
          <EcsCustomPasswordField
            nodeId={selectedNode.id}
            value={selectedNode.customPassword}
            onChange={(nextValue) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                customPassword: nextValue,
              })
            }
          />
        )}
        {instanceTypeAvailability?.warning ? (
          <div className="template-property-warning-note" role="status">
            {instanceTypeAvailability.warning}
          </div>
        ) : null}
      </PropertyGroup>

      <PropertyGroup
        title="网卡配置"
        action={
          <button type="button" className="template-property-inline-button" disabled={instanceDetailMode} onClick={handleAddNic}>
            添加网卡
          </button>
        }
      >
        {nicItems.map((nic, index) => {
          const selectedSwitch = switchById.get(nic.switchId) ?? null;
          const ipHint = selectedSwitch ? `仅允许 ${selectedSwitch.cidr} 网段` : '仅允许已连接交换机的网段';
          const ipError =
            selectedSwitch && nic.privateIp && isCompleteIpv4(nic.privateIp) && !isIpv4InCidr(nic.privateIp, selectedSwitch.cidr)
              ? `私网 IP 不在 ${selectedSwitch.cidr} 网段内`
              : undefined;
          const secondaryIpError =
            selectedSwitch &&
            nic.secondaryIps.some((ip) => isCompleteIpv4(ip) && !isIpv4InCidr(ip, selectedSwitch.cidr))
              ? `辅助 IP 不在 ${selectedSwitch.cidr} 网段内`
              : undefined;

          return (
            <div key={nic.id} className="template-property-card">
            <div className="template-property-card-head">
              <strong className="template-property-card-title">网卡 {index + 1}</strong>
              <div className="template-property-card-actions">
                <button
                  type="button"
                  className="template-property-inline-button"
                  onClick={() => handleAddNicSecurityRule(nic.id)}
                >
                  添加安全规则 {index + 1}
                </button>
                <button
                  type="button"
                  className="template-property-inline-button is-danger"
                  disabled={instanceDetailMode || nicItems.length <= 1}
                  aria-label={`删除网卡 ${index + 1}`}
                  onClick={() => handleDeleteNic(nic.id)}
                >
                  删除网卡
                </button>
              </div>
            </div>
            <div className="template-property-card-grid">
              <PropertyField label="交换机标识" className="template-property-field-full">
                <select
                  aria-label={`交换机标识 ${index + 1}`}
                  disabled={instanceDetailMode}
                  value={nic.switchId}
                  onChange={(event) => {
                    const nextSwitch = switchById.get(event.target.value) ?? null;

                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nics: nicItems.map((item) =>
                        item.id === nic.id
                          ? {
                              ...item,
                              switchId: event.target.value,
                            }
                          : item,
                      ),
                    });
                  }}
                >
                  <option value="">未连接交换机</option>
                  {switchOptions.map((switchNode) => (
                    <option key={switchNode.id} value={switchNode.id}>
                      {switchNode.label}
                    </option>
                  ))}
                </select>
              </PropertyField>
              <PropertyField label="私网 IP" hint={ipError ?? ipHint} className="template-property-field-full">
                <input
                  aria-label={`私网 IP ${index + 1}`}
                  disabled={instanceDetailMode || !selectedSwitch}
                  value={nic.privateIp}
                  onChange={(event) => {
                    const nextValue = event.target.value.trim();

                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nics: nicItems.map((item) =>
                        item.id === nic.id
                          ? {
                              ...item,
                              privateIp: nextValue,
                            }
                          : item,
                      ),
                    });
                  }}
                />
              </PropertyField>
              <PropertyField label="辅助 IP" hint={secondaryIpError ?? ipHint} className="template-property-field-full">
                <input
                  aria-label={`辅助 IP ${index + 1}`}
                  disabled={!selectedSwitch}
                  value={nic.secondaryIps.join(',')}
                  onChange={(event) => {
                    const nextIps = parseMultiLineList(event.target.value);

                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nics: nicItems.map((item) =>
                        item.id === nic.id
                          ? {
                              ...item,
                              secondaryIps: selectedSwitch ? nextIps : [],
                            }
                          : item,
                      ),
                    });
                  }}
                />
              </PropertyField>
            </div>
            {nic.securityGroupRules.map((rule, ruleIndex) => (
              <div key={rule.key} className="template-property-card template-property-card-sub">
                <div className="template-property-card-head">
                  <strong className="template-property-card-title">安全规则 {index + 1}-{ruleIndex + 1}</strong>
                  <button
                    type="button"
                    className="template-property-inline-button is-danger"
                    aria-label={`删除安全规则 ${index + 1}-${ruleIndex + 1}`}
                    onClick={() =>
                      onUpdateNode(selectedNode.id, {
                        ...selectedNode,
                        nics: nicItems.map((item) =>
                          item.id === nic.id
                            ? {
                                ...item,
                                securityGroupRules: item.securityGroupRules.filter(
                                  (securityRule) => securityRule.key !== rule.key,
                                ),
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    删除
                  </button>
                </div>
                <div className="template-property-card-grid">
                  <PropertyField label="方向">
                    <select
                      aria-label={`安全方向 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.direction}
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, {
                          ...selectedNode,
                          nics: nicItems.map((item) =>
                            item.id === nic.id
                              ? {
                                  ...item,
                                  securityGroupRules: item.securityGroupRules.map((securityRule) =>
                                    securityRule.key === rule.key
                                      ? { ...securityRule, direction: event.target.value as typeof securityRule.direction }
                                      : securityRule,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="ingress">ingress</option>
                      <option value="egress">egress</option>
                    </select>
                  </PropertyField>
                  <PropertyField label="协议">
                    <select
                      aria-label={`安全协议 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.protocol}
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, {
                          ...selectedNode,
                          nics: nicItems.map((item) =>
                            item.id === nic.id
                              ? {
                                  ...item,
                                  securityGroupRules: item.securityGroupRules.map((securityRule) =>
                                    securityRule.key === rule.key
                                      ? { ...securityRule, protocol: event.target.value }
                                      : securityRule,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="tcp">tcp</option>
                      <option value="udp">udp</option>
                      <option value="icmp">icmp</option>
                      <option value="all">all</option>
                    </select>
                  </PropertyField>
                  <PropertyField label="端口范围">
                    <input
                      aria-label={`安全端口 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.portRange}
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, {
                          ...selectedNode,
                          nics: nicItems.map((item) =>
                            item.id === nic.id
                              ? {
                                  ...item,
                                  securityGroupRules: item.securityGroupRules.map((securityRule) =>
                                    securityRule.key === rule.key
                                      ? { ...securityRule, portRange: event.target.value }
                                      : securityRule,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </PropertyField>
                  <PropertyField label="安全策略">
                    <select
                      aria-label={`安全策略 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.policy}
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, {
                          ...selectedNode,
                          nics: nicItems.map((item) =>
                            item.id === nic.id
                              ? {
                                  ...item,
                                  securityGroupRules: item.securityGroupRules.map((securityRule) =>
                                    securityRule.key === rule.key
                                      ? { ...securityRule, policy: event.target.value as typeof securityRule.policy }
                                      : securityRule,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="accept">accept</option>
                      <option value="drop">drop</option>
                    </select>
                  </PropertyField>
                  <PropertyField label="安全优先级">
                    <input
                      aria-label={`安全优先级 ${index + 1}-${ruleIndex + 1}`}
                      type="number"
                      value={rule.priority}
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, {
                          ...selectedNode,
                          nics: nicItems.map((item) =>
                            item.id === nic.id
                              ? {
                                  ...item,
                                  securityGroupRules: item.securityGroupRules.map((securityRule) =>
                                    securityRule.key === rule.key
                                      ? { ...securityRule, priority: Number(event.target.value) || 1 }
                                      : securityRule,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </PropertyField>
                  <PropertyField label="源网段">
                    <input
                      aria-label={`安全源网段 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.sourceCidr}
                      onChange={(event) =>
                        onUpdateNode(selectedNode.id, {
                          ...selectedNode,
                          nics: nicItems.map((item) =>
                            item.id === nic.id
                              ? {
                                  ...item,
                                  securityGroupRules: item.securityGroupRules.map((securityRule) =>
                                    securityRule.key === rule.key
                                      ? { ...securityRule, sourceCidr: event.target.value }
                                      : securityRule,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </PropertyField>
                </div>
              </div>
            ))}
            </div>
          );
        })}
      </PropertyGroup>

      <PropertyGroup title="初始化脚本">
        <div className="template-property-field">
          <textarea
            aria-label="初始化脚本"
            disabled={instanceDetailMode}
            rows={4}
            value={selectedNode.initScript}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                initScript: event.target.value,
              })
            }
          />
        </div>
      </PropertyGroup>
    </>
  );
}

function renderSwitchFields(
  selectedNode: SwitchTemplateNode,
  allNodes: TemplateNode[],
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void,
) {
  const aclRules = selectedNode.aclRules ?? [];
  const dnatMappings = selectedNode.nat?.dnatMappings ?? [];
  const hostOptions = allNodes.filter((node): node is EcsTemplateNode => node.kind === 'ecs');
  const cidrParts = parseCidrParts(selectedNode.cidr);
  const dnatPortConflictsByMappingKey = new Map<string, DnatExternalPortConflict>();

  findDuplicateDnatExternalPorts(allNodes).forEach((conflict) => {
    conflict.usages.forEach((usage) => {
      dnatPortConflictsByMappingKey.set(usage.mappingKey, conflict);
    });
  });
  function handleAddAclRule() {
    const nextIndex = aclRules.length + 1;
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      aclRules: [
        ...aclRules,
        {
          key: `${selectedNode.id}-acl-${nextIndex}`,
          direction: 'inbound',
          protocol: 'tcp',
          portRange: '22/22',
          sourceCidr: '0.0.0.0/0',
          destinationCidr: selectedNode.cidr,
          policy: 'allow',
          priority: nextIndex,
        },
      ],
    });
  }

  function handleAddDnatRule() {
    const nextIndex = dnatMappings.length + 1;
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nat: {
        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
        dnatMappings: [
          ...dnatMappings,
          {
            key: `${selectedNode.id}-dnat-${nextIndex}`,
            targetHostId: '',
            externalPort: 8080,
            internalPort: 80,
            protocol: 'tcp',
          },
        ],
      },
    });
  }

  return (
    <>
      <PropertyGroup
        title="基础信息"
        action={<span className="template-property-group-badge">交换机</span>}
        actionClassName="template-property-group-action-badge"
        formClassName="template-property-form-grid template-property-form-grid-switch"
        headClassName="template-property-group-head-badge"
      >
        <PropertyField label="名称">
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
        </PropertyField>
        <PropertyField label="描述" className="template-property-field-switch-description-inline">
          <textarea
            aria-label="描述"
            rows={3}
            placeholder="请输入描述"
            value={selectedNode.description ?? ''}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                description: event.target.value,
              })
            }
          />
        </PropertyField>
      </PropertyGroup>

      <PropertyGroup title="网段配置" formClassName="template-property-form">
        <div className="template-switch-cidr-field">
          <div className="template-switch-cidr-shell">
            <input
              className="template-switch-cidr-octet"
              aria-label="CIDR 第一段"
              value={cidrParts.first}
              onChange={(event) =>
                onUpdateNode(selectedNode.id, {
                  ...selectedNode,
                  cidr: buildCidrFromParts({
                    first: event.target.value,
                    second: cidrParts.second,
                    third: cidrParts.third,
                    prefix: cidrParts.prefix,
                  }),
                })
              }
            />
            <span className="template-switch-cidr-separator">.</span>
            <input
              className="template-switch-cidr-octet"
              aria-label="CIDR 第二段"
              value={cidrParts.second}
              onChange={(event) =>
                onUpdateNode(selectedNode.id, {
                  ...selectedNode,
                  cidr: buildCidrFromParts({
                    first: cidrParts.first,
                    second: event.target.value,
                    third: cidrParts.third,
                    prefix: cidrParts.prefix,
                  }),
                })
              }
            />
            <span className="template-switch-cidr-separator">.</span>
            <input
              className="template-switch-cidr-octet"
              aria-label="CIDR 第三段"
              value={cidrParts.third}
              onChange={(event) =>
                onUpdateNode(selectedNode.id, {
                  ...selectedNode,
                  cidr: buildCidrFromParts({
                    first: cidrParts.first,
                    second: cidrParts.second,
                    third: event.target.value,
                    prefix: cidrParts.prefix,
                  }),
                })
              }
            />
            <span className="template-switch-cidr-separator">.</span>
            <input
              className="template-switch-cidr-octet template-switch-cidr-octet-readonly"
              aria-label="CIDR 第四段"
              value="0"
              readOnly
              tabIndex={-1}
            />
            <span className="template-switch-cidr-slash">/</span>
            <input
              className="template-switch-cidr-prefix"
              aria-label="CIDR 前缀"
              value={cidrParts.prefix}
              onChange={(event) =>
                onUpdateNode(selectedNode.id, {
                  ...selectedNode,
                  cidr: buildCidrFromParts({
                    first: cidrParts.first,
                    second: cidrParts.second,
                    third: cidrParts.third,
                    prefix: event.target.value,
                  }),
                })
              }
            />
          </div>
        </div>
      </PropertyGroup>

      <PropertyGroup
        title="ACL 配置"
        action={
          <button type="button" className="template-property-inline-button" onClick={handleAddAclRule}>
            添加 ACL 规则
          </button>
        }
      >
        {aclRules.length === 0 ? <p className="template-property-empty-note">暂无 ACL 规则</p> : null}
        {aclRules.map((rule, index) => (
          <div key={rule.key} className="template-property-card">
            <div className="template-property-card-head">
              <strong className="template-property-card-title">ACL 规则 {index + 1}</strong>
              <button
                type="button"
                className="template-property-inline-button is-danger"
                aria-label={`删除 ACL 规则 ${index + 1}`}
                onClick={() =>
                  onUpdateNode(selectedNode.id, {
                    ...selectedNode,
                    aclRules: aclRules.filter((item) => item.key !== rule.key),
                  })
                }
              >
                删除
              </button>
            </div>
            <div className="template-property-card-grid template-property-card-grid-compact">
              <PropertyField label="方向">
                <select
                  aria-label={`ACL 方向 ${index + 1}`}
                  value={rule.direction}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, direction: event.target.value as typeof item.direction } : item,
                      ),
                    })
                  }
                >
                  <option value="inbound">inbound</option>
                  <option value="outbound">outbound</option>
                </select>
              </PropertyField>
              <PropertyField label="协议">
                <select
                  aria-label={`ACL 协议 ${index + 1}`}
                  value={rule.protocol}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, protocol: event.target.value } : item,
                      ),
                    })
                  }
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                  <option value="icmp">icmp</option>
                  <option value="all">all</option>
                </select>
              </PropertyField>
              <PropertyField label="端口范围">
                <input
                  aria-label={`ACL 端口范围 ${index + 1}`}
                  value={rule.portRange}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, portRange: event.target.value } : item,
                      ),
                    })
                  }
                />
              </PropertyField>
              <PropertyField label="ACL 策略">
                <select
                  aria-label={`ACL 策略 ${index + 1}`}
                  value={rule.policy}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, policy: event.target.value as typeof item.policy } : item,
                      ),
                    })
                  }
                >
                  <option value="allow">allow</option>
                  <option value="drop">drop</option>
                </select>
              </PropertyField>
              <PropertyField label="ACL 优先级">
                <input
                  aria-label={`ACL 优先级 ${index + 1}`}
                  type="number"
                  value={rule.priority}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, priority: Number(event.target.value) || 1 } : item,
                      ),
                    })
                  }
                />
              </PropertyField>
              <PropertyField label="源网段" className="template-property-field-full">
                <input
                  aria-label={`ACL 源网段 ${index + 1}`}
                  value={rule.sourceCidr}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, sourceCidr: event.target.value } : item,
                      ),
                    })
                  }
                />
              </PropertyField>
              <PropertyField label="目标网段" className="template-property-field-full">
                <input
                  aria-label={`ACL 目标网段 ${index + 1}`}
                  value={rule.destinationCidr ?? ''}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, destinationCidr: event.target.value } : item,
                      ),
                    })
                  }
                />
              </PropertyField>
            </div>
          </div>
        ))}
      </PropertyGroup>

      <PropertyGroup
        title="NAT 配置"
        action={
          <button type="button" className="template-property-inline-button" onClick={handleAddDnatRule}>
            添加 DNAT 规则
          </button>
        }
      >
        <label className="template-property-check template-property-check-card">
          <input
            type="checkbox"
            checked={selectedNode.nat?.snatEnabled ?? false}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                nat: {
                  snatEnabled: event.target.checked,
                  dnatMappings: selectedNode.nat?.dnatMappings ?? [],
                },
              })
            }
          />
          <span>允许访问互联网（SNAT）</span>
        </label>
        {dnatMappings.length === 0 ? <p className="template-property-empty-note">暂无 DNAT 规则</p> : null}
        {dnatMappings.map((mapping, index) => (
          <div key={mapping.key} className="template-property-card">
            <div className="template-property-card-head">
              <strong className="template-property-card-title">DNAT 规则 {index + 1}</strong>
              <button
                type="button"
                className="template-property-inline-button is-danger"
                aria-label={`删除 DNAT 规则 ${index + 1}`}
                onClick={() =>
                  onUpdateNode(selectedNode.id, {
                    ...selectedNode,
                    nat: {
                      snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                      dnatMappings: dnatMappings.filter((item) => item.key !== mapping.key),
                    },
                  })
                }
              >
                删除
              </button>
            </div>
            <div className="template-property-card-grid template-property-card-grid-compact">
              <PropertyField label="目标主机" className="template-property-field-full">
                <select
                  aria-label={`DNAT 目标主机 ${index + 1}`}
                  value={mapping.targetHostId}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nat: {
                        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                        dnatMappings: dnatMappings.map((item) =>
                          item.key === mapping.key ? { ...item, targetHostId: event.target.value } : item,
                        ),
                      },
                    })
                  }
                >
                  <option value="">未选择</option>
                  {hostOptions.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.label}
                    </option>
                  ))}
                </select>
              </PropertyField>
              <PropertyField label="公网端口">
                <input
                  aria-label={`DNAT 公网端口 ${index + 1}`}
                  aria-invalid={dnatPortConflictsByMappingKey.has(mapping.key)}
                  type="number"
                  value={mapping.externalPort}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nat: {
                        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                        dnatMappings: dnatMappings.map((item) =>
                          item.key === mapping.key ? { ...item, externalPort: Number(event.target.value) || 0 } : item,
                        ),
                      },
                    })
                  }
                />
              </PropertyField>
              {dnatPortConflictsByMappingKey.has(mapping.key) ? (
                <p className="template-property-warning-note" role="alert">
                  公网端口 {mapping.externalPort} 已被
                  {' '}
                  {dnatPortConflictsByMappingKey
                    .get(mapping.key)!
                    .usages.filter((usage) => usage.mappingKey !== mapping.key)
                    .map((usage) => `${usage.switchLabel} 的 DNAT 规则 ${usage.mappingIndex + 1}`)
                    .join('、')}
                  使用。当前拓扑共享 DNAT IP，公网端口必须唯一。
                </p>
              ) : null}
              <PropertyField label="内网端口">
                <input
                  aria-label={`DNAT 内网端口 ${index + 1}`}
                  type="number"
                  value={mapping.internalPort}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nat: {
                        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                        dnatMappings: dnatMappings.map((item) =>
                          item.key === mapping.key ? { ...item, internalPort: Number(event.target.value) || 0 } : item,
                        ),
                      },
                    })
                  }
                />
              </PropertyField>
              <PropertyField label="协议">
                <select
                  aria-label={`DNAT 协议 ${index + 1}`}
                  value={mapping.protocol}
                  onChange={(event) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nat: {
                        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                        dnatMappings: dnatMappings.map((item) =>
                          item.key === mapping.key ? { ...item, protocol: event.target.value as typeof item.protocol } : item,
                        ),
                      },
                    })
                  }
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
              </PropertyField>
            </div>
          </div>
        ))}
      </PropertyGroup>
    </>
  );
}

function renderRouterFields(
  selectedNode: RouterTemplateNode,
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void,
) {
  return (
    <>
      <PropertyGroup
        title="基础信息"
        action={<span className="template-property-group-badge">路由器</span>}
        actionClassName="template-property-group-action-badge"
        formClassName="template-property-form-grid template-property-form-grid-switch"
        headClassName="template-property-group-head-badge"
      >
        <PropertyField label="名称">
          <input
            aria-label="名称"
            value={selectedNode.label}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                label: event.target.value,
              })
            }
          />
        </PropertyField>
        <PropertyField label="描述" className="template-property-field-switch-description-inline">
          <textarea
            aria-label="路由描述"
            rows={3}
            placeholder="请输入描述"
            value={selectedNode.description ?? ''}
            onChange={(event) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                description: event.target.value,
              })
            }
          />
        </PropertyField>
      </PropertyGroup>
    </>
  );
}

function renderNodeGroups(
  selectedNode: TemplateNode,
  allNodes: TemplateNode[],
  platformImageAssets: PlatformImageAsset[],
  instanceTypeAvailability: InstanceTypeAvailabilitySnapshot | null,
  linkedSwitchIdsByHostId: Record<string, string[]>,
  onUpdateNode: (nodeId: string, nextNode: TemplateNode) => void,
  options?: {
    instanceDetailMode?: boolean;
    runtimeNodeStatus?: string | null;
  },
) {
  switch (selectedNode.kind) {
    case 'ecs':
      return renderHostFields(
        selectedNode,
        allNodes,
        platformImageAssets,
        instanceTypeAvailability,
        linkedSwitchIdsByHostId,
        onUpdateNode,
        options,
      );
    case 'switch':
      return renderSwitchFields(selectedNode, allNodes, onUpdateNode);
    case 'router':
      return renderRouterFields(selectedNode, onUpdateNode);
    default:
      return null;
  }
}

export function TemplatePropertyPanel({
  selectedNode,
  allNodes,
  platformImageAssets = [],
  instanceTypeAvailability = null,
  linkedSwitchIdsByHostId = {},
  onUpdateNode,
  readOnly = false,
  instanceDetailMode = false,
  runtimeNodeStatus = null,
}: TemplatePropertyPanelProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (shellRef.current) {
      shellRef.current.scrollTop = 0;
    }
  }, [selectedNode?.id]);

  return (
    <aside className="template-editor-panel template-property-panel">
      <div className="admin-section-header template-property-panel-header">
        <h2>属性面板</h2>
      </div>

      <div ref={shellRef} className="template-property-shell">
        {selectedNode ? (
          <fieldset className="template-property-readonly-shell" disabled={readOnly}>
            <div className="template-property-stack">
              {renderNodeGroups(
                selectedNode,
                allNodes,
              platformImageAssets,
              instanceTypeAvailability,
              linkedSwitchIdsByHostId,
              onUpdateNode,
              {
                instanceDetailMode,
                runtimeNodeStatus,
              },
            )}
            </div>
          </fieldset>
        ) : (
          <div className="template-property-placeholder">
            <strong>选择节点后配置</strong>
          </div>
        )}
      </div>
    </aside>
  );
}
