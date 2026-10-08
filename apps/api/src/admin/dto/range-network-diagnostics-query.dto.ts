import { Transform } from 'class-transformer';
import { IsBoolean, ValidateIf } from 'class-validator';

export class RangeNetworkDiagnosticsQueryDto {
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  includeNetworkDiagnostics?: boolean;
}
