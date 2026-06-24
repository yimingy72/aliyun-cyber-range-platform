 'use client';

import { useMemo, useState } from 'react';

import type { Competition, Team, TeamInput } from '../../../lib/admin-types';

type TeamsPanelProps = {
  teams: Team[];
  competitions: Competition[];
  onCreate: (payload: TeamInput) => Promise<Team>;
  onUpdate: (id: string, payload: TeamInput) => Promise<Team>;
  onDelete: (id: string) => Promise<void>;
};

function normalizeOptionalText(value: string) {
  const normalized = value.trim();

  return normalized ? normalized : undefined;
}

export function TeamsPanel({ teams, competitions, onCreate, onUpdate, onDelete }: TeamsPanelProps) {
  const defaultCompetitionId = competitions[0]?.id ?? '';
  const emptyForm = useMemo<TeamInput>(
    () => ({
      competitionId: defaultCompetitionId,
      name: '',
      contactName: '',
      contactEmailOrPhone: '',
    }),
    [defaultCompetitionId],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TeamInput>(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function resetForm() {
    setEditingId(null);
    setForm({
      competitionId: competitions[0]?.id ?? '',
      name: '',
      contactName: '',
      contactEmailOrPhone: '',
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const payload: TeamInput = {
      competitionId: form.competitionId,
      name: form.name.trim(),
      contactName: normalizeOptionalText(form.contactName ?? ''),
      contactEmailOrPhone: normalizeOptionalText(form.contactEmailOrPhone ?? ''),
    };

    if (!payload.competitionId || !payload.name) {
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

  function beginEdit(team: Team) {
    setEditingId(team.id);
    setForm({
      competitionId: team.competitionId,
      name: team.name,
      contactName: team.contactName ?? '',
      contactEmailOrPhone: team.contactEmailOrPhone ?? '',
    });
  }

  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>队伍</h2>
        <span>{teams.length} 支</span>
      </div>

      <form className="admin-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>所属比赛</span>
          <select
            aria-label="所属比赛"
            value={form.competitionId}
            onChange={(event) => setForm((previous) => ({ ...previous, competitionId: event.target.value }))}
            disabled={!competitions.length}
          >
            {competitions.length ? (
              competitions.map((competition) => (
                <option key={competition.id} value={competition.id}>
                  {competition.name}
                </option>
              ))
            ) : (
              <option value="">暂无可选比赛</option>
            )}
          </select>
        </label>

        <label>
          <span>队伍名称</span>
          <input
            aria-label="队伍名称"
            value={form.name}
            onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
            placeholder="例如：蓝队"
          />
        </label>

        <label>
          <span>联系人</span>
          <input
            aria-label="联系人"
            value={form.contactName ?? ''}
            onChange={(event) => setForm((previous) => ({ ...previous, contactName: event.target.value }))}
            placeholder="例如：王教练"
          />
        </label>

        <label>
          <span>联系方式</span>
          <input
            aria-label="联系方式"
            value={form.contactEmailOrPhone ?? ''}
            onChange={(event) =>
              setForm((previous) => ({ ...previous, contactEmailOrPhone: event.target.value }))
            }
            placeholder="邮箱或手机号"
          />
        </label>

        <div className="admin-inline-actions">
          <button type="submit" disabled={isSubmitting || !competitions.length}>
            {editingId ? '保存队伍' : '创建队伍'}
          </button>
          {editingId ? (
            <button type="button" disabled={isSubmitting} onClick={resetForm}>
              取消编辑
            </button>
          ) : null}
        </div>
      </form>

      {teams.length ? (
        <ul className="admin-list">
          {teams.map((team) => (
            <li key={team.id}>
              <div className="admin-list-copy">
                <strong>{team.name}</strong>
                <span>{competitions.find((competition) => competition.id === team.competitionId)?.name ?? team.competitionId}</span>
                <span>{team.contactName ?? '暂无联系人'}</span>
                {team.contactEmailOrPhone ? <span>{team.contactEmailOrPhone}</span> : null}
              </div>
              <div className="admin-list-actions">
                <button
                  type="button"
                  aria-label={`编辑队伍 ${team.name}`}
                  disabled={isSubmitting}
                  onClick={() => beginEdit(team)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`删除队伍 ${team.name}`}
                  disabled={isSubmitting}
                  onClick={() => void onDelete(team.id)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">暂无队伍配置。</p>
      )}
    </section>
  );
}
