import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ResourceAlertsQueryDto {
  @IsOptional()
  @IsIn(['pending', 'unverified', 'reclaiming', 'failed', 'resolved'])
  status?: 'pending' | 'unverified' | 'reclaiming' | 'failed' | 'resolved';
}

export class SetResourcePatrolManagerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(192)
  managerUserId?: string;
}

export class ReclaimResourceAlertDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  planDigest!: string;
}
