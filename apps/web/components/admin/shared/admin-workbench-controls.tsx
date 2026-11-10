import type { ReactNode } from 'react';

export function AdminWorkbenchControls({ title, views, actions, filters }: {
  title?: string;
  views?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
}) {
  return (
    <div className="cel-workbench-controls">
      {(title || views) && <div className="cel-workbench-heading">
        {title && <h2 className="cel-workbench-list-title">{title}</h2>}
        {views}
      </div>}
      {(filters || actions) && <div className="cel-workbench-tools">
        {filters}
        {actions}
      </div>}
    </div>
  );
}
