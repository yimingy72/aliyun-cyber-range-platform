import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

function trimString(value: unknown) {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateCloudAccountContextDto {
  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  displayName!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  regionId!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  zoneId!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  accessKeyId!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  accessKeySecret!: string;

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  imageImportBucket?: string;
}
