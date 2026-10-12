import * as z from 'zod/v4';

const nonEmptyString = z.string().min(1);
const platformErrorResultSchema = z.object({ error: z.json() }).strict();

export const resultOutputSchema = (resultSchema: z.ZodType = z.unknown()) =>
  z.object({
    // Platform failures and confirmation challenges use the same envelope.
    result: z.union([resultSchema, platformErrorResultSchema]),
  });

export const resourceSchema = z
  .object({
    id: nonEmptyString.describe('平台资源唯一标识。'),
  })
  .passthrough();

export const nullableResourceOutputSchema = resultOutputSchema(resourceSchema.nullable());
export const resourceOutputSchema = resultOutputSchema(resourceSchema);
export const resourceListOutputSchema = resultOutputSchema(z.array(resourceSchema));
const imageTagSchema = z.object({ id: nonEmptyString, name: nonEmptyString });
export const imageTagOutputSchema = resultOutputSchema(imageTagSchema);
export const imageTagListOutputSchema = resultOutputSchema(z.array(imageTagSchema));
export const rangeInstanceDetailOutputSchema = resultOutputSchema(resourceSchema.extend({
  networkDiagnostics: z.object({
    status: z.literal('succeeded').describe('本次网络诊断已完成；不代表网络连通性通过。'),
    provider: z.enum(['alibaba_cloud','tencent_cloud']).optional().describe('实例冻结的云服务商。'),
    cloudAccountContextId: z.string().optional().describe('实例冻结的账户工作空间上下文 ID。'),
    evidence: z.array(z.object({ action: z.string(), requestId: z.string() })).optional().describe('只读云 API 操作及脱敏请求 ID，可用于定位云端问题。'),
    guestConfigurationVerified: z.boolean().optional().describe('是否已核验来宾系统网卡配置；云端只读诊断为 false。'),
    checkedAt: z.string().describe('诊断查询时间，ISO-8601。'),
    regionId: z.string().describe('该实例启动时绑定的地域。'),
    cloudAccountUid: z.string().describe('该实例绑定的云账号 UID。'),
    vpcId: z.string().describe('该实例绑定的 VPC ID。'),
  }).passthrough().optional().describe('仅显式请求时提供。服务端按冻结云服务商返回 CVM/ECS、网卡主辅 IP、安全组、ACL、NAT 与路由白名单事实，不含凭据或原始 provider 响应。'),
}).passthrough());

export const removedOutputSchema = (idField: string) =>
  resultOutputSchema(
    z.object({
      removed: z.literal(true).describe('资源已删除。'),
      [idField]: nonEmptyString.describe('已删除资源的唯一标识。'),
    }),
  );

export const customImageCleanupOutputSchema = resultOutputSchema(z.object({
  removed: z.boolean(),
  snapshotId: nonEmptyString.nullable().optional(),
  status: z.string().optional(),
  packedImageArtifactId: nonEmptyString.optional(),
  snapshotIds: z.array(nonEmptyString).optional(),
  deletedSnapshotIds: z.array(nonEmptyString).optional(),
}).passthrough());

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
    imageId: z.string().nullable().optional().describe('当前云厂商的镜像 ID；导入受理后可能返回。'),
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

export const billingReconciliationResourceSchema = z.object({
  resourceKey: nonEmptyString,
  ledgerId: nonEmptyString.nullable(),
  cloudWorkspaceId: nonEmptyString.nullable(),
  cloudProvider: z.enum(['alibaba_cloud', 'tencent_cloud']),
  cloudResourceId: nonEmptyString.nullable(),
  cloudResourceType: z.enum(['ecs', 'disk', 'eip', 'nat_gateway', 'snat_entry', 'dnat_entry', 'image', 'snapshot', 'snapshot_region', 'oss_bucket', 'unknown']),
  rangeInstanceId: nonEmptyString.nullable(),
  sourceProvisionJobId: nonEmptyString.nullable(),
  ownerUserId: nonEmptyString.nullable(),
  cloudAccountUid: nonEmptyString.nullable(),
  regionId: z.string(),
  billingStartAt: z.iso.datetime(),
  releasedAt: z.iso.datetime().nullable(),
  proofFailureReason: z.enum(['SYSTEM_DISK_MAPPING_UNVERIFIED', 'BILL_SYNC_DEFERRED', 'BILL_DETAILS_PENDING', 'ACCOUNT_UID_MISSING', 'IMAGE_OR_STORAGE_SOURCE_PROOF_INCOMPLETE',
    'SOURCE_RANGE_MISSING', 'SOURCE_JOB_MISSING', 'SOURCE_PROOF_UNVERIFIED', 'SOURCE_JOB_NOT_FOUND', 'SOURCE_JOB_WORKSPACE_MISMATCH',
    'SOURCE_JOB_RANGE_MISMATCH', 'SOURCE_JOB_NOT_CREATION', 'SOURCE_JOB_CREATION_INVENTORY_MISSING', 'SOURCE_CREATION_PROOF_CONFLICT',
    'SOURCE_RESOURCE_NOT_IN_CREATION_INVENTORY', 'SOURCE_SNAPSHOT_INVENTORY_OR_BILL_PROOF_INCOMPLETE']),
}).strict();

export const billingSummaryOutputSchema = resultOutputSchema(
  z.object({
    ...billingWindowFields,
    currency: z.string().nullable().optional(),
    currencyTotals: z.array(z.object({ currency: nonEmptyString, totalPretaxAmount: z.number(), platformPretaxAmount: z.number() })).optional(),
    billingScope: z.literal('platform_resources').optional().describe('仅统计有平台创建来源证明的资源；缺失表示范围未确认，不能将旧接口的账号级金额视为平台支出。'),
    reconciliationIssues: z.array(z.object({
      resourceType: z.enum(['snapshot', 'oss', 'unknown', 'disk']),
      resourceCount: z.number().int().nonnegative(),
      reason: nonEmptyString,
      resources: z.array(billingReconciliationResourceSchema).optional().describe('同工作空间内已脱敏的来源和释放时间诊断，不包含凭据或估算金额。'),
    }).strict()).optional().describe('已知平台快照/OSS仍需细分账单，unknown表示历史账号/归属来源待核验，disk表示同实例主机有系统盘费用但准确盘映射待核验；提示不含账号聚合金额，缺失表示状态未知。'),
    totalPretaxAmount: z.number().nullable().describe('已同步并已归属的平台创建资源 BSS 应付金额（PretaxAmount），不包含待分配费用。'),
    platformPretaxAmount: z.number().nullable().describe('已归属平台公共资源的 BSS 应付金额。'),
    billingStatus: z.literal('provisional').optional().describe('账单可能因延迟出账、退款和调账变化；缺失表示接口未提供状态。'),
    unallocatedCurrencyTotals: z.array(z.object({ currency: nonEmptyString, pretaxAmount: z.number() })).optional()
      .describe('已证明属于平台创建资源但尚未分配的精确金额，按币种单列；不包含外部资源或账号混合聚合金额，不计入用户或平台公共费用；缺失表示未知。'),
    resourcesWithoutBillCount: z.number().int().nonnegative().optional()
      .describe('统计窗口内平台创建资源缺少独立费用明细的数量；不含SNAT/DNAT、阿里云镜像、已精确核实由主机系统盘组件覆盖的盘。历史盘映射待核验另列disk问题，不代表云端未出账或免费。'),
    anomalyCount: z.number().int().nonnegative().describe('已证明属于平台创建资源但未能完成归属的异常账单条目数。'),
    resourceTypeTotals: z.array(z.object({ resourceType: nonEmptyString, currency: z.string().optional(), pretaxAmount: z.number() })),
    dailyTotals: z.array(z.object({ billingDate: nonEmptyString, currency: z.string().optional(), pretaxAmount: z.number() })),
  }),
);

export const billingUserSummarySchema = z
  .object({
    userId: nonEmptyString.describe('平台用户 ID。'),
    username: nonEmptyString.describe('平台用户名。'),
    currency: z.string().nullable().optional(),
    amounts: z.array(z.object({ currency: nonEmptyString, pretaxAmount: z.number() })).optional(),
    pretaxAmount: z.number().nullable().describe('用户税前费用，多币种时为null并按amounts读取。'),
    itemCount: z.number().int().nonnegative().describe('账单条目数量。'),
    launchCount: z.number().int().nonnegative().describe('归属启动批次数量。'),
  })
  .passthrough();

function billingPageOutputSchema<T extends z.ZodType>(itemSchema: T) {
  return resultOutputSchema(
    z.object({
      items: z.array(itemSchema),
      page: z.number().int().positive(),
      pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]),
      total: z.number().int().nonnegative(),
    }),
  );
}

export const billingUserListOutputSchema = billingPageOutputSchema(billingUserSummarySchema);

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

export const billingGroupListOutputSchema = billingPageOutputSchema(billingGroupSchema);
export const billingLineItemListOutputSchema = resultOutputSchema(z.array(billingLineItemSchema));

export const billingAnomalyListOutputSchema = resultOutputSchema(
  z.array(
    resourceSchema
      .extend({
        billingDate: nonEmptyString.describe('发现异常的账单日期。'),
        cloudResourceId: nonEmptyString.describe('相关云资源 ID。'),
        cloudResourceType: nonEmptyString.describe('相关云资源类型。'),
        pretaxAmount: z.number().describe('已证明属于平台创建资源的精确异常金额，不含账号混合聚合费用。'),
        currency: nonEmptyString.describe('货币代码。'),
        reason: nonEmptyString.describe('异常归因说明。'),
      })
      .passthrough(),
  ),
);

export const billingSyncOutputSchema = resultOutputSchema(
  z.object({
    syncInProgress: z.boolean().optional(),
    deferredDates: z.array(z.string()).optional(),
    syncedDays: z.number().int().nonnegative().describe('本次同步的账单天数。'),
    importedLineItems: z.number().int().nonnegative().describe('导入或更新的账单条目数。'),
    anomalyCount: z.number().int().nonnegative().describe('本次识别的异常条目数。'),
    deferredCount: z.number().int().nonnegative().describe('尚未完成的日期或正在同步的任务数量。'),
  }),
);
