import type { TemplateImageOsHints } from '@aliyun-cyber-range/scenario-runtime';

type ImageCatalogClient = {
  listPlatformImages?: (view?: 'platform' | 'mine') => Promise<unknown>;
};

// Tools compile authored graphs locally before the platform re-validates them. Resolve
// platform-image OS metadata here so Windows password rules follow the bound image and
// the local precheck cannot refuse a password the server would accept.
export async function resolveToolImageOsHints(
  client: ImageCatalogClient,
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

  if (!assetIds.size) {
    return {};
  }

  // Materialize an entry for every referenced asset up front: an entry means "the tool
  // owns this OS decision"; catalog misses or unreadable views leave it unknown and the
  // platform API performs the authoritative Windows check with its own metadata.
  const hints: TemplateImageOsHints = Object.fromEntries(
    [...assetIds].map((assetId) => [assetId, { osType: null, platform: null }]),
  );

  if (typeof client.listPlatformImages !== 'function') {
    return hints;
  }

  for (const view of ['platform', 'mine'] as const) {
    let assets: unknown;

    try {
      assets = await client.listPlatformImages(view);
    } catch {
      // A single unreadable view (for example a token without catalog scope) must not
      // discard results from the other view.
      continue;
    }

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

  return hints;
}
