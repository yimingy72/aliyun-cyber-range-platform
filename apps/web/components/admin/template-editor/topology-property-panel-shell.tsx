'use client';

import type { ReactNode, Ref } from 'react';
import { PanelRightClose } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function TopologyPropertyPanelShell({
  children,
  onClose,
  closeLabel,
  contentRef,
  kind,
}: {
  children: ReactNode;
  onClose?: () => void;
  closeLabel: string;
  contentRef?: Ref<HTMLDivElement>;
  kind: 'node' | 'region';
}) {
  return (
    <aside aria-label="属性面板" className="template-editor-panel template-property-panel" data-property-kind={kind}>
      <div className="admin-section-header template-property-panel-header">
        <h2>属性面板</h2>
        {onClose && (
          <Button aria-label={closeLabel} className="template-property-panel-close" title={closeLabel}
            onClick={onClose} type="button" variant="ghost">
            <PanelRightClose aria-hidden="true" />
          </Button>
        )}
      </div>
      <div ref={contentRef} className="template-property-shell">{children}</div>
    </aside>
  );
}
