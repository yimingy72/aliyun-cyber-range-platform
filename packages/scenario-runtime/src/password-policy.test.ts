import { describe, expect, it } from 'vitest';

import { describeAliyunEcsPasswordFailure, validateAliyunEcsPassword } from './password-policy';

describe('validateAliyunEcsPassword', () => {
  it('accepts passwords with at least three character classes and valid length', () => {
    expect(validateAliyunEcsPassword('Abcd1234')).toEqual({
      valid: true,
      code: null,
      message: null,
    });
  });

  it('accepts documented special characters', () => {
    for (const value of ['Abcd1234!', '(Abc1234)', '~Abc1234', 'A1!|bcde', "Abc1!'def", 'Abcd1234/']) {
      expect(validateAliyunEcsPassword(value)).toEqual({ valid: true, code: null, message: null });
    }
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(validateAliyunEcsPassword('Ab1!xyz')).toEqual({
      valid: false,
      code: 'length',
      message: 'Password must be 8-30 characters long.',
    });
  });

  it('rejects passwords longer than 30 characters', () => {
    expect(validateAliyunEcsPassword('Abcd1234!'.repeat(4))).toEqual({
      valid: false,
      code: 'length',
      message: 'Password must be 8-30 characters long.',
    });
  });

  it('rejects passwords containing spaces', () => {
    expect(validateAliyunEcsPassword('Abcd 1234!')).toEqual({
      valid: false,
      code: 'whitespace',
      message: 'Password must not contain spaces.',
    });
  });

  it('rejects characters outside the Aliyun ECS allowed set', () => {
    for (const value of ['Abcd123中!', 'Abcd"1234!', 'Abcd\\1234!', 'Abcd1234！']) {
      expect(validateAliyunEcsPassword(value)).toEqual({
        valid: false,
        code: 'unsupported-characters',
        message: 'Password contains characters outside the Aliyun ECS allowed set.',
      });
    }
  });

  it('rejects passwords with fewer than three character classes', () => {
    expect(validateAliyunEcsPassword('abcdefgh')).toEqual({
      valid: false,
      code: 'character-classes',
      message: 'Password must include at least three of uppercase, lowercase, number, and special character.',
    });
  });

  it('rejects Windows passwords starting with a forward slash', () => {
    expect(validateAliyunEcsPassword('/Abcd1234', { windows: true })).toEqual({
      valid: false,
      code: 'windows-leading-slash',
      message: 'Windows instance passwords must not start with a forward slash.',
    });
    expect(validateAliyunEcsPassword('/Abcd1234')).toEqual({ valid: true, code: null, message: null });
  });
});

describe('describeAliyunEcsPasswordFailure', () => {
  it('returns actionable Chinese guidance for every failure code', () => {
    expect(describeAliyunEcsPasswordFailure('length')).toContain('8-30');
    expect(describeAliyunEcsPasswordFailure('whitespace')).toContain('空格');
    expect(describeAliyunEcsPasswordFailure('unsupported-characters')).toContain('特殊字符');
    expect(describeAliyunEcsPasswordFailure('unsupported-characters')).toContain('不能包含中文');
    expect(describeAliyunEcsPasswordFailure('character-classes')).toContain('3 类');
    expect(describeAliyunEcsPasswordFailure('windows-leading-slash')).toContain('Windows');
  });
});
