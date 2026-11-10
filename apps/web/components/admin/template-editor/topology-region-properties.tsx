'use client';

import {
  MAX_REGION_COORDINATE, MAX_REGION_SIZE, MIN_REGION_SIZE,
  type TopologyRegionAppearance, type TopologyRegionBounds,
} from '@aliyun-cyber-range/scenario-runtime';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AdminSelectField } from '../shared/admin-select-field';
import { TopologyPropertyPanelShell } from './topology-property-panel-shell';
import type { CanvasRegion } from './topology-network-regions';

type RegionPatch = Partial<TopologyRegionAppearance & TopologyRegionBounds>;

const geometryFields = [
  { key: 'x', label: '横向位置', min: -MAX_REGION_COORDINATE, max: MAX_REGION_COORDINATE },
  { key: 'y', label: '纵向位置', min: -MAX_REGION_COORDINATE, max: MAX_REGION_COORDINATE },
  { key: 'width', label: '宽度', min: MIN_REGION_SIZE, max: MAX_REGION_SIZE },
  { key: 'height', label: '高度', min: MIN_REGION_SIZE, max: MAX_REGION_SIZE },
] as const;
const borderOptions = [{ label: '实线', value: 'solid' }, { label: '虚线', value: 'dashed' }, { label: '点线', value: 'dotted' }];
const fillOptions = [{ label: '浅色填充', value: 'tint' }, { label: '透明', value: 'none' }];

export function TopologyRegionProperties({ region, editable, onChange, onRemove, onClose }: {
  region: CanvasRegion;
  editable: boolean;
  onChange: (patch: RegionPatch) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const manual = region.kind === 'manual';
  return (
    <TopologyPropertyPanelShell kind="region" closeLabel="收起区域属性" onClose={onClose}>
      <fieldset className="topology-region-fields" disabled={!editable}>
        <label className="topology-region-field">区域名称
          <Input aria-label="区域名称" key={region.title} defaultValue={region.title} maxLength={80}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            onBlur={event => {
              const title = event.currentTarget.value.trim();
              if (title && title !== region.title) onChange({ title });
              else event.currentTarget.value = region.title;
            }} />
        </label>
        <label className="topology-region-field">区域颜色
          <Input aria-label="区域颜色" type="color" value={region.color}
            onChange={event => onChange({ color: event.currentTarget.value })} />
        </label>
        <div className="topology-region-field">边框样式
          <AdminSelectField ariaLabel="边框样式" disabled={!editable} value={region.borderStyle}
            options={borderOptions} onValueChange={value => onChange({ borderStyle: value as TopologyRegionAppearance['borderStyle'] })} />
        </div>
        <div className="topology-region-field">填充
          <AdminSelectField ariaLabel="区域填充" disabled={!editable} value={region.fill}
            options={fillOptions} onValueChange={value => onChange({ fill: value as TopologyRegionAppearance['fill'] })} />
        </div>
        {manual && <div className="topology-region-geometry">{geometryFields.map(({ key, label, min, max }) => (
          <label className="topology-region-field" key={key}>{label}
            <Input aria-label={label} key={region[key]} type="number" min={min} max={max} step={1} defaultValue={region[key]}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              onBlur={event => {
                const value = event.currentTarget.valueAsNumber;
                if (!Number.isFinite(value) || value < min || value > max) event.currentTarget.value = String(region[key]);
                else if (value !== region[key]) onChange({ [key]: value });
              }} />
          </label>
        ))}</div>}
        <p className="text-xs text-muted-foreground">
          {manual ? '画布标注不改变节点或网络配置。' : '区域范围跟随当前网段；这里只调整显示样式。'}
        </p>
        {editable && (manual || region.styled) && (
          <Button size="sm" variant={manual ? 'destructive' : 'outline'} type="button" onClick={onRemove}>
            {manual ? '删除区域' : '恢复默认样式'}
          </Button>
        )}
      </fieldset>
    </TopologyPropertyPanelShell>
  );
}
