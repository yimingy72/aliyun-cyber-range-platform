import type { BillingRange } from '@/lib/billing-lifecycle-api';

const preciseMoneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 18,
});

export function getDefaultRange(): BillingRange {
  const endAt = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}T00:00:00.000Z`);
  const startAt = new Date(endAt);
  startAt.setUTCDate(startAt.getUTCDate() - 29);

  return {
    startAt: startAt.toISOString().slice(0, 10),
    endAt: endAt.toISOString().slice(0, 10),
  };
}

export function formatMoney(value: number | string | null | undefined, currency = 'CNY') {
  if (value === null) return '按币种查看';
  if (typeof value === 'string' ? value.length > 128 || !/^-?\d+(?:\.\d{1,18})?$/.test(value) : typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  // Intl accepts decimal strings without converting them to a rounded Number.
  const amount = value as number;

  if (currency === 'CNY') {
    return `¥ ${preciseMoneyFormatter.format(amount)}`;
  }

  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 18,
    }).format(amount);
  } catch {
    return `${currency} ${preciseMoneyFormatter.format(amount)}`;
  }
}

export function downloadCsv(contents: string, fileName: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.URL.revokeObjectURL(url);
}
