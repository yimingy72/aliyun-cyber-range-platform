import type { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import type { TemplateImageOsHints } from '@aliyun-cyber-range/scenario-runtime';

// Tools compile authored graphs locally before the platform re-validates them. Resolve
// platform-image OS metadata here so Windows password rules follow the bound image and
// the local precheck cannot refuse a password the server would accept.
export async function resolveToolImageOsHints(
  client: PlatformApiClient,
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

  if (!assetIds.size || typeof client.listPlatformImages !== 'function') {
    return {};
  }

  const hints: TemplateImageOsHints = {};

  try {
    for (const view of ['platform', 'mine'] as const) {
      const assets = await client.listPlatformImages(view);

      if (!Array.isArray(assets)) {
        continue;
      }

      for (const asset of assets) {
        if (!asset || typeof asset !== 'object' || !assetIds.has(asset.id)) {
          continue;
        }

        const osType = (asset as { osType?: unknown }).osType;
        const platform = (asset as { platform?: unknown }).platform;
        hints[asset.id] = {
          osType: typeof osType === 'string' ? osType : null,
          platform: typeof platform === 'string' ? platform : null,
        };
      }
    }
  } catch {
    // Best-effort lookup: degrade to the compiler's image-name heuristic.
    return {};
  }

  return hints;
}
