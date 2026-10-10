import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, NotEquals } from 'class-validator';

export class TencentCloudRegionsQueryDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/, { each: true })
  regionIds!: string[];

  @IsString()
  @Matches(/\S/)
  @NotEquals('********')
  accessKeyId!: string;

  @IsString()
  @Matches(/\S/)
  @NotEquals('********')
  accessKeySecret!: string;
}

export class TencentCloudCatalogQueryDto {
  @IsIn(['public', 'custom'])
  scope!: 'public' | 'custom';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
