import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ServiceUnavailableException } from '@nestjs/common';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

export type MogongImage = {
  id: number; name: string; type: string; imageId: string | null; active: boolean; status: string;
  creator: string | null; containerReference: string | null;
};

export function isBoundMogongWorkspace() {
  const scope = getCurrentCloudWorkspaceScope();
  const boundId = process.env.MOGONG_CATALOG_WORKSPACE_ID?.trim();
  return Boolean(boundId && scope && !('system' in scope) && scope.provider === 'alibaba_cloud' && scope.cloudWorkspaceId === boundId);
}

function safeContainerReference(value: string | null | undefined) {
  const ref = value?.trim() || null;
  if (!ref || ref.length > 512 || /[\x00-\x1f\x7f?#]/.test(ref) || /^(?:https?|oss):\/\//i.test(ref) ||
      (ref.includes('@') && !/^[^@]+@sha256:[a-f0-9]{64}$/i.test(ref))) return null;
  return ref;
}

export function containerReferenceStatus(ref: string | null): 'recorded' | 'needs_review' {
  return ref && ref.includes('/') && /^[a-z0-9][a-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/i.test(ref) ? 'recorded' : 'needs_review';
}

export function isCollectableMogongImage(image: Pick<MogongImage, 'name' | 'type' | 'imageId' | 'active' | 'status'>) {
  return image.active && image.status === 'successful' && image.type === 'vm' && Boolean(image.imageId)
    && !/废弃|弃用|已淘汰|已废止/i.test(image.name);
}

export function isCollectableMogongContainer(image: Pick<MogongImage, 'name' | 'type' | 'active' | 'status'>) {
  return image.active && image.status === 'successful' && image.type === 'docker' && !/废弃|弃用|已淘汰|已废止/i.test(image.name);
}

export async function readMogongImageCatalog(): Promise<{ capturedAt: string; version: number; items: MogongImage[] }> {
  try {
    const path = process.env.MOGONG_IMAGE_CATALOG_PATH?.trim() || '/var/lib/cyber-range/mogong/image-catalog.json';
    const catalog = JSON.parse(await readFile(path, 'utf8')) as { capturedAt: unknown; total: unknown; version?: unknown; items: unknown };
    if (typeof catalog.capturedAt !== 'string' || !Number.isFinite(Date.parse(catalog.capturedAt)) ||
        !Array.isArray(catalog.items) || catalog.items.length > 10000 || catalog.total !== catalog.items.length ||
        !(catalog.version === undefined || catalog.version === 2)) throw new Error('Invalid catalog');
    const items = catalog.items.map((item: Partial<MogongImage>) => {
      if (!item || !Number.isSafeInteger(item.id) || item.id! <= 0 || typeof item.name !== 'string' || !item.name.trim() ||
          typeof item.type !== 'string' || typeof item.status !== 'string' || typeof item.active !== 'boolean' ||
          !(item.creator === undefined || item.creator === null || typeof item.creator === 'string') ||
          (catalog.version === 2 && item.containerReference === undefined) ||
          !(item.containerReference === undefined || item.containerReference === null || typeof item.containerReference === 'string') ||
          !(item.imageId === null || typeof item.imageId === 'string' && /^m-[a-z0-9]+$/i.test(item.imageId))) throw new Error('Invalid image');
      return { id: item.id!, name: item.name, type: item.type, imageId: item.imageId, active: item.active, status: item.status,
        creator: item.creator?.trim() || null, containerReference: item.type === 'docker' ? safeContainerReference(item.containerReference) : null };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Duplicate image');
    return { capturedAt: catalog.capturedAt, version: catalog.version === 2 ? 2 : 1, items };
  } catch {
    throw new ServiceUnavailableException('墨攻镜像目录快照不可用，请联系管理员更新快照。');
  }
}

export function mogongContainerDigest(items: MogongImage[]) {
  const canonical = items.filter(isCollectableMogongContainer).sort((a, b) => a.id - b.id)
    .map(item => [item.id, item.name, item.creator, item.containerReference]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
