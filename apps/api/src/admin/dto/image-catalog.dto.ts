import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsBoolean, IsOptional } from 'class-validator';

export class DeleteCustomImageDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  deleteOwnedSnapshots?: boolean;
}

export class CollectImageCatalogDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  snapshotId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  displayName!: string;
}
