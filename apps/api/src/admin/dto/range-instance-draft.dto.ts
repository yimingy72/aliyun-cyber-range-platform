import { IsDefined, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class SaveRangeInstanceDraftDto {
  @IsDefined()
  @IsObject()
  draftTopologyGraph!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  draftScenarioTemplateSpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  draftCompiledProvisionSpec!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  draftUpdatedBy?: string;
}
