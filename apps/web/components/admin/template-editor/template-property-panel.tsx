'use client';

import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

import React, { type ReactNode, createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import { nextAvailableGraphId, validateAliyunEcsPassword } from '@aliyun-cyber-range/scenario-runtime';
import type { InstanceTypeAvailabilitySnapshot, PlatformImageAsset } from '../../../lib/admin-types';
import type {
  DnatExternalPortConflict,
  EcsTemplateNode,
  RouterTemplateNode,
  SwitchTemplateNode,
  TemplateNode,
} from '../../../lib/scenario-graph';
import {
  findDuplicateDnatExternalPorts,
  getEffectiveSecurityGroupRules,
} from '../../../lib/scenario-graph';
import { AdminSelectField } from '../shared/admin-select-field';
import { hostDnsErrors } from '../../../lib/host-dns';
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
  runtimeExistingNode?: boolean;
  runtimeNodeStatus?: string | null;
  onClose?: () => void;
};

type PropertyFieldProps = {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
};

type PropertyGroupProps = {
  title: string;
  disabled?: boolean;
  description?: string;
  action?: ReactNode;
  actionClassName?: string;
  formClassName?: string;
  headClassName?: string;
  children: ReactNode;
};

function getPortRangePlaceholder(protocol: string) {
  switch (protocol.trim().toLowerCase()) {
    case 'all':
      return '全端口：1/65535';
    case 'icmp':
      return '全部类型：-1/-1';
    default:
      return '如：80/80';
  }
}

const SOURCE_CIDR_PLACEHOLDER = '如：10.0.0.0/24';

function parseMultiLineList(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatMultiLineList(values: string[] | undefined) {
  return (values ?? []).join('\n');
}

function DnsServerField({ servers, invalid, onChange }: { servers: string[]; invalid: boolean; onChange: (servers: string[]) => void }) {
  const [draft, setDraft] = useState(() => formatMultiLineList(servers));
  useEffect(() => {
    setDraft((current) => JSON.stringify(parseMultiLineList(current)) === JSON.stringify(servers) ? current : formatMultiLineList(servers));
  }, [servers]);
  return <Textarea aria-label="DNS 服务器" aria-invalid={invalid} rows={3} placeholder={'10.0.50.10\n10.0.50.11'} value={draft}
    onChange={(event) => { setDraft(event.target.value); onChange(parseMultiLineList(event.target.value)); }} />;
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

const PropertyDisabledContext = createContext(false);

function PropertyFields({ disabled = false, className = '', children }: { disabled?: boolean; className?: string; children: ReactNode }) {
  const inheritedDisabled = useContext(PropertyDisabledContext);
  const isDisabled = disabled || inheritedDisabled;
  return (
    <PropertyDisabledContext.Provider value={isDisabled}>
      <fieldset className={`min-w-0 border-0 p-0 ${className}`} disabled={isDisabled}>
        {children}
      </fieldset>
    </PropertyDisabledContext.Provider>
  );
}

function PropertyField({ label, hint, className, children }: PropertyFieldProps) {
  const generatedId = useId();
  const child = React.isValidElement<{ id?: string }>(children) ? children : null;
  const canLabel = child && (child.type === Input || child.type === Textarea);
  const fieldId = canLabel ? child.props.id ?? generatedId : undefined;
  return (
    <div className={className ? `template-property-field ${className}` : 'template-property-field'}>
      <Label className="template-property-field-label" htmlFor={fieldId}>{label}</Label>
      {canLabel ? React.cloneElement(child, { id: fieldId }) : children}
      {hint ? <small className="template-property-field-hint">{hint}</small> : null}
    </div>
  );
}

function PropertyCheckbox(props: React.ComponentProps<typeof Checkbox>) {
  const inheritedDisabled = useContext(PropertyDisabledContext);
  return <Checkbox {...props} disabled={props.disabled || inheritedDisabled} />;
}

function PropertySelect({
  ariaLabel,
  disabled,
  emptyOptionLabel,
  onValueChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  emptyOptionLabel?: string;
  onValueChange: (value: string) => void;
  options: readonly { label: string; value: string; disabled?: boolean }[];
  value: string;
}) {
  const inheritedDisabled = useContext(PropertyDisabledContext);
  const isDisabled = Boolean(disabled || inheritedDisabled);
  return (
    <AdminSelectField
      ariaLabel={ariaLabel}
      className="w-full"
      disabled={isDisabled}
      emptyOptionLabel={emptyOptionLabel}
      onValueChange={(value) => { if (!isDisabled) onValueChange(value); }}
      options={options}
      value={value}
    />
  );
}

function PropertyGroup({
  title,
  disabled,
  description,
  action,
  actionClassName,
  formClassName,
  headClassName,
  children,
}: PropertyGroupProps) {
  return (
    <PropertyFields className="template-property-group" disabled={disabled}>
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
    </PropertyFields>
  );
}

type TemplateImageComboboxProps = {
  selectedImageAsset: PlatformImageAsset | null;
  imageOptions: PlatformImageAsset[];
  onSelectImageAsset: (asset: PlatformImageAsset | null) => void;
};

function TemplateImageCombobox({ selectedImageAsset, imageOptions, onSelectImageAsset }: TemplateImageComboboxProps) {
  const disabled = useContext(PropertyDisabledContext);
  const [query, setQuery] = useState(selectedImageAsset?.displayName ?? '');
  useEffect(() => { setQuery(selectedImageAsset?.displayName ?? ''); }, [selectedImageAsset?.displayName]);

  return <Combobox
    ariaLabel="镜像名"
    disabled={disabled}
    placeholder="请选择平台镜像"
    value={query}
    selectedValue={selectedImageAsset?.id}
    options={imageOptions.map((image) => ({ value: image.id, label: image.displayName, description: image.imageId }))}
    onValueChange={(value) => {
      const normalized = value.trim().toLowerCase();
      const asset = imageOptions.find((image) => image.id === value || image.displayName.toLowerCase() === normalized || image.imageId.toLowerCase() === normalized);
      setQuery(asset?.displayName ?? value);
      if (asset || !normalized) onSelectImageAsset(asset ?? null);
    }}
  />;
}

type EcsCustomPasswordFieldProps = {
  value: string | undefined;
  onChange: (nextValue: string) => void;
};

function EcsCustomPasswordField({ value, onChange }: EcsCustomPasswordFieldProps) {
  const customPassword = value ?? '';
  const validationResult =
    customPassword.length > 0 ? validateAliyunEcsPassword(customPassword) : { valid: true, code: null, message: null };
  const hint =
    customPassword.length === 0
      ? '留空时，生成实例会为当前 ECS 自动生成随机密码'
      : validationResult.message ?? undefined;

  return (
    <PropertyField label="自定义密码" hint={hint} className="template-property-field-full">
      <div>
        <Input
          aria-label="自定义密码"
          autoComplete="new-password"
          type="text"
          value={customPassword}
          onChange={(event) => onChange(event.target.value)}
        />
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
    runtimeNodeStatus?: string | null;
    runtimeExistingNode?: boolean;
  },
) {
  const nicItems = selectedNode.nics ?? [];
  const allSwitchOptions = allNodes.filter((node): node is SwitchTemplateNode => node.kind === 'switch');
  const linkedSwitchIds = linkedSwitchIdsByHostId[selectedNode.id] ?? [];
  const switchOptions =
    linkedSwitchIds.length > 0
      ? allSwitchOptions.filter((node) => linkedSwitchIds.includes(node.id))
      : allSwitchOptions;
  const switchById = new Map(allSwitchOptions.map((node) => [node.id, node]));
  const enabledPlatformImageAssets = platformImageAssets.filter((item) => item.enabled);
  const selectedPlatformImageAsset =
    selectedNode.platformImageAssetId
      ? enabledPlatformImageAssets.find((item) => item.id === selectedNode.platformImageAssetId) ?? null
      : null;
  const platformImageOptions = enabledPlatformImageAssets;
  const dnsErrors = hostDnsErrors(selectedNode);
  const selectedImageOs = selectedPlatformImageAsset?.osType?.toLowerCase();
  const dnsUnavailable = Boolean(selectedImageOs && selectedImageOs !== 'windows');

  function handleSelectPlatformImageAsset(nextPlatformImageAsset: PlatformImageAsset | null) {
    const nextNode: EcsTemplateNode = {
      ...selectedNode,
      platformImageAssetId: nextPlatformImageAsset?.id,
      image: nextPlatformImageAsset?.displayName ?? '',
      imageName: nextPlatformImageAsset?.displayName ?? '',
      imageId: nextPlatformImageAsset?.imageId ?? '',
      imageStrategy: {
        mode: 'fixed',
        ...(nextPlatformImageAsset ? { imageId: nextPlatformImageAsset.imageId } : {}),
      },
    };

    onUpdateNode(selectedNode.id, nextNode);
  }

  function handleAddNic() {
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nics: [
        ...nicItems,
        {
          id: nextAvailableGraphId(`${selectedNode.id}-nic`, nicItems.map((nic) => nic.id)),
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

  function updateNicSecurityGroupRules(
    nicId: string,
    updateRules: (rules: ReturnType<typeof getEffectiveSecurityGroupRules>) => ReturnType<typeof getEffectiveSecurityGroupRules>,
  ) {
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nics: nicItems.map((item, index) =>
        item.id === nicId
          ? {
              ...item,
              securityGroupRulesMode: 'custom',
              securityGroupRules: updateRules(index === 0 ? getEffectiveSecurityGroupRules(item) : item.securityGroupRules),
            }
          : item,
      ),
    });
  }

  function handleAddNicSecurityRule(nicId: string) {
    updateNicSecurityGroupRules(nicId, (rules) => [
      ...rules,
      {
        key: nextAvailableGraphId(`${nicId}-sg`, rules.map((rule) => rule.key)),
        direction: 'ingress',
        protocol: 'tcp',
        portRange: '22/22',
        sourceCidr: '0.0.0.0/0',
        policy: 'accept',
        priority: rules.length + 1,
      },
    ]);
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
        disabled={options?.runtimeExistingNode}
        action={<span className="template-property-group-badge">ECS</span>}
        actionClassName="template-property-group-action-badge"
        formClassName="template-property-form-grid"
        headClassName="template-property-group-head-badge"
      >
        <PropertyField label="名称">
          <Input
            aria-label="名称"
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
          <Input
            aria-label="主机名"
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
          <TemplateImageCombobox
            selectedImageAsset={selectedPlatformImageAsset}
            imageOptions={platformImageOptions}
            onSelectImageAsset={handleSelectPlatformImageAsset}
          />
        </PropertyField>
        <PropertyField label="CPU">
          <Input
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
          <Input
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
        <EcsCustomPasswordField
          value={selectedNode.customPassword}
          onChange={(nextValue) =>
            onUpdateNode(selectedNode.id, {
              ...selectedNode,
              customPassword: nextValue,
            })
          }
        />
        {instanceTypeAvailability?.warning ? (
          <div className="template-property-warning-note" role="status">
            {instanceTypeAvailability.warning}
          </div>
        ) : null}
      </PropertyGroup>

      <PropertyGroup
        title="网卡配置"
        action={
          <Button variant="ghost" type="button" className="template-property-inline-button" disabled={options?.runtimeExistingNode} onClick={handleAddNic}>
            添加网卡
          </Button>
        }
      >
        {nicItems.map((nic, index) => {
          const isPrimaryNic = index === 0;
          const securityGroupRules = isPrimaryNic ? getEffectiveSecurityGroupRules(nic) : nic.securityGroupRules;
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
                  <Button variant="ghost"
                    type="button"
                    className="template-property-inline-button"
                    onClick={() => handleAddNicSecurityRule(nic.id)}
                  >
                    添加安全规则
                  </Button>
                  <Button variant="ghost"
                    type="button"
                    className="template-property-inline-button is-danger"
                    disabled={Boolean(options?.runtimeExistingNode) || nicItems.length <= 1}
                    aria-label={`删除网卡 ${index + 1}`}
                    onClick={() => handleDeleteNic(nic.id)}
                  >
                    删除网卡
                  </Button>
                </div>
              </div>
              <PropertyFields className="template-property-card-grid" disabled={options?.runtimeExistingNode}>
                <PropertyField label="交换机标识" className="template-property-field-full">
                  <PropertySelect
                    ariaLabel={`交换机标识 ${index + 1}`}
                    value={nic.switchId}
                    emptyOptionLabel="未连接交换机"
                    onValueChange={(nextValue) => {
                      onUpdateNode(selectedNode.id, {
                        ...selectedNode,
                        nics: nicItems.map((item) =>
                          item.id === nic.id
                            ? {
                                ...item,
                                switchId: nextValue,
                              }
                            : item,
                        ),
                      });
                    }}
                    options={switchOptions.map((switchNode) => ({ label: switchNode.label, value: switchNode.id }))}
                  />
                </PropertyField>
                <PropertyField label="私网 IP" hint={ipError ?? ipHint} className="template-property-field-full">
                  <Input
                    aria-label={`私网 IP ${index + 1}`}
                    disabled={!selectedSwitch}
                    value={nic.privateIp}
                    onChange={(event) => {
                      const nextValue = event.target.value.trim();

                      onUpdateNode(selectedNode.id, {
                        ...selectedNode,
                        ...(isPrimaryNic ? { privateIp: nextValue } : {}),
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
                  <Input
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
              </PropertyFields>
              <div className="template-property-card-sub-list">
                {securityGroupRules.map((rule, ruleIndex) => (
                  <div key={rule.key} className="template-property-card template-property-card-sub">
                <div className="template-property-card-head">
                  <strong className="template-property-card-title">安全规则 {index + 1}-{ruleIndex + 1}</strong>
                  <Button variant="ghost"
                    type="button"
                  className="template-property-inline-button is-danger"
                  aria-label={`删除安全规则 ${index + 1}-${ruleIndex + 1}`}
                  onClick={() =>
                    updateNicSecurityGroupRules(nic.id, (rules) =>
                      rules.filter((securityRule) => securityRule.key !== rule.key),
                    )
                  }
                  >
                    删除
                  </Button>
                </div>
                <div className="template-property-card-grid">
                  <PropertyField label="方向">
                    <PropertySelect
                      ariaLabel={`安全方向 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.direction}
                      onValueChange={(nextValue) =>
                        updateNicSecurityGroupRules(nic.id, (rules) =>
                          rules.map((securityRule) =>
                            securityRule.key === rule.key
                              ? { ...securityRule, direction: nextValue as typeof securityRule.direction }
                              : securityRule,
                          ),
                        )
                      }
                      options={[
                        { label: 'ingress', value: 'ingress' },
                        { label: 'egress', value: 'egress' },
                      ]}
                    />
                  </PropertyField>
                  <PropertyField label="协议">
                    <PropertySelect
                      ariaLabel={`安全协议 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.protocol}
                      onValueChange={(nextValue) =>
                        updateNicSecurityGroupRules(nic.id, (rules) =>
                          rules.map((securityRule) =>
                            securityRule.key === rule.key
                              ? { ...securityRule, protocol: nextValue }
                              : securityRule,
                          ),
                        )
                      }
                      options={[
                        { label: 'tcp', value: 'tcp' },
                        { label: 'udp', value: 'udp' },
                        { label: 'icmp', value: 'icmp' },
                        { label: 'all', value: 'all' },
                      ]}
                    />
                  </PropertyField>
                  <PropertyField label="端口范围">
                    <Input
                      aria-label={`安全端口 ${index + 1}-${ruleIndex + 1}`}
                      placeholder={getPortRangePlaceholder(rule.protocol)}
                      value={rule.portRange}
                      onChange={(event) =>
                        updateNicSecurityGroupRules(nic.id, (rules) =>
                          rules.map((securityRule) =>
                            securityRule.key === rule.key
                              ? { ...securityRule, portRange: event.target.value }
                              : securityRule,
                          ),
                        )
                      }
                    />
                  </PropertyField>
                  <PropertyField label="安全策略">
                    <PropertySelect
                      ariaLabel={`安全策略 ${index + 1}-${ruleIndex + 1}`}
                      value={rule.policy}
                      onValueChange={(nextValue) =>
                        updateNicSecurityGroupRules(nic.id, (rules) =>
                          rules.map((securityRule) =>
                            securityRule.key === rule.key
                              ? { ...securityRule, policy: nextValue as typeof securityRule.policy }
                              : securityRule,
                          ),
                        )
                      }
                      options={[
                        { label: 'accept', value: 'accept' },
                        { label: 'drop', value: 'drop' },
                      ]}
                    />
                  </PropertyField>
                  <PropertyField label="安全优先级">
                    <Input
                      aria-label={`安全优先级 ${index + 1}-${ruleIndex + 1}`}
                      type="number"
                      value={rule.priority}
                      onChange={(event) =>
                        updateNicSecurityGroupRules(nic.id, (rules) =>
                          rules.map((securityRule) =>
                            securityRule.key === rule.key
                              ? { ...securityRule, priority: Number(event.target.value) || 1 }
                              : securityRule,
                          ),
                        )
                      }
                    />
                  </PropertyField>
                  <PropertyField label="源网段">
                    <Input
                      aria-label={`安全源网段 ${index + 1}-${ruleIndex + 1}`}
                      placeholder={SOURCE_CIDR_PLACEHOLDER}
                      value={rule.sourceCidr}
                      onChange={(event) =>
                        updateNicSecurityGroupRules(nic.id, (rules) =>
                          rules.map((securityRule) =>
                            securityRule.key === rule.key
                              ? { ...securityRule, sourceCidr: event.target.value }
                              : securityRule,
                          ),
                        )
                      }
                    />
                  </PropertyField>
                </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </PropertyGroup>

      <PropertyGroup title="DNS 配置" disabled={options?.runtimeExistingNode} description="Windows 启动时设置指定网卡 DNS，初始化脚本结束后再次确认。">
        <PropertyField label="配置方式">
          <PropertySelect
            ariaLabel="DNS 配置方式"
            value={selectedNode.dns ? 'custom' : 'automatic'}
            options={[
              { value: 'automatic', label: '自动获取 DNS' },
              { value: 'custom', label: '自定义 DNS', disabled: dnsUnavailable },
            ]}
            onValueChange={(value) => onUpdateNode(selectedNode.id, {
              ...selectedNode,
              dns: value === 'custom' ? { servers: [], nicIds: nicItems[0] ? [nicItems[0].id] : [] } : undefined,
            })}
          />
        </PropertyField>
        {selectedNode.dns ? <>
          {dnsUnavailable ? <div className="template-property-warning-note" role="alert">当前镜像不是 Windows，无法应用自定义 DNS。请选择 Windows 镜像或自动获取 DNS。</div>
            : !selectedImageOs ? <small className="template-property-field-hint">镜像操作系统尚未确认。保存时会校验 Windows 镜像，自定义 DNS 不会应用到未知系统。</small> : null}
          <PropertyField label="DNS 服务器" hint="每行一个 IPv4 地址，最多 4 个，按优先顺序填写。域成员应使用域控 DNS。">
            <DnsServerField
              key={selectedNode.id}
              servers={selectedNode.dns.servers}
              invalid={dnsErrors.length > 0}
              onChange={(servers) => onUpdateNode(selectedNode.id, {
                ...selectedNode,
                dns: { ...selectedNode.dns!, servers },
              })}
            />
          </PropertyField>
          <fieldset className="grid min-w-0 gap-2 border-0 p-0">
            <legend className="template-property-field-label mb-1">作用网卡</legend>
            {nicItems.map((nic, index) => <label className="flex min-w-0 items-start gap-2 text-xs" key={nic.id}>
              <PropertyCheckbox
                aria-label={`DNS 作用网卡 ${index + 1}`}
                className="mt-0.5 shrink-0"
                checked={selectedNode.dns!.nicIds.includes(nic.id)}
                onCheckedChange={(checked) => onUpdateNode(selectedNode.id, {
                  ...selectedNode,
                  dns: {
                    ...selectedNode.dns!,
                    nicIds: checked === true
                      ? [...selectedNode.dns!.nicIds, nic.id]
                      : selectedNode.dns!.nicIds.filter((id) => id !== nic.id),
                  },
                })}
              />
              <span className="min-w-0 break-words">网卡 {index + 1}{index === 0 ? '（主网卡）' : ''} · {nic.privateIp || '未填写私网 IP'}{switchById.get(nic.switchId)?.label ? ` · ${switchById.get(nic.switchId)!.label}` : ''}</span>
            </label>)}
            <small className="template-property-field-hint">默认作用于主网卡。未选择的网卡保留原 DNS。</small>
          </fieldset>
          <PropertyField label="验证域名（可选）" hint="填写 AD 域名时，额外检查域控 SRV 记录，例如 lab.example。">
            <Input aria-label="DNS 验证域名" placeholder="lab.example" value={selectedNode.dns.domain ?? ''}
              onChange={(event) => onUpdateNode(selectedNode.id, {
                ...selectedNode,
                dns: { ...selectedNode.dns!, domain: event.target.value.trim() || undefined },
              })}
            />
          </PropertyField>
          {dnsErrors.length > 0 ? <div className="template-property-warning-note" role="alert">{dnsErrors.join('；')}</div> : null}
          <small className="template-property-field-hint">实例详情会单独显示 DNS 验证结果。配置失败不会自动重建实例。</small>
        </> : <small className="template-property-field-hint">使用网络自动下发的 DNS，无需修改主机配置。</small>}
      </PropertyGroup>

      <PropertyGroup title="初始化脚本" disabled={options?.runtimeExistingNode}>
        <div className="template-property-field">
          <Textarea
            aria-label="初始化脚本"
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
  runtimeExistingNode = false,
) {
  const aclRules = selectedNode.aclRules ?? [];
  const dnatMappings = selectedNode.nat?.dnatMappings ?? [];
  const hostOptions = allNodes.filter((node): node is EcsTemplateNode => node.kind === 'ecs' && (node.nics?.length ? node.nics.some((nic) => nic.switchId === selectedNode.id) : node.zoneKey === selectedNode.zoneKey));
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
          key: nextAvailableGraphId(`${selectedNode.id}-acl`, aclRules.map((rule) => rule.key)),
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
    onUpdateNode(selectedNode.id, {
      ...selectedNode,
      nat: {
        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
        dnatMappings: [
          ...dnatMappings,
          {
            key: nextAvailableGraphId(`${selectedNode.id}-dnat`, dnatMappings.map((mapping) => mapping.key)),
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
        disabled={runtimeExistingNode}
        action={<span className="template-property-group-badge">交换机</span>}
        actionClassName="template-property-group-action-badge"
        formClassName="template-property-form-grid template-property-form-grid-switch"
        headClassName="template-property-group-head-badge"
      >
        <PropertyField label="名称">
          <Input
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
          <Textarea
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

      <PropertyGroup disabled={runtimeExistingNode} title="网段配置" formClassName="template-property-form">
        <div className="template-switch-cidr-field">
          <div className="template-switch-cidr-shell">
            <Input
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
            <Input
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
            <Input
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
            <Input
              className="template-switch-cidr-octet template-switch-cidr-octet-readonly"
              aria-label="CIDR 第四段"
              value="0"
              readOnly
              tabIndex={-1}
            />
            <span className="template-switch-cidr-slash">/</span>
            <Input
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
          <Button variant="ghost" type="button" className="template-property-inline-button" onClick={handleAddAclRule}>
            添加 ACL 规则
          </Button>
        }
      >
        {aclRules.length === 0 ? <p className="template-property-empty-note">暂无 ACL 规则</p> : null}
        {aclRules.map((rule, index) => (
          <div key={rule.key} className="template-property-card">
            <div className="template-property-card-head">
              <strong className="template-property-card-title">ACL 规则 {index + 1}</strong>
              <Button variant="ghost"
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
              </Button>
            </div>
            <div className="template-property-card-grid template-property-card-grid-compact">
              <PropertyField label="方向">
                <PropertySelect
                  ariaLabel={`ACL 方向 ${index + 1}`}
                  value={rule.direction}
                  onValueChange={(nextValue) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, direction: nextValue as typeof item.direction } : item,
                      ),
                    })
                  }
                  options={[
                    { label: 'inbound', value: 'inbound' },
                    { label: 'outbound', value: 'outbound' },
                  ]}
                />
              </PropertyField>
              <PropertyField label="协议">
                <PropertySelect
                  ariaLabel={`ACL 协议 ${index + 1}`}
                  value={rule.protocol}
                  onValueChange={(nextValue) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, protocol: nextValue } : item,
                      ),
                    })
                  }
                  options={[
                    { label: 'tcp', value: 'tcp' },
                    { label: 'udp', value: 'udp' },
                    { label: 'icmp', value: 'icmp' },
                    { label: 'all', value: 'all' },
                  ]}
                />
              </PropertyField>
              <PropertyField label="端口范围">
                <Input
                  aria-label={`ACL 端口范围 ${index + 1}`}
                  placeholder={getPortRangePlaceholder(rule.protocol)}
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
                <PropertySelect
                  ariaLabel={`ACL 策略 ${index + 1}`}
                  value={rule.policy}
                  onValueChange={(nextValue) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      aclRules: aclRules.map((item) =>
                        item.key === rule.key ? { ...item, policy: nextValue as typeof item.policy } : item,
                      ),
                    })
                  }
                  options={[
                    { label: 'allow', value: 'allow' },
                    { label: 'drop', value: 'drop' },
                  ]}
                />
              </PropertyField>
              <PropertyField label="ACL 优先级">
                <Input
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
                <Input
                  aria-label={`ACL 源网段 ${index + 1}`}
                  placeholder={SOURCE_CIDR_PLACEHOLDER}
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
                <Input
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
          <Button variant="ghost" type="button" className="template-property-inline-button" onClick={handleAddDnatRule}>
            添加 DNAT 规则
          </Button>
        }
      >
        <label className="template-property-check template-property-check-card">
          <PropertyCheckbox aria-label="允许访问互联网（SNAT）"
            checked={selectedNode.nat?.snatEnabled ?? false}
            onCheckedChange={(checked) =>
              onUpdateNode(selectedNode.id, {
                ...selectedNode,
                nat: {
                  snatEnabled: checked === true,
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
              <Button variant="ghost"
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
              </Button>
            </div>
            <div className="template-property-card-grid template-property-card-grid-compact">
              <PropertyField label="目标主机" className="template-property-field-full">
                <PropertySelect
                  ariaLabel={`DNAT 目标主机 ${index + 1}`}
                  value={mapping.targetHostId}
                  emptyOptionLabel="未选择"
                  onValueChange={(nextValue) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nat: {
                        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                        dnatMappings: dnatMappings.map((item) =>
                          item.key === mapping.key ? { ...item, targetHostId: nextValue } : item,
                        ),
                      },
                    })
                  }
                  options={hostOptions.map((host) => ({ label: host.label, value: host.id }))}
                />
              </PropertyField>
              <PropertyField label="公网端口">
                <Input
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
                <Input
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
                <PropertySelect
                  ariaLabel={`DNAT 协议 ${index + 1}`}
                  value={mapping.protocol}
                  onValueChange={(nextValue) =>
                    onUpdateNode(selectedNode.id, {
                      ...selectedNode,
                      nat: {
                        snatEnabled: selectedNode.nat?.snatEnabled ?? false,
                        dnatMappings: dnatMappings.map((item) =>
                          item.key === mapping.key ? { ...item, protocol: nextValue as typeof item.protocol } : item,
                        ),
                      },
                    })
                  }
                  options={[
                    { label: 'tcp', value: 'tcp' },
                    { label: 'udp', value: 'udp' },
                  ]}
                />
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
  runtimeExistingNode = false,
) {
  return (
    <>
      <PropertyGroup
        title="基础信息"
        disabled={runtimeExistingNode}
        action={<span className="template-property-group-badge">路由器</span>}
        actionClassName="template-property-group-action-badge"
        formClassName="template-property-form-grid template-property-form-grid-switch"
        headClassName="template-property-group-head-badge"
      >
        <PropertyField label="名称">
          <Input
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
          <Textarea
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
    runtimeExistingNode?: boolean;
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
      return renderSwitchFields(selectedNode, allNodes, onUpdateNode, options?.runtimeExistingNode);
    case 'router':
      return renderRouterFields(selectedNode, onUpdateNode, options?.runtimeExistingNode);
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
  runtimeExistingNode = false,
  runtimeNodeStatus = null,
  onClose,
}: TemplatePropertyPanelProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (shellRef.current) {
      shellRef.current.scrollTop = 0;
    }
  }, [selectedNode?.id]);

  function updateEditableNode(nodeId: string, nextNode: TemplateNode) {
    if (readOnly || !selectedNode || nodeId !== selectedNode.id) return;
    if (!runtimeExistingNode) { onUpdateNode(nodeId, nextNode); return; }
    let allowedNode: TemplateNode = selectedNode;
    if (selectedNode.kind === 'ecs' && nextNode.kind === 'ecs') {
      allowedNode = { ...selectedNode, nics: selectedNode.nics?.map((nic) => ({ ...nic,
        securityGroupRules: nextNode.nics?.find((item) => item.id === nic.id)?.securityGroupRules ?? nic.securityGroupRules,
        securityGroupRulesMode: nextNode.nics?.find((item) => item.id === nic.id)?.securityGroupRulesMode ?? nic.securityGroupRulesMode,
      })) };
    } else if (selectedNode.kind === 'switch' && nextNode.kind === 'switch') {
      allowedNode = { ...selectedNode, aclRules: nextNode.aclRules, nat: nextNode.nat };
    }
    if (JSON.stringify(allowedNode) !== JSON.stringify(selectedNode)) onUpdateNode(nodeId, allowedNode);
  }

  return (
    <aside className="template-editor-panel template-property-panel">
      <div className="admin-section-header template-property-panel-header">
        <h2>属性面板</h2>
        {onClose ? (
          <Button variant="ghost"
            aria-label="收起节点属性"
            className="template-property-panel-close"
            onClick={onClose}
            title="收起节点属性"
            type="button"
          >
            <PanelRightClose aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <div ref={shellRef} className="template-property-shell">
        {selectedNode ? (
          <PropertyFields className="template-property-readonly-shell" disabled={readOnly}>
            <div className="template-property-stack">
              {renderNodeGroups(
                selectedNode,
                allNodes,
              platformImageAssets,
              instanceTypeAvailability,
              linkedSwitchIdsByHostId,
              updateEditableNode,
              {
                runtimeNodeStatus,
                runtimeExistingNode,
              },
            )}
            </div>
          </PropertyFields>
        ) : (
          <div className="template-property-placeholder">
            <strong>选择节点后配置</strong>
          </div>
        )}
      </div>
    </aside>
  );
}
