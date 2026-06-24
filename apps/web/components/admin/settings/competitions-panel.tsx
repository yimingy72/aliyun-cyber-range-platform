 'use client';

import { useState } from 'react';

import type { Competition, CompetitionInput, CompetitionStatus } from '../../../lib/admin-types';

type CompetitionsPanelProps = {
  competitions: Competition[];
  onCreate: (payload: CompetitionInput) => Promise<Competition>;
  onUpdate: (id: string, payload: CompetitionInput) => Promise<Competition>;
  onDelete: (id: string) => Promise<void>;
};

const EMPTY_FORM: CompetitionInput = {
  name: '',
  description: '',
  status: 'scheduled',
};

function normalizeOptionalText(value: string) {
  const normalized = value.trim();

  return normalized ? normalized : undefined;
}

export function CompetitionsPanel({ competitions, onCreate, onUpdate, onDelete }: CompetitionsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CompetitionInput>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload: CompetitionInput = {
      name: form.name.trim(),
      description: normalizeOptionalText(form.description ?? ''),
      status: (form.status ?? 'scheduled') as CompetitionStatus,
    };

    if (!payload.name) {
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

  function beginEdit(competition: Competition) {
    setEditingId(competition.id);
    setForm({
      name: competition.name,
      description: competition.description ?? '',
      status: (competition.status as CompetitionStatus | undefined) ?? 'scheduled',
    });
  }

  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>比赛</h2>
        <span>{competitions.length} 项</span>
      </div>

      <form className="admin-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>比赛名称</span>
          <input
            aria-label="比赛名称"
            value={form.name}
            onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
            placeholder="例如：2026 总决赛"
          />
        </label>

        <label>
          <span>比赛描述</span>
          <textarea
            aria-label="比赛描述"
            value={form.description ?? ''}
            onChange={(event) => setForm((previous) => ({ ...previous, description: event.target.value }))}
            placeholder="简要说明比赛目标、时间窗口或适用模板"
          />
        </label>

        <label>
          <span>比赛状态</span>
          <select
            aria-label="比赛状态"
            value={form.status ?? 'scheduled'}
            onChange={(event) =>
              setForm((previous) => ({ ...previous, status: event.target.value as CompetitionStatus }))
            }
          >
            <option value="draft">草稿</option>
            <option value="scheduled">已排期</option>
            <option value="active">进行中</option>
            <option value="completed">已结束</option>
          </select>
        </label>

        <div className="admin-inline-actions">
          <button type="submit" disabled={isSubmitting}>
            {editingId ? '保存比赛' : '创建比赛'}
          </button>
          {editingId ? (
            <button type="button" disabled={isSubmitting} onClick={resetForm}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>

      {competitions.length ? (
        <ul className="admin-list">
          {competitions.map((competition) => (
            <li key={competition.id}>
              <div className="admin-list-copy">
                <strong>{competition.name}</strong>
                <span>{competition.status ?? '未设置状态'}</span>
                {competition.description ? <span>{competition.description}</span> : null}
              </div>
              <div className="admin-list-actions">
                <button
                  type="button"
                  aria-label={`编辑比赛 ${competition.name}`}
                  disabled={isSubmitting}
                  onClick={() => beginEdit(competition)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`删除比赛 ${competition.name}`}
                  disabled={isSubmitting}
                  onClick={() => void onDelete(competition.id)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">暂无比赛配置。</p>
      )}
    </section>
  );
}
