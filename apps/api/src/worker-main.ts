import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProvisioningWorkerService } from './provisioning/provisioning-worker.service';
import { ImageImportsWorkerService } from './admin/image-imports-worker.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(ProvisioningWorkerService);
  const imageImportsWorker = app.get(ImageImportsWorkerService);

  await Promise.all([worker.runLoop(), imageImportsWorker.runLoop()]);
}

void bootstrap();
