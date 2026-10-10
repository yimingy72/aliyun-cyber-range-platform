import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export function configureApp(app: INestApplication) {
  // Compiled topologies carry the graph, scripts and provision specs together.
  (app as NestExpressApplication).useBodyParser('json', { limit: 8 * 1024 * 1024 });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: true,
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-cloud-workspace-id', 'x-request-id', 'x-idempotency-key', 'idempotency-key', 'x-confirmation-id', 'x-operation-confirmation-id'],
  });
}
