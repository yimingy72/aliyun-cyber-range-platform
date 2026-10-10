export function toToolResult(data: unknown, isError = false) {
  const structuredContent = { result: data };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

const secretKeys = new Set(['password', 'custompassword', 'defaultpassword', 'accesskeyid', 'accesskeysecret', 'encryptedaccesskeyid', 'encryptedaccesskeysecret', 'runtimecredentials', 'credentials', 'authorization', 'token', 'ssh', 'vncurl']);

export function sanitizeToolError(error: unknown, input: unknown) {
  const secrets: string[] = [];
  function collect(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (secretKeys.has(key.toLowerCase()) && typeof child === 'string' && child.length) secrets.push(child);
      else collect(child);
    }
  }
  collect(input);
  function redact(value: unknown): unknown {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.toLowerCase())).map(([key, child]) => [key, redact(child)]));
  }
  return redact(error);
}
