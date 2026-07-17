export function toToolResult(data: unknown, isError = false) {
  const structuredContent = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}
