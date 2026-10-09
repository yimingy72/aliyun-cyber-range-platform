import { IsIn, IsString, Matches, MaxLength, NotEquals } from 'class-validator';

export class SaveCloudAccountContextDto {
  @IsIn(['tencent_cloud'])
  provider!: 'tencent_cloud';

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
