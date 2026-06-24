import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTeamDto {
  @IsString()
  @IsNotEmpty()
  competitionId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  contactName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  contactEmailOrPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  competitionId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  contactName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  contactEmailOrPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
