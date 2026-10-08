import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { OidcAdminBootstrapService } from './oidc-admin-bootstrap.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.init();
  await app.get(OidcAdminBootstrapService).initialize();
  await app.listen(process.env.API_PORT ?? 3001);
}

void bootstrap();
