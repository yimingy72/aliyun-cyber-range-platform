import { IsInt, Min } from 'class-validator';

export class SyncRangeInstanceTemplateDto {
  @IsInt()
  @Min(1)
  expectedDraftRevision!: number;

  @IsInt()
  @Min(1)
  expectedTemplateRevision!: number;
}
