import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import { BillingLifecycleService, type LifecycleWindow } from './billing-lifecycle.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingWindowDto } from './dto/billing.dto';
@Controller('admin/billing')
@UseGuards(AdminAuthGuard)
export class BillingLifecycleController {
    constructor(private readonly lifecycle: BillingLifecycleService, private readonly reconciliation: BillingReconciliationService) { }
    @Get('entries')
    entries(
    @Query()
    query: BillingWindowDto,
    @Headers('cache-control') cacheControl?: string) {
        if (query.view !== undefined && !['user', 'platform'].includes(query.view))
            throw new BadRequestException('账单视图无效。');
        return this.lifecycle.list(query, cacheControl?.includes('no-cache') === true);
    }
    @Get('entries/:id')
    detail(
    @Param('id')
    id: string,
    @Query()
    query: BillingWindowDto,
    @Headers('cache-control') cacheControl?: string) { return this.lifecycle.detail(id, query, cacheControl?.includes('no-cache') === true); }
    @Post('reconcile')
    schedule(
    @Body()
    body: LifecycleWindow & {
        entryId?: string;
        ledgerIds?: string[];
    }) {
        if (!body || Object.keys(body).some(key => !['startAt', 'endAt', 'entryId', 'ledgerIds'].includes(key)) || body.entryId !== undefined && typeof body.entryId !== 'string'
            || body.ledgerIds !== undefined && (!Array.isArray(body.ledgerIds) || !body.ledgerIds.length || body.ledgerIds.length > 100
                || body.ledgerIds.some(id => typeof id !== 'string' || !id || id.length > 128) || new Set(body.ledgerIds).size !== body.ledgerIds.length))
            throw new BadRequestException('只能提交准确账目和账期。');
        return this.reconciliation.request(body);
    }
    @Get('reconciliation')
    status() { return this.reconciliation.status(); }
    @Get('reconciliation/tasks/:id')
    task(
    @Param('id')
    id: string) { return this.reconciliation.taskDetails(id); }
    @Post('reconciliation/mode')
    mode(
    @Body()
    body: {
        mode: 'legacy' | 'shadow' | 'resource';
        expectedGeneration: number;
    }) {
        if (!body || Object.keys(body).some(key => !['mode', 'expectedGeneration'].includes(key)))
            throw new BadRequestException('账单模式参数无效。');
        return this.reconciliation.mode(body.mode, body.expectedGeneration);
    }
}
