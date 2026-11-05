import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BillingReconciliationService } from './admin/billing-reconciliation.service';
async function bootstrap() {
    process.env.BILLING_SYNC_INTERVAL_MS = '0';
    const app = await NestFactory.createApplicationContext(AppModule);
    await app.get(BillingReconciliationService).runLoop();
}
void bootstrap();
