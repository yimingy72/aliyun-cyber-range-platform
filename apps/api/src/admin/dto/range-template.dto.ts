import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsDefined,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class RangeTemplateNetworkZoneDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  purpose!: string;

  @IsString()
  @IsNotEmpty()
  cidr!: string;

  @IsOptional()
  @IsBoolean()
  isPublicEntry?: boolean;
}

class RangeTemplateHostDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  hostName?: string;

  @IsString()
  @IsNotEmpty()
  zoneKey!: string;

  @IsString()
  @IsNotEmpty()
  role!: string;

  @IsString()
  @IsNotEmpty()
  privateIp!: string;

  @IsOptional()
  @IsBoolean()
  exposePublic?: boolean;
}

class RangeTemplateEntryProtocolDto {
  @IsString()
  @IsNotEmpty()
  protocol!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;
}

class RangeTemplatePublicEntryDto {
  @IsString()
  @IsNotEmpty()
  hostKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RangeTemplateEntryProtocolDto)
  protocols!: RangeTemplateEntryProtocolDto[];
}

class RangeTemplateTopologySpecDto {
  @IsString()
  @IsNotEmpty()
  vpcCidr!: string;

  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RangeTemplateNetworkZoneDto)
  networkZones!: RangeTemplateNetworkZoneDto[];

  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RangeTemplateHostDto)
  hosts!: RangeTemplateHostDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => RangeTemplatePublicEntryDto)
  publicEntry!: RangeTemplatePublicEntryDto;

  @IsOptional()
  @IsObject()
  executionPolicies?: Record<string, unknown>;
}

export class CreateRangeTemplateDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => RangeTemplateTopologySpecDto)
  topologySpec!: RangeTemplateTopologySpecDto;

  @IsDefined()
  @IsObject()
  topologyGraph!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  scenarioTemplateSpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  compiledProvisionSpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  compiledSpec!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  variableSchema?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  defaultNetworkPolicy?: Record<string, unknown>;
}

export class UpdateRangeTemplateDto {
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

}

export class SaveRangeTemplateTopologyDto {
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => RangeTemplateTopologySpecDto)
  topologySpec!: RangeTemplateTopologySpecDto;

  @IsDefined()
  @IsObject()
  topologyGraph!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  scenarioTemplateSpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  compiledProvisionSpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  compiledSpec!: Record<string, unknown>;
}

export class RangeTemplateRevisionDto {
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
