import { IsIn, IsISO8601, IsOptional, IsString, IsNotEmpty } from 'class-validator';

import type { CompetitionStatus } from '../admin.repository';

const COMPETITION_STATUSES: CompetitionStatus[] = ['draft', 'scheduled', 'active', 'completed'];

export class CreateCompetitionDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(COMPETITION_STATUSES)
  status?: CompetitionStatus;

  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  defaultTemplateId?: string;
}

export class UpdateCompetitionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(COMPETITION_STATUSES)
  status?: CompetitionStatus;

  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsISO8601()
  endAt?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  defaultTemplateId?: string;
}
