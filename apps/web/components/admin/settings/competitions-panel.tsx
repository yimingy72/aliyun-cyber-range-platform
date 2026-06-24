import type { Competition } from '../../../lib/admin-types';

export function CompetitionsPanel({ competitions }: { competitions: Competition[] }) {
  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>比赛</h2>
        <span>{competitions.length} 项</span>
      </div>

      {competitions.length ? (
        <ul className="admin-list">
          {competitions.map((competition) => (
            <li key={competition.id}>
              <div className="admin-list-copy">
                <strong>{competition.name}</strong>
                <span>{competition.status ?? '未设置状态'}</span>
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
