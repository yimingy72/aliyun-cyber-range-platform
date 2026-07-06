import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateRangeInstanceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  templateId!: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class TriggerProvisionJobDto {
  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}
