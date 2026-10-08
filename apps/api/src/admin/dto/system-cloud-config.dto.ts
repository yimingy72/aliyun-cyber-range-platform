import { IsIn, IsString, Matches, NotEquals, ValidateIf } from 'class-validator';

export class UpdateSystemCloudConfigDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['alibaba_cloud'])
  provider?: 'alibaba_cloud';

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  defaultRegion?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  defaultZoneId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @NotEquals('********')
  accessKeyId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  accessKeySecret?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  imageImportBucket?: string;
}
