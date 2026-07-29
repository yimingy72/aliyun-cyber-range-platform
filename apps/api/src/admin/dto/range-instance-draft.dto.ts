import { IsDefined, IsInt, IsObject, Min } from 'class-validator';

export class SaveRangeInstanceDraftDto {
  @IsDefined()
  @IsObject()
  draftTopologyGraph!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  draftTopologySpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  draftScenarioTemplateSpec!: Record<string, unknown>;

  @IsDefined()
  @IsObject()
  draftCompiledProvisionSpec!: Record<string, unknown>;

  @IsInt()
  @Min(0)
  expectedDraftRevision!: number;
}
