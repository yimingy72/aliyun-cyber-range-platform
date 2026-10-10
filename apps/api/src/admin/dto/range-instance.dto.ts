import { IsISO8601, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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

export class LaunchRangeInstanceDto {
  @IsString()
  @IsNotEmpty()
  templateId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsISO8601()
  expiresAt!: string;
}

export class TriggerProvisionJobDto {}

export class PreviewRangeInstanceDraftDto {
  @IsInt()
  @Min(1)
  expectedDraftRevision!: number;
}

export class ApplyRangeInstanceDraftDto extends PreviewRangeInstanceDraftDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(192)
  previewToken!: string;
}
