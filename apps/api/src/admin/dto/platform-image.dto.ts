import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const PLATFORM_IMAGE_VIEWS = ['platform', 'mine'] as const;
const PLATFORM_IMAGE_VISIBILITIES = ['private', 'platform'] as const;
export type PlatformImageView = (typeof PLATFORM_IMAGE_VIEWS)[number];
export type PlatformImageVisibility = (typeof PLATFORM_IMAGE_VISIBILITIES)[number];

export class ListPlatformImagesDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(PLATFORM_IMAGE_VIEWS)
  view?: PlatformImageView;
}

export class CollectPlatformImageDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  snapshotId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  displayName!: string;
}

export class UpdatePlatformImageDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(PLATFORM_IMAGE_VISIBILITIES)
  visibility?: PlatformImageVisibility;
}
