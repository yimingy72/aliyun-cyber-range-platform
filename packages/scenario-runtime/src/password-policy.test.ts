import { describe, expect, it } from 'vitest';

import { validateAliyunEcsPassword } from './password-policy';

describe('validateAliyunEcsPassword', () => {
  it('accepts passwords with at least three character classes and valid length', () => {
    expect(validateAliyunEcsPassword('Abcd1234')).toEqual({
      valid: true,
      message: null,
    });
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(validateAliyunEcsPassword('Ab1!xyz')).toEqual({
      valid: false,
      message: 'Password must be 8-30 characters long.',
    });
  });

  it('rejects passwords longer than 30 characters', () => {
    expect(validateAliyunEcsPassword('Abcd1234!'.repeat(4))).toEqual({
      valid: false,
      message: 'Password must be 8-30 characters long.',
    });
  });

  it('rejects passwords containing spaces', () => {
    expect(validateAliyunEcsPassword('Abcd 1234!')).toEqual({
      valid: false,
      message: 'Password must not contain spaces.',
    });
  });

  it('rejects passwords with fewer than three character classes', () => {
    expect(validateAliyunEcsPassword('abcdefgh')).toEqual({
      valid: false,
      message: 'Password must include at least three of uppercase, lowercase, number, and special character.',
    });
  });
});
