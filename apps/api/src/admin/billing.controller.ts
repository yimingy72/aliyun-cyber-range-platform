import { BadGatewayException, Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { AdminAuthGuard } from './admin-auth.guard';
import { BillingService } from './billing.service';
import { BillingSyncService } from './billing-sync.service';
import { resolveBillingWindow } from './billing-window';
import { BillingWindowDto } from './dto/billing.dto';

@Controller('admin/billing')
@UseGuards(AdminAuthGuard)
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly billingSyncService: BillingSyncService,
  ) {}

  @Get('summary')
  getSummary(@Query() query: BillingWindowDto) {
    return this.billingService.getSummary(query);
  }

  @Get('users')
  listUsers(@Query() query: BillingWindowDto) {
    return this.billingService.listUsers(query);
  }

  @Get('user-groups')
  listUserGroups(@Query() query: BillingWindowDto) {
    return this.billingService.listUserGroups(query);
  }

  @Get('users/:userId')
  getUserSummary(@Param('userId') userId: string, @Query() query: BillingWindowDto) {
    return this.billingService.getUserSummary(userId, query);
  }

  @Get('users/:userId/items')
  listUserItems(@Param('userId') userId: string, @Query() query: BillingWindowDto) {
    return this.billingService.listUserItems(userId, query);
  }

  @Get('platform/items')
  listPlatformItems(@Query() query: BillingWindowDto) {
    return this.billingService.listPlatformItems(query);
  }

  @Get('platform/groups')
  listPlatformGroups(@Query() query: BillingWindowDto) {
    return this.billingService.listPlatformGroups(query);
  }

  @Get('anomalies')
  listAnomalies(@Query() query: BillingWindowDto) {
    return this.billingService.listAnomalies(query);
  }

  @Post('sync')
  async sync(@Body() body: BillingWindowDto) {
    const window = resolveBillingWindow(body, 7);
    try {
      if (!body.startAt && !body.endAt) return await this.billingSyncService.syncRecentDays(7);
      return await this.billingSyncService.syncRange({ startAt: window.startAtText, endAt: window.endAtText });
    } catch (error) {
      if (error instanceof Error && error.message.includes('exceeds ledger precision')) {
        throw new BadGatewayException({
          code: 'BILLING_AMOUNT_PRECISION',
          message: '云厂商账单金额超出平台可无损保存的精度，失败账期的原有数据已保留，请联系管理员检查。',
        });
      }
      throw error;
    }
  }

  @Get('export/platform.csv')
  async exportPlatformCsv(@Query() query: BillingWindowDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="platform-billing.csv"');
    return this.billingService.exportPlatformCsv(query);
  }

  @Get('export/users.csv')
  async exportUsersCsv(@Query() query: BillingWindowDto, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="billing-users.csv"');
    return this.billingService.exportUsersCsv(query);
  }

  @Get('export/users/:userId.csv')
  async exportUserItemsCsv(
    @Param('userId') userId: string,
    @Query() query: BillingWindowDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="billing-user-items.csv"');
    return this.billingService.exportUserItemsCsv(userId, query);
  }
}
