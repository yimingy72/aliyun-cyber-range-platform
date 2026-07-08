export type AliyunEcsPasswordValidationResult = {
  valid: boolean;
  message: string | null;
};

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 30;

export function validateAliyunEcsPassword(value: string): AliyunEcsPasswordValidationResult {
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      message: 'Password must be 8-30 characters long.',
    };
  }

  if (/\s/.test(value)) {
    return {
      valid: false,
      message: 'Password must not contain spaces.',
    };
  }

  const characterClassCount = [
    /[A-Z]/.test(value),
    /[a-z]/.test(value),
    /[0-9]/.test(value),
    /[^A-Za-z0-9\s]/.test(value),
  ].filter(Boolean).length;

  if (characterClassCount < 3) {
    return {
      valid: false,
      message:
        'Password must include at least three of uppercase, lowercase, number, and special character.',
    };
  }

  return {
    valid: true,
    message: null,
  };
}
