import React from 'react';

type RangeInstancePropertyPanelProps = {
  selectedNodeLabel: string;
  editedNodeLabel: string;
  onEditedNodeLabelChange: (value: string) => void;
};

export function RangeInstancePropertyPanel({
  selectedNodeLabel,
  editedNodeLabel,
  onEditedNodeLabelChange,
}: RangeInstancePropertyPanelProps) {
  return (
    <aside className="range-instance-property-panel">
      <div className="template-workbench-list-header-copy">
        <h2>属性面板</h2>
        <p>{selectedNodeLabel}</p>
      </div>

      <label className="template-workbench-search-field">
        <span>名称</span>
        <input
          aria-label="名称"
          value={editedNodeLabel}
          onChange={(event) => onEditedNodeLabelChange(event.target.value)}
        />
      </label>
    </aside>
  );
}
