import { Injectable, Logger } from '@nestjs/common';
import { PackedImagesService } from './packed-images.service';
import { runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

@Injectable()
export class PackedImagesWorkerService {
  private readonly logger = new Logger(PackedImagesWorkerService.name);
  constructor(private readonly images: PackedImagesService) {}
  async runLoop(): Promise<void> {
    while (true) {
      try { await runInSystemCloudWorkspaceScope(() => this.images.refreshPending()); } catch { this.logger.error('打包镜像轮询失败，状态和清理材料已保留。'); }
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
}
