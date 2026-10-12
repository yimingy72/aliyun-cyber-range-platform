import { Equals, IsISO8601, IsString, Matches, MaxLength } from 'class-validator';
import { OSS_BUCKET_NAME_PATTERN } from '../billing-oss-binding-proof';

export class CreateBillingOssBucketDto {
  @Equals(true)
  dedicated!: true;
}

export class BindBillingOssBucketDto {
  @IsString()
  @Matches(OSS_BUCKET_NAME_PATTERN)
  @MaxLength(63)
  bucketName!: string;

  @IsString()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  @MaxLength(35)
  effectiveStartAt!: string;

  @Equals(true)
  dedicated!: true;
}

export type OssBillingBindingDto = {
  ledgerId: string; bucketName: string; cloudWorkspaceId: string; cloudAccountUid: string; regionId: string;
  effectiveStartAt: string; effectiveEndAt: string | null; declaredAt: string; declaredByUserId: string;
  bucketCreatedAt: string; verifiedAt: string; officialRequestId: string; status: 'active' | 'ended';
};
