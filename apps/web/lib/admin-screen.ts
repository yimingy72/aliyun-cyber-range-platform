import { AdminApiError } from './admin-api';

const zhCnDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function isUnauthorizedAdminError(error: unknown) {
  return error instanceof AdminApiError && error.status === 401;
}

export function formatAdminDateTime(value?: string | null) {
  if (!value) {
    return '暂无';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return zhCnDateTimeFormatter.format(date).replace(/\//g, '-');
}
