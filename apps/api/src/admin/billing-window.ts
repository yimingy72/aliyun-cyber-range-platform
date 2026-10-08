import { BadRequestException } from '@nestjs/common';

const billingDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

export function billingDayText(value: Date) {
  return billingDayFormatter.format(value);
}

export function billingDate(value: string | Date) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException('账期必须是有效的 YYYY-MM-DD 日期。');
  const text = value instanceof Date ? billingDayText(date) : date.toISOString().slice(0, 10);
  if (typeof value === 'string' && value !== text) {
    throw new BadRequestException('账期必须是有效的 YYYY-MM-DD 日期。');
  }
  return new Date(`${text}T00:00:00.000Z`);
}

export function resolveBillingWindow(input: { startAt?: string | Date; endAt?: string | Date }, defaultDays = 30) {
  if (Boolean(input.startAt) !== Boolean(input.endAt)) {
    throw new BadRequestException('开始和结束账期必须同时提供。');
  }
  const today = billingDayText(new Date());
  const endAt = billingDate(input.endAt ?? today);
  const startAt = input.startAt ? billingDate(input.startAt) : new Date(endAt.getTime() - (defaultDays - 1) * 86_400_000);
  if (startAt > endAt) throw new BadRequestException('开始账期不能晚于结束账期。');
  return { startAt, endAt, startAtText: startAt.toISOString().slice(0, 10), endAtText: endAt.toISOString().slice(0, 10) };
}
