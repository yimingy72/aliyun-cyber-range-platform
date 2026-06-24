import type { RangeTemplate } from '../../../lib/admin-types';

export function TemplatesPanel({ templates }: { templates: RangeTemplate[] }) {
  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>模板</h2>
        <span>{templates.length} 个</span>
      </div>

      {templates.length ? (
        <ul className="admin-list">
          {templates.map((template) => (
            <li key={template.id}>
              <div className="admin-list-copy">
                <strong>{template.name?.trim() || template.slug}</strong>
                <span>{template.version}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">暂无模板配置。</p>
      )}
    </section>
  );
}
