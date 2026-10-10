import { Controller, Delete, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { AdminAuthGuard } from './admin-auth.guard';
import { CloudWorkspacesService } from './cloud-workspaces.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/cloud-workspaces')
@UseGuards(AdminAuthGuard)
export class CloudWorkspacesController {
  constructor(private readonly spaces: CloudWorkspacesService, private readonly operationControl: OperationControlService) {}

  @Get()
  list(@Req() request: AuthenticatedPlatformRequest) { return this.spaces.list(request.adminUser); }

  @Get('current')
  current(@Req() request: AuthenticatedPlatformRequest) {
    return this.spaces.current(request.adminUser, request.headers['x-cloud-workspace-id']);
  }

  @Post(':id/switch')
  switch(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    return this.spaces.switch(request.adminUser, id);
  }

  @Delete(':id')
  async remove(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    if (!request.adminUser.isPlatformManager) throw new ForbiddenException('仅平台超管可删除云账号绑定。');
    const metadata = readOperationRequestMetadata(request);
    const toolName = 'cloud_account_remove';
    if (request.authContext.source === 'mcp') {
      return this.operationControl.executeConfirmed({ context: request.authContext, metadata, toolName,
        arguments: { cloudWorkspaceId: id }, targetType: 'cloud_workspace', targetId: id,
        resolveConfirmation: async () => {
          const target = await this.spaces.removalTarget(request.adminUser, id);
          return { targetId: id, targetSnapshot: target,
            summary: { ...target, targetName: target.displayName, removesCredentials: true, retainsData: true, destroysCloudResources: false,
              stopsBillingSync: true, lateBillsRequireRebinding: true } };
        }, execute: async () => ({ result: await this.spaces.remove(request.adminUser, id) }) });
    }
    const audit = { requestId: metadata.requestId, operationId: metadata.requestId, actorUserId: request.adminUser.id,
      source: request.authContext.source, oauthClientId: request.authContext.oauthClientId, toolName,
      targetType: 'cloud_workspace', targetId: id, sanitizedInput: { cloudWorkspaceId: id } };
    await this.operationControl.audit({ ...audit, phase: 'requested' });
    try {
      const result = await this.spaces.remove(request.adminUser, id);
      await this.operationControl.audit({ ...audit, phase: 'succeeded' });
      return result;
    } catch (error) {
      await this.operationControl.audit({ ...audit, phase: 'failed', errorCode: 'CLOUD_ACCOUNT_REMOVE_FAILED' });
      throw error;
    }
  }
}

@Controller('admin/session')
@UseGuards(AdminAuthGuard)
export class PlatformSessionController {
  @Get()
  get(@Req() request: AuthenticatedPlatformRequest) { return request.adminUser; }
}
