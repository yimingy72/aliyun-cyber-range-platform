import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class LaunchSingleInstanceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  hostName?: string;

  @IsString()
  @IsNotEmpty()
  platformImageAssetId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  cpu!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  memory!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(20)
  systemDiskSize?: number;

  @IsISO8601()
  expiresAt!: string;

  @IsOptional()
  @IsString()
  password?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}

export class TriggerSingleInstanceActionDto {
  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

export class TriggerSingleInstanceDestroyDto {
  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}
