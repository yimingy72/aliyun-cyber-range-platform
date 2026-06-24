import type { Team } from '../../../lib/admin-types';

export function TeamsPanel({ teams }: { teams: Team[] }) {
  return (
    <section className="admin-panel">
      <div className="admin-section-header">
        <h2>队伍</h2>
        <span>{teams.length} 支</span>
      </div>

      {teams.length ? (
        <ul className="admin-list">
          {teams.map((team) => (
            <li key={team.id}>
              <div className="admin-list-copy">
                <strong>{team.name}</strong>
                <span>{team.contactName ?? '暂无联系人'}</span>
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
