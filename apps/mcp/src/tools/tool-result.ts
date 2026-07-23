export function toToolResult(data: unknown, isError = false) {
  const structuredContent = { result: data };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}
