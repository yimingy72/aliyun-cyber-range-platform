"""Create the disposable realm import used by compose.yml, never a live realm."""
import json
from pathlib import Path

realm = json.loads(Path('infra/keycloak-unified/realm-cyber-range.json').read_text())
realm['groups'] = [
    {'name': 'fixture-alpha', 'id': 'bc0e793f-4d21-4c8c-8d49-16d664b2ec51'},
    {'name': 'fixture-beta', 'id': 'bc0e793f-4d21-4c8c-8d49-16d664b2ec52'},
]
for i, name, roles, groups in [
    (1, 'fixture-member', ['user'], ['/fixture-alpha']),
    (2, 'fixture-unassigned', ['user'], []),
    (3, 'fixture-admin', ['admin'], ['/fixture-alpha']),
    (4, 'fixture-owner', ['user'], ['/fixture-alpha']),
    (5, 'fixture-super', ['admin'], []),
]:
    realm['users'].append({
        'id': f'bc0e793f-4d21-4c8c-8d49-16d664b2ec6{i}', 'username': name, 'enabled': True,
        'emailVerified': True, 'firstName': 'Fixture', 'lastName': name, 'email': f'{name}@example.test',
        'credentials': [{'type': 'password', 'value': 'fixture-only-2026-strong', 'temporary': False}],
        'clientRoles': {'cyber-range': roles}, 'groups': groups,
    })
path = Path('.tmp/unified-auth/realm-cyber-range.json')
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(realm))
