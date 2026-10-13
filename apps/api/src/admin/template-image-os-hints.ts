import type { TemplateImageOsHints } from '@aliyun-cyber-range/scenario-runtime/compiled';

import type { AdminRepository } from './admin.repository';

// The topology compiler stays pure; callers resolve platform-image OS metadata here so
// Windows password rules follow the bound image instead of its display name.
export async function resolveTemplateImageOsHints(
  repository: AdminRepository,
  ...graphs: Array<Record<string, unknown> | null | undefined>
): Promise<TemplateImageOsHints> {
  const assetIds = new Set<string>();

  for (const graph of graphs) {
    const nodes = (graph as { nodes?: unknown } | null | undefined)?.nodes;

    if (!Array.isArray(nodes)) {
      continue;
    }

    for (const node of nodes) {
      const assetId = node && typeof node === 'object' ? (node as { platformImageAssetId?: unknown }).platformImageAssetId : undefined;

      if (typeof assetId === 'string' && assetId.trim()) {
        assetIds.add(assetId);
      }
    }
  }

  const hints: TemplateImageOsHints = {};

  // Narrow repository doubles in tests may not expose the catalog lookups; hints then
  // stay empty and the compiler degrades to its image-name heuristic.
  if (typeof repository.getPlatformImageAssetById !== 'function') {
    return hints;
  }

  for (const assetId of assetIds) {
    const asset = await repository.getPlatformImageAssetById(assetId);
    const snapshot = asset?.sourceSnapshotId && typeof repository.getImageSnapshotById === 'function'
      ? await repository.getImageSnapshotById(asset.sourceSnapshotId)
      : null;
    hints[assetId] = { osType: snapshot?.osType ?? null, platform: snapshot?.platform ?? null };
  }

  return hints;
}
