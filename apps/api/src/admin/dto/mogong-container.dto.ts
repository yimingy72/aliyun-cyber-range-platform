import { IsString, Matches } from 'class-validator';

export class CollectMogongContainersDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  catalogDigest!: string;
}
