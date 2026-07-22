import type { ChangeEvent, FormEvent } from 'react';

import type { CloudConfigSnapshot } from '../../../lib/admin-types';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select';
import { Skeleton } from '../../ui/skeleton';

type CloudConfigPanelProps = {
  value: CloudConfigSnapshot | null;
  isLoading?: boolean;
  isSaving?: boolean;
  loadErrorMessage?: string | null;
  saveErrorMessage?: string | null;
  saveSuccessMessage?: string | null;
  onChange: (field: keyof CloudConfigSnapshot, value: string) => void;
  onRetry?: () => void;
  onSubmit: () => void | Promise<void>;
};

function handleInputChange(
  field: keyof CloudConfigSnapshot,
  onChange: CloudConfigPanelProps['onChange'],
) {
  return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    onChange(field, event.target.value);
  };
}

export function CloudConfigPanel({
  value,
  isLoading = false,
  isSaving = false,
  loadErrorMessage = null,
  saveErrorMessage = null,
  saveSuccessMessage = null,
  onChange,
  onRetry,
  onSubmit,
}: CloudConfigPanelProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!value || isLoading || isSaving) {
      return;
    }

    void onSubmit();
  };

  const isFormDisabled = !value || isLoading || isSaving;

  return (
    <form
      aria-busy={isLoading || isSaving}
      className="mt-4 grid gap-4"
      data-testid="cloud-config-form"
      id="cloud-config-form"
      onSubmit={handleSubmit}
    >
      <p className="text-sm leading-6 text-muted-foreground">
        保存时将校验当前阿里云账号。镜像导入仅使用管理员提供的现有 OSS Bucket；平台不会创建 Bucket 或修改其权限、CORS。
      </p>

      {loadErrorMessage ? (
        <div className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{loadErrorMessage}</span>
          {onRetry ? (
            <Button disabled={isSaving} onClick={onRetry} size="sm" type="button" variant="outline">
              重试加载
            </Button>
          ) : null}
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2" data-testid="cloud-config-form-skeleton">
          <span className="sr-only">正在加载云配置</span>
          {Array.from({ length: 6 }, (_, index) => (
            <div className="grid gap-2" key={index}>
              <Skeleton aria-hidden="true" className="h-4 w-24" />
              <Skeleton aria-hidden="true" className="h-8 w-full" />
            </div>
          ))}
        </div>
      ) : value ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="cloud-config-provider">云平台</Label>
              <Select
                disabled={isFormDisabled}
                name="provider"
                value={value.provider}
                onValueChange={(nextValue) => onChange('provider', nextValue)}
              >
                <SelectTrigger aria-label="云平台" className="w-full" id="cloud-config-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alibaba_cloud">阿里云</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cloud-config-default-region">默认地域</Label>
              <Input
                aria-label="默认地域"
                disabled={isFormDisabled}
                id="cloud-config-default-region"
                name="defaultRegion"
                placeholder="cn-hangzhou"
                value={value.defaultRegion}
                onChange={handleInputChange('defaultRegion', onChange)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cloud-config-default-zone">默认可用区</Label>
              <Input
                aria-label="默认可用区"
                disabled={isFormDisabled}
                id="cloud-config-default-zone"
                name="defaultZoneId"
                placeholder="cn-hangzhou-h"
                value={value.defaultZoneId}
                onChange={handleInputChange('defaultZoneId', onChange)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cloud-config-import-bucket">自定义 OSS 存储桶名</Label>
              <Input
                aria-label="自定义 OSS 存储桶名"
                autoComplete="off"
                disabled={isFormDisabled}
                id="cloud-config-import-bucket"
                name="imageImportBucket"
                placeholder="可选，例如 training-image-imports"
                value={value.imageImportBucket}
                onChange={handleInputChange('imageImportBucket', onChange)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cloud-config-access-key-id">AccessKey ID</Label>
              <Input
                aria-label="AccessKey ID"
                autoComplete="off"
                disabled={isFormDisabled}
                id="cloud-config-access-key-id"
                name="accessKeyId"
                value={value.accessKeyId}
                onChange={handleInputChange('accessKeyId', onChange)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cloud-config-access-key-secret">AccessKey Secret</Label>
              <Input
                aria-label="AccessKey Secret"
                autoComplete="new-password"
                disabled={isFormDisabled}
                id="cloud-config-access-key-secret"
                name="accessKeySecret"
                type="password"
                value={value.accessKeySecret}
                onChange={handleInputChange('accessKeySecret', onChange)}
              />
            </div>
          </div>

          <p className="text-sm leading-6 text-muted-foreground">
            仅使用已存在的 Bucket。留空将关闭镜像上传；平台不会创建 Bucket 或修改其权限、CORS。
          </p>
        </>
      ) : null}

      {saveErrorMessage ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {saveErrorMessage}
        </p>
      ) : null}
      {saveSuccessMessage ? (
        <p aria-live="polite" className="rounded-md border border-emerald-700/20 bg-emerald-700/10 px-3 py-2 text-sm text-emerald-700" role="status">
          {saveSuccessMessage}
        </p>
      ) : null}
    </form>
  );
}
