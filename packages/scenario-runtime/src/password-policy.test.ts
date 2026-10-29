import { describe, expect, it } from 'vitest';

import { describeAliyunEcsPasswordFailure, validateAliyunEcsPassword, validateTencentCvmPassword, describeTencentCvmPasswordFailure } from './password-policy';

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

describe('Tencent CVM creation password policy', () => {
  it('accepts the documented two-class Linux password without relaxing Aliyun', () => {
    expect(validateTencentCvmPassword('abcdefgh1').valid).toBe(true);
    expect(validateAliyunEcsPassword('abcdefgh1').code).toBe('character-classes');
    expect(validateTencentCvmPassword('abcdefgh').code).toBe('character-classes');
    expect(validateTencentCvmPassword('A1!abcde'.padEnd(30, 'x')).valid).toBe(true);
    expect(validateTencentCvmPassword('A1!abcde'.padEnd(31, 'x')).code).toBe('length');
  });

  it('enforces Windows length, complexity and username restrictions', () => {
    expect(validateTencentCvmPassword('Abcd1234', { windows: true }).code).toBe('length');
    expect(validateTencentCvmPassword('abcdefgh1234', { windows: true }).code).toBe('character-classes');
    expect(validateTencentCvmPassword('Abcdefgh1234', { windows: true }).valid).toBe(true);
    expect(validateTencentCvmPassword('aDministraTor123!', { windows: true }).code).toBe('windows-username');
    expect(validateAliyunEcsPassword('Abcd1234', { windows: true }).valid).toBe(true);
  });

  it.each([false, true])('rejects unsupported characters and leading slash (Windows=%s)', windows => {
    for (const value of ['Abcd1234!中abc', 'Abcd1234!"abc', 'Abcd1234!\\abc']) {
      expect(validateTencentCvmPassword(value, { windows }).code).toBe('unsupported-characters');
    }
    expect(validateTencentCvmPassword('Abcd1234 abc!', { windows }).code).toBe('whitespace');
    expect(validateTencentCvmPassword('/Abcd1234abc', { windows }).code).toBe('leading-slash');
  });

  it.each([false, true])('uses the creation API special alphabet independently of Alibaba (Windows=%s)', windows => {
    for (const symbol of ['_', '<', '>']) {
      const value = `Abcdefgh1234${symbol}`;
      expect(validateTencentCvmPassword(value, { windows }).code).toBe('unsupported-characters');
      expect(validateAliyunEcsPassword(value, { windows }).valid).toBe(true);
    }
    for (const symbol of "()~`!@#$%^&*-+=|{}[]:;',.?/") {
      expect(validateTencentCvmPassword(`Abcdefgh1234${symbol}`, { windows }).valid).toBe(true);
    }
  });

  it('provides provider-specific guidance', () => {
    expect(describeTencentCvmPasswordFailure('length', { windows: true })).toContain('12-30');
    expect(describeTencentCvmPasswordFailure('character-classes')).toContain('2 类');
    expect(describeTencentCvmPasswordFailure('leading-slash')).toContain('腾讯云');
    expect(describeTencentCvmPasswordFailure('windows-username')).toContain('Administrator');
    expect(describeTencentCvmPasswordFailure('unsupported-characters')).toContain('不支持下划线、尖括号');
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
