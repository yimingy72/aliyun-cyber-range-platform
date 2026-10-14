import { beforeEach, describe, expect, it } from 'vitest';
import { beginRangeRecoveryIntent, clearRangeRecoveryIntent, readRangeRecoveryIntent } from './range-recovery-intent';

const scope = { apiBaseUrl: 'https://fixture.invalid', userId: 'owner', workspaceId: 'space', rangeId: 'range' };
describe('range recovery intent', () => {
  beforeEach(() => window.sessionStorage.clear());
  it('keeps the original trigger and key when the requested action changes', () => {
    const original = beginRangeRecoveryIntent(scope, 'retry');
    expect(beginRangeRecoveryIntent(scope, 'destroy')).toEqual(original);
    expect(readRangeRecoveryIntent(scope)).toEqual(original);
  });
  it.each(['apiBaseUrl', 'userId', 'workspaceId', 'rangeId'] as const)('isolates %s and preserves other pending intents', field => {
    const original = beginRangeRecoveryIntent(scope, 'retry');
    const otherScope = { ...scope, [field]: `${scope[field]}-other` };
    expect(readRangeRecoveryIntent(otherScope)).toBeNull();
    const other = beginRangeRecoveryIntent(otherScope, 'destroy');
    clearRangeRecoveryIntent(scope, 'wrong-key');
    expect(readRangeRecoveryIntent(scope)).toEqual(original);
    clearRangeRecoveryIntent(scope, original.key);
    expect(readRangeRecoveryIntent(otherScope)).toEqual(other);
  });
});
