import { Injectable, Logger } from '@nestjs/common';

import { ImageImportsService } from './image-imports.service';

const IMAGE_IMPORT_POLL_INTERVAL_MS = 5_000;

@Injectable()
export class ImageImportsWorkerService {
  private readonly logger = new Logger(ImageImportsWorkerService.name);

  constructor(private readonly imageImportsService: ImageImportsService) {}

  async runLoop(): Promise<void> {
    while (true) {
      try {
        await this.imageImportsService.refreshPendingImports();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`镜像导入任务轮询失败：${message}`);
      }
      await sleep(IMAGE_IMPORT_POLL_INTERVAL_MS);
    }
  }
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
