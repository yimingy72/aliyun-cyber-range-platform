 'use client';

import { useState } from 'react';

import { DEFAULT_TEMPLATE_MODULE_PATH } from '../../../lib/admin-template-defaults';
import type { RangeTemplate, RangeTemplateUpdateInput } from '../../../lib/admin-types';

type TemplateDraft = {
  name: string;
  slug: string;
  version: string;
  modulePathOrRef: string;
};

type TemplatesPanelProps = {
  templates: RangeTemplate[];
  onCreate: (payload: TemplateDraft) => Promise<RangeTemplate>;
  onUpdate: (id: string, payload: RangeTemplateUpdateInput) => Promise<RangeTemplate>;
  onPublish: (id: string) => Promise<RangeTemplate>;
  onOpenEditor: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
};

const EMPTY_FORM: TemplateDraft = {
  name: '',
  slug: '',
  version: 'v1',
  modulePathOrRef: DEFAULT_TEMPLATE_MODULE_PATH,
};

export function TemplatesPanel({ templates, onCreate, onUpdate, onPublish, onOpenEditor, onDelete }: TemplatesPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateDraft>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      version: form.version.trim(),
      modulePathOrRef: form.modulePathOrRef.trim() || DEFAULT_TEMPLATE_MODULE_PATH,
    };

    if (!payload.name || !payload.slug || !payload.version) {
      return;
    }

    setIsSubmitting(true);

    try {
      if (editingId) {
        await onUpdate(editingId, payload);
      } else {
        await onCreate(payload);
      }

      resetForm();
    } finally {
      setIsSubmitting(false);
    }
  }

  function beginEdit(template: RangeTemplate) {
    setEditingId(template.id);
    setForm({
      name: template.name?.trim() || template.slug,
      slug: template.slug,
      version: template.version,
      modulePathOrRef: template.modulePathOrRef?.trim() || DEFAULT_TEMPLATE_MODULE_PATH,
    });
  }

  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>模板</h2>
        <span>{templates.length} 个</span>
      </div>

      <form className="admin-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>模板名称</span>
          <input
            aria-label="模板名称"
            value={form.name}
            onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
            placeholder="例如：企业攻防靶场"
          />
        </label>

        <label>
          <span>模板标识</span>
          <input
            aria-label="模板标识"
            value={form.slug}
            onChange={(event) => setForm((previous) => ({ ...previous, slug: event.target.value }))}
            placeholder="例如：enterprise-range"
          />
        </label>

        <label>
          <span>模板版本</span>
          <input
            aria-label="模板版本"
            value={form.version}
            onChange={(event) => setForm((previous) => ({ ...previous, version: event.target.value }))}
            placeholder="例如：v1"
          />
        </label>

        <label>
          <span>模块路径</span>
          <input
            aria-label="模块路径"
            value={form.modulePathOrRef}
            onChange={(event) => setForm((previous) => ({ ...previous, modulePathOrRef: event.target.value }))}
          />
        </label>

        <p className="admin-empty">创建模板时会自动附带默认的三分区企业靶场拓扑骨架。</p>

        <div className="admin-inline-actions">
          <button type="submit" disabled={isSubmitting}>
            {editingId ? '保存模板' : '创建模板'}
          </button>
          {editingId ? (
            <button type="button" disabled={isSubmitting} onClick={resetForm}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>

      {templates.length ? (
        <ul className="admin-list">
          {templates.map((template) => (
            <li key={template.id}>
              <div className="admin-list-copy">
                <strong>{template.name?.trim() || template.slug}</strong>
                <span>{template.version}</span>
                <span>{template.modulePathOrRef?.trim() || DEFAULT_TEMPLATE_MODULE_PATH}</span>
                <span>{template.currentPublishedVersion ? `已发布 ${template.currentPublishedVersion.version}` : '未发布'}</span>
                {template.currentDraftVersion ? <span>{`草稿 ${template.currentDraftVersion.version}`}</span> : null}
              </div>
              <div className="admin-list-actions">
                <button
                  type="button"
                  aria-label={`进入模板编辑器 ${template.slug}`}
                  disabled={isSubmitting}
                  onClick={() => onOpenEditor(template.id)}
                >
                  编辑器
                </button>
                <button
                  type="button"
                  aria-label={`发布模板 ${template.slug}`}
                  disabled={isSubmitting || !template.currentDraftVersionId}
                  onClick={() => void onPublish(template.id)}
                >
                  发布
                </button>
                <button
                  type="button"
                  aria-label={`编辑模板 ${template.slug}`}
                  disabled={isSubmitting}
                  onClick={() => beginEdit(template)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`删除模板 ${template.slug}`}
                  disabled={isSubmitting}
                  onClick={() => void onDelete(template.id)}
                >
                  删除
                </button>
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
