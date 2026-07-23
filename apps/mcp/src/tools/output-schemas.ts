import * as z from 'zod/v4';

const nonEmptyString = z.string().min(1);

export const resultOutputSchema = (resultSchema: z.ZodType = z.unknown()) =>
  z.object({
    result: resultSchema,
  });

export const resourceSchema = z
  .object({
    id: nonEmptyString.describe('平台资源唯一标识。'),
  })
  .passthrough();

export const nullableResourceOutputSchema = resultOutputSchema(resourceSchema.nullable());
export const resourceOutputSchema = resultOutputSchema(resourceSchema);
export const resourceListOutputSchema = resultOutputSchema(z.array(resourceSchema));

export const removedOutputSchema = (idField: string) =>
  resultOutputSchema(
    z.object({
      removed: z.literal(true).describe('资源已删除。'),
      [idField]: nonEmptyString.describe('已删除资源的唯一标识。'),
    }),
  );

export const actionOutputSchema = resultOutputSchema(
  z
    .object({
      status: z.string().optional().describe('操作状态。'),
      jobId: nonEmptyString.optional().describe('异步任务唯一标识；存在时需用 provision_job_get 跟踪。'),
    })
    .passthrough(),
);

export const csvExportOutputSchema = resultOutputSchema(
  z.object({
    fileName: nonEmptyString.describe('建议使用的 CSV 文件名。'),
    rowCount: z.number().int().nonnegative().describe('CSV 数据行数，不含表头。'),
    csv: z.string().describe('UTF-8 CSV 文本。仅在用户明确授权导出时处理其内容。'),
  }),
);

const imageSnapshotSchema = resourceSchema
  .extend({
    imageId: nonEmptyString.optional().describe('云镜像 ID。'),
    scope: z.enum(['public', 'custom']).or(z.string()).describe('镜像目录范围。'),
    isAvailable: z.boolean().describe('云镜像是否可用。'),
  })
  .passthrough();

const imageCatalogItemSchema = resourceSchema
  .extend({
    displayName: nonEmptyString.describe('镜像显示名称。'),
    imageId: nonEmptyString.describe('云镜像 ID。'),
    enabled: z.boolean().describe('是否允许被平台使用。'),
  })
  .passthrough();

export const imageCatalogOutputSchema = resultOutputSchema(
  z.object({
    snapshots: z.array(imageSnapshotSchema).describe('当前目录中的云镜像快照。'),
    catalogItems: z.array(imageCatalogItemSchema).describe('当前目录已收录的镜像条目。'),
  }),
);

export const imageImportJobSchema = resourceSchema
  .extend({
    status: z.enum(['awaiting_upload', 'importing', 'available', 'failed', 'cancelled']).describe('导入任务状态。'),
    displayName: nonEmptyString.describe('目标平台镜像显示名称。'),
    imageId: z.string().nullable().optional().describe('阿里云镜像 ID；导入受理后可能返回。'),
    errorMessage: z.string().nullable().optional().describe('失败原因；只用于诊断，不含凭据。'),
  })
  .passthrough();

export const imageImportJobListOutputSchema = resultOutputSchema(
  z.object({
    items: z.array(imageImportJobSchema).describe('当前调用者可见的镜像导入任务。'),
  }),
);

const billingWindowFields = {
  startAt: z.string().describe('统计起始日期，YYYY-MM-DD。'),
  endAt: z.string().describe('统计结束日期，YYYY-MM-DD。'),
};

export const billingSummaryOutputSchema = resultOutputSchema(
  z.object({
    ...billingWindowFields,
    totalPretaxAmount: z.number().describe('统计窗口内含税前总费用。'),
    platformPretaxAmount: z.number().describe('平台自有资源税前费用。'),
    anomalyCount: z.number().int().nonnegative().describe('未归属或异常账单条目数。'),
    resourceTypeTotals: z.array(z.object({ resourceType: nonEmptyString, pretaxAmount: z.number() })),
    dailyTotals: z.array(z.object({ billingDate: nonEmptyString, pretaxAmount: z.number() })),
  }),
);

export const billingUserSummarySchema = z
  .object({
    userId: nonEmptyString.describe('平台用户 ID。'),
    username: nonEmptyString.describe('平台用户名。'),
    pretaxAmount: z.number().describe('用户税前费用。'),
    itemCount: z.number().int().nonnegative().describe('账单条目数量。'),
    launchCount: z.number().int().nonnegative().describe('归属启动批次数量。'),
  })
  .passthrough();

export const billingUserListOutputSchema = resultOutputSchema(z.array(billingUserSummarySchema));

export const billingLineItemSchema = resourceSchema
  .extend({
    billingDate: nonEmptyString.describe('账单日期。'),
    cloudResourceId: nonEmptyString.describe('云资源 ID。'),
    cloudResourceType: nonEmptyString.describe('云资源类型。'),
    pretaxAmount: z.number().describe('税前金额。'),
    currency: nonEmptyString.describe('货币代码。'),
    billingScope: z.enum(['user', 'platform']).describe('费用归属范围。'),
  })
  .passthrough();

export const billingGroupSchema = resourceSchema
  .extend({
    kind: z.enum(['range_launch', 'single_launch', 'unmatched']).describe('费用归属分组类型。'),
    title: nonEmptyString.describe('分组显示名称。'),
    pretaxAmount: z.number().describe('分组税前金额。'),
    currency: nonEmptyString.describe('货币代码。'),
    resourceCount: z.number().int().nonnegative().describe('分组资源数。'),
    items: z.array(billingLineItemSchema).describe('分组内账单条目。'),
  })
  .passthrough();

export const billingGroupListOutputSchema = resultOutputSchema(z.array(billingGroupSchema));
export const billingLineItemListOutputSchema = resultOutputSchema(z.array(billingLineItemSchema));

export const billingAnomalyListOutputSchema = resultOutputSchema(
  z.array(
    resourceSchema
      .extend({
        billingDate: nonEmptyString.describe('发现异常的账单日期。'),
        cloudResourceId: nonEmptyString.describe('相关云资源 ID。'),
        cloudResourceType: nonEmptyString.describe('相关云资源类型。'),
        pretaxAmount: z.number().describe('异常条目的税前金额。'),
        currency: nonEmptyString.describe('货币代码。'),
        reason: nonEmptyString.describe('异常归因说明。'),
      })
      .passthrough(),
  ),
);

export const billingSyncOutputSchema = resultOutputSchema(
  z.object({
    syncedDays: z.number().int().nonnegative().describe('本次同步的账单天数。'),
    importedLineItems: z.number().int().nonnegative().describe('导入或更新的账单条目数。'),
    anomalyCount: z.number().int().nonnegative().describe('本次识别的异常条目数。'),
    deferredCount: z.number().int().nonnegative().describe('暂缓处理的条目数。'),
  }),
);
