// Read views omit passwords; an omitted field must not silently change a stored host password.
export function preserveOmittedHostPasswords(sourceGraph: Record<string, unknown> | null | undefined, requestedGraph: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(sourceGraph?.nodes) || !Array.isArray(requestedGraph.nodes)) return requestedGraph;
  const stored = new Map(sourceGraph.nodes.filter(node => node && typeof node === 'object' && node.kind === 'ecs').map(node => [node.id, node]));
  let changed = false;
  const nodes = requestedGraph.nodes.map(node => {
    if (!node || typeof node !== 'object' || node.kind !== 'ecs' || node.customPassword !== undefined) return node;
    const password = stored.get(node.id)?.customPassword;
    if (typeof password !== 'string' || !password.length) return node;
    changed = true;
    return { ...node, customPassword: password };
  });
  return changed ? { ...requestedGraph, nodes } : requestedGraph;
}
