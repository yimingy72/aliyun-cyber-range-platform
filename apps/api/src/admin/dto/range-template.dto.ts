import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsDefined,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import type { CloudProvider, IacType } from '../admin.repository';

const CLOUD_PROVIDERS: CloudProvider[] = ['alibaba_cloud'];
const IAC_TYPES: IacType[] = ['opentofu', 'terraform'];

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

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsOptional()
  @IsIn(CLOUD_PROVIDERS)
  cloudProvider?: CloudProvider;

  @IsOptional()
  @IsIn(IAC_TYPES)
  iacType?: IacType;

  @IsString()
  @IsNotEmpty()
  modulePathOrRef!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => RangeTemplateTopologySpecDto)
  topologySpec!: RangeTemplateTopologySpecDto;

  @IsOptional()
  @IsObject()
  topologyGraph?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  scenarioTemplateSpec?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  compiledProvisionSpec?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  compiledSpec?: Record<string, unknown>;

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
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  slug?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  version?: string;

  @IsOptional()
  @IsIn(CLOUD_PROVIDERS)
  cloudProvider?: CloudProvider;

  @IsOptional()
  @IsIn(IAC_TYPES)
  iacType?: IacType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  modulePathOrRef?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RangeTemplateTopologySpecDto)
  topologySpec?: RangeTemplateTopologySpecDto;

  @IsOptional()
  @IsObject()
  topologyGraph?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  scenarioTemplateSpec?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  compiledProvisionSpec?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  compiledSpec?: Record<string, unknown>;

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
