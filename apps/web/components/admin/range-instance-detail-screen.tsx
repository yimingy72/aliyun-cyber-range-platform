'use client';

import React from 'react';

type RangeInstanceDetailScreenProps = {
  rangeId: string;
};

export function RangeInstanceDetailScreen({ rangeId }: RangeInstanceDetailScreenProps) {
  return (
    <main className="admin-screen range-instance-detail-screen">
      <section className="template-workbench-shell">
        <div className="template-workbench-list">
          <div className="template-workbench-list-header">
            <div className="template-workbench-list-header-copy">
              <h2>实例详情</h2>
              <p>{rangeId}</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
