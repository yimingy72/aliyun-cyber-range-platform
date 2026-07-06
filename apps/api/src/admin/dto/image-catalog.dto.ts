import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';

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
