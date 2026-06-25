import type {
  ProvisionJobRecord,
  ProvisionJobStepLogRecord,
  RangeInstanceRecord,
} from './admin.repository';

export type RangeRecoveryCategory =
  | 'capacity'
  | 'quota'
  | 'credentials'
  | 'provider_setup'
  | 'template_blueprint'
  | 'unknown';

export type RangeRecoverySummary = {
  category: RangeRecoveryCategory;
  severity: 'warning' | 'critical';
  canRetry: boolean;
  summary: string;
  suggestions: string[];
};

export function buildRangeRecoverySummary(input: {
  instance: RangeInstanceRecord;
  job: ProvisionJobRecord | null;
  steps: ProvisionJobStepLogRecord[];
}): RangeRecoverySummary | null {
  if (!input.instance.status.includes('failed')) {
    return null;
  }

  const combined = [
    input.instance.errorSummary,
    input.job?.errorSummary,
    ...input.steps.flatMap((step) => [step.message, step.stderrExcerpt, step.stdoutExcerpt]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!combined) {
    return {
      category: 'unknown',
      severity: 'warning',
      canRetry: true,
      summary: '暂无可解析失败分类',
      suggestions: ['建议进入任务详情查看完整时间线后再决定是否重试。'],
    };
  }

  if (combined.includes('no saleable ecs instance type') || combined.includes('规格不可售')) {
    return {
      category: 'capacity',
      severity: 'warning',
      canRetry: true,
      summary: '当前可用区没有匹配的可售实例规格',
      suggestions: ['切换可用区或调整实例规格偏好后再重试。'],
    };
  }

  if (combined.includes('quota') || combined.includes('配额')) {
    return {
      category: 'quota',
      severity: 'warning',
      canRetry: true,
      summary: '云资源配额不足导致编排失败',
      suggestions: ['检查 EIP、ECS、VPC 配额是否足够，释放旧资源后再重试。'],
    };
  }

  if (combined.includes('missing required opentofu setting') || combined.includes('access key')) {
    return {
      category: 'credentials',
      severity: 'critical',
      canRetry: false,
      summary: 'Runner 缺少必要的云凭证或环境配置',
      suggestions: ['检查阿里云 AccessKey、区域配置和 Runner 环境变量。'],
    };
  }

  if (combined.includes('provider zip') || combined.includes('provider zip does not exist')) {
    return {
      category: 'provider_setup',
      severity: 'critical',
      canRetry: false,
      summary: 'OpenTofu Provider 包或 Runner 挂载配置异常',
      suggestions: ['检查 Provider Zip 路径、镜像挂载和 Runner 文件系统。'],
    };
  }

  if (combined.includes('topology') || combined.includes('blueprint') || combined.includes('compiledspec')) {
    return {
      category: 'template_blueprint',
      severity: 'warning',
      canRetry: false,
      summary: '模板蓝图或编译产物异常',
      suggestions: ['回到模板中心重新发布模板，确认拓扑与编译产物一致。'],
    };
  }

  return {
    category: 'unknown',
    severity: 'warning',
    canRetry: true,
    summary: '已识别为通用编排失败',
    suggestions: ['建议先查看任务详情中的失败步骤和错误输出，再决定是否直接重试。'],
  };
}
