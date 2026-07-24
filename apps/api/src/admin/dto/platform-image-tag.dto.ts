import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreatePlatformImageTagDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  name!: string;
}

export class SetPlatformImageTagsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tagIds!: string[];
}
