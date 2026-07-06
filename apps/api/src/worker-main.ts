import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProvisioningWorkerService } from './provisioning/provisioning-worker.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const worker = app.get(ProvisioningWorkerService);

  await worker.runLoop();
}

void bootstrap();
