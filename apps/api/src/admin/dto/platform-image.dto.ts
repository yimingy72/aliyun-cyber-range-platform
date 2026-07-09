import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const PLATFORM_IMAGE_VIEWS = ['platform', 'mine'] as const;
export type PlatformImageView = (typeof PLATFORM_IMAGE_VIEWS)[number];

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

export class RenamePlatformImageDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  displayName!: string;
}
