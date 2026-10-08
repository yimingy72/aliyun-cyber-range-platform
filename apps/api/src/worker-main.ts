import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProvisioningWorkerService } from './provisioning/provisioning-worker.service';
import { ImageImportsWorkerService } from './admin/image-imports-worker.service';
import { PackedImagesWorkerService } from './admin/packed-images-worker.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(ProvisioningWorkerService);
  const imageImportsWorker = app.get(ImageImportsWorkerService);
  const packedImagesWorker = app.get(PackedImagesWorkerService);

  await Promise.all([worker.runLoop(), imageImportsWorker.runLoop(), packedImagesWorker.runLoop()]);
}

void bootstrap();
