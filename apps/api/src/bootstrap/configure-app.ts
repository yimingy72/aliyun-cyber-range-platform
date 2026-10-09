import { INestApplication, ValidationPipe } from '@nestjs/common';

export function configureApp(app: INestApplication) {
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
