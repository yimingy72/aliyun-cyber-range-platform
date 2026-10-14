export function sanitizeAliyunErrorCode(value: unknown, sensitiveValues: readonly string[]) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value)
    && !sensitiveValues.some(secret => secret && value.includes(secret)) ? value : null;
}

export function isAliyunRequestTimeout(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error
    && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}
