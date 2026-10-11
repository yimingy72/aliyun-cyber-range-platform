import { Prisma } from '@aliyun-cyber-range/database/generated/client';

// Keep intermediate sums exact beyond Decimal.js's default 20 significant digits.
export const BillingDecimal = Prisma.Decimal.clone({ precision: 80 });

export function isSupportedBillingAmount(amount: Prisma.Decimal) {
  // Both Decimal(30, 18) storage and the existing numeric API must preserve each amount.
  return amount.isFinite() && amount.decimalPlaces() <= 18 && amount.abs().lt('100000000000')
    && new BillingDecimal(amount.toNumber()).equals(amount);
}
