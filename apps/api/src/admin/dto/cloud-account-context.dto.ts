import { IsIn, IsOptional, IsString, Matches, MaxLength, NotEquals } from 'class-validator';

export class SaveCloudAccountContextDto {
  @IsIn(['alibaba_cloud', 'tencent_cloud'])
  provider!: 'alibaba_cloud' | 'tencent_cloud';

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(192)
  cloudWorkspaceId?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  imageImportBucket?: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(64)
  regionId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(80)
  zoneId!: string;

  @IsString()
  @Matches(/\S/)
  @NotEquals('********')
  @MaxLength(128)
  accessKeyId!: string;

  @IsString()
  @Matches(/\S/)
  @NotEquals('********')
  @MaxLength(128)
  accessKeySecret!: string;
}
