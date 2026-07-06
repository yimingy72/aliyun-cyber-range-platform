import { IsDefined, IsNotEmpty, IsObject, IsString } from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  draftUpdatedBy!: string;
}
