import { Type } from 'class-transformer';
import { isHostDnsDomain, isHostDnsIpv4 } from '@aliyun-cyber-range/scenario-runtime/compiled';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsDefined,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

class RangeTemplateHostDnsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @ValidateBy({ name: 'isHostDnsIpv4', validator: { validate: isHostDnsIpv4, defaultMessage: () => 'each DNS server must be a usable IPv4 address' } }, { each: true })
  servers!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(128, { each: true })
  @Matches(/^[^\x00-\x1f\x7f]+$/, { each: true })
  nicIds!: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsDefined()
  @ValidateBy({ name: 'isHostDnsDomain', validator: { validate: isHostDnsDomain, defaultMessage: () => 'DNS domain must be a valid ASCII domain name' } })
  domain?: string;
}

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

  @ValidateIf((_object, value) => value !== undefined)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => RangeTemplateHostDnsDto)
  dns?: RangeTemplateHostDnsDto;
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
