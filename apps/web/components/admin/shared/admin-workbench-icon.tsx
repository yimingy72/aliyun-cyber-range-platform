import { Boxes, Cloud, Layers, Users } from 'lucide-react';

export type WorkbenchIconProps = {
  icon: typeof Layers;
  tone: 'green' | 'blue' | 'red' | 'yellow';
};

export const imageSourceIcons = {
  platform: { icon: Layers, tone: 'green' },
  mine: { icon: Users, tone: 'blue' },
  mogong: { icon: Boxes, tone: 'red' },
  cloud: { icon: Cloud, tone: 'yellow' },
} as const satisfies Record<string, WorkbenchIconProps>;

export function AdminWorkbenchIcon({ icon: Icon, tone }: WorkbenchIconProps) {
  return <span aria-hidden="true" className="cel-workbench-icon" data-tone={tone}><Icon size={19} /></span>;
}
