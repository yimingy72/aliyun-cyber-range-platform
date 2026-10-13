export type AliyunEcsPasswordValidationCode =
  | 'length'
  | 'whitespace'
  | 'unsupported-characters'
  | 'character-classes'
  | 'windows-leading-slash';

export type AliyunEcsPasswordValidationResult = {
  valid: boolean;
  code: AliyunEcsPasswordValidationCode | null;
  message: string | null;
};

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 30;
// Aliyun ECS only accepts this documented special-character set; quotes, backslashes,
// spaces and non-ASCII characters are rejected by the cloud API even when they look special.
const ALLOWED_PASSWORD_PATTERN = /^[A-Za-z0-9()~`!@#$%^&*\-_+=|{}[\]:;'<>,.?/]+$/;

export function validateAliyunEcsPassword(
  value: string,
  options: { windows?: boolean } = {},
): AliyunEcsPasswordValidationResult {
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      code: 'length',
      message: 'Password must be 8-30 characters long.',
    };
  }

  if (/\s/.test(value)) {
    return {
      valid: false,
      code: 'whitespace',
      message: 'Password must not contain spaces.',
    };
  }

  if (!ALLOWED_PASSWORD_PATTERN.test(value)) {
    return {
      valid: false,
      code: 'unsupported-characters',
      message: 'Password contains characters outside the Aliyun ECS allowed set.',
    };
  }

  const characterClassCount = [
    /[A-Z]/.test(value),
    /[a-z]/.test(value),
    /[0-9]/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;

  if (characterClassCount < 3) {
    return {
      valid: false,
      code: 'character-classes',
      message:
        'Password must include at least three of uppercase, lowercase, number, and special character.',
    };
  }

  if (options.windows && value.startsWith('/')) {
    return {
      valid: false,
      code: 'windows-leading-slash',
      message: 'Windows instance passwords must not start with a forward slash.',
    };
  }

  return {
    valid: true,
    code: null,
    message: null,
  };
}

export function describeAliyunEcsPasswordFailure(code: AliyunEcsPasswordValidationCode): string {
  switch (code) {
    case 'length':
      return '长度需为 8-30 个字符';
    case 'whitespace':
      return '不能包含空格';
    case 'unsupported-characters':
      return '仅支持字母、数字与特殊字符 ( ) ~ ` ! @ # $ % ^ & * - _ + = | { } [ ] : ; \' < > , . ? /，不能包含中文、双引号或反斜杠等其他字符';
    case 'character-classes':
      return '至少包含大写字母、小写字母、数字、特殊字符中的 3 类';
    case 'windows-leading-slash':
      return 'Windows 实例密码不能以“/”开头';
  }
}
