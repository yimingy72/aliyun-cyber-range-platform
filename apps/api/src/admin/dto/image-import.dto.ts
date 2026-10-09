import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const IMAGE_FORMATS = ['qcow2', 'raw', 'vhd'] as const;
const OS_TYPES = ['linux', 'windows'] as const;
const ARCHITECTURES = ['x86_64', 'arm64'] as const;
const BOOT_MODES = ['BIOS', 'UEFI'] as const;

function trimString(value: unknown) {
  return typeof value === 'string' ? value.trim() : value;
}

function lowerCaseString(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function upperCaseString(value: unknown) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CreateImageImportDto {
  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  cloudContextId!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  displayName!: string;

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  defaultHostName?: string;

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  defaultPassword?: string;

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  description?: string;

  @Transform(({ value }) => lowerCaseString(value))
  @IsIn(OS_TYPES)
  osType!: (typeof OS_TYPES)[number];

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  platform?: string;

  @Transform(({ value }) => trimString(value))
  @IsIn(ARCHITECTURES)
  architecture!: (typeof ARCHITECTURES)[number];

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MaxLength(128)
  osVersion?: string;

  @Transform(({ value }) => upperCaseString(value))
  @IsIn(BOOT_MODES)
  bootMode!: (typeof BOOT_MODES)[number];

  @Transform(({ value }) => lowerCaseString(value))
  @IsIn(IMAGE_FORMATS)
  imageFormat!: (typeof IMAGE_FORMATS)[number];

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(2048)
  systemDiskSize!: number;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @IsNotEmpty()
  sourceFileName!: string;

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  sourceContentType?: string;

  @Transform(({ value }) => Number(value))
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  sourceSizeBytes!: number;
}
