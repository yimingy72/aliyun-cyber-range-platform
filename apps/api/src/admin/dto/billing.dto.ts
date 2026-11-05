import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class BillingWindowDto {
  @IsOptional()
  @IsIn(['batch'])
  groupBy?: 'batch';

  @IsOptional()
  @IsIn(['issued','partial','unissued','not_applicable','pending'])
  billStatus?: 'issued' | 'partial' | 'unissued' | 'not_applicable' | 'pending';
  @IsOptional()
  @IsIn(['user','platform'])
  view?: 'user' | 'platform';
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([20, 50, 100])
  pageSize?: number;

  @IsOptional()
  @IsString()
  userId?: string;
}
