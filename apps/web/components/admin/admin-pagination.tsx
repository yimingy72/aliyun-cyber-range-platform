'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const PAGE_SIZE_AUTO = 'auto';
export const MANUAL_PAGE_SIZE_OPTIONS = [50, 100, 200];
const ROWS_BASED_PAGE_SIZE_FALLBACK = 8;
const ROW_HEIGHT = 72;
const PAGE_SIZE_RESERVED_HEIGHT = 470;

export function getAutoPageSize(viewportHeight?: number) {
  if (!viewportHeight || Number.isNaN(viewportHeight)) {
    return ROWS_BASED_PAGE_SIZE_FALLBACK;
  }

  return Math.max(1, Math.floor((viewportHeight - PAGE_SIZE_RESERVED_HEIGHT) / ROW_HEIGHT));
}

export function getPagination(totalItems: number, currentPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(currentPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;

  return {
    page,
    totalPages,
    startIndex,
    endIndex: startIndex + pageSize,
  };
}

export function buildVisiblePages(totalPages: number, currentPage: number) {
  const startPage = Math.max(1, currentPage - 1);
  const endPage = Math.min(totalPages, startPage + 2);
  const adjustedStartPage = Math.max(1, endPage - 2);

  return Array.from({ length: endPage - adjustedStartPage + 1 }, (_, index) => adjustedStartPage + index);
}

export function useAdminPageSize() {
  const [pageSizeMode, setPageSizeMode] = useState<string>(PAGE_SIZE_AUTO);
  const [pageSize, setPageSize] = useState(() =>
    getAutoPageSize(typeof window === 'undefined' ? undefined : window.innerHeight),
  );

  useEffect(() => {
    if (pageSizeMode !== PAGE_SIZE_AUTO) {
      return;
    }

    const syncPageSize = () => {
      setPageSize(getAutoPageSize(window.innerHeight));
    };

    syncPageSize();
    window.addEventListener('resize', syncPageSize);

    return () => {
      window.removeEventListener('resize', syncPageSize);
    };
  }, [pageSizeMode]);

  return {
    pageSizeMode,
    pageSize,
    setPageSizeMode,
    setPageSize,
  };
}

export function AdminPaginationControls({
  label,
  pageSizeMode,
  pagination,
  visiblePages,
  jumpPageValue,
  onPageSizeChange,
  onPreviousPage,
  onNextPage,
  onPageSelect,
  onJumpPageValueChange,
  onJumpPage,
}: {
  label: string;
  pageSizeMode: string;
  pagination: ReturnType<typeof getPagination>;
  visiblePages: number[];
  jumpPageValue: string;
  onPageSizeChange: (value: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onPageSelect: (page: number) => void;
  onJumpPageValueChange: (value: string) => void;
  onJumpPage: () => void;
}) {
  return (
    <div aria-label={label} className="image-center-pagination">
      <div className="image-center-pagination-size">
        <span>每页条数</span>
        <Select value={pageSizeMode} onValueChange={onPageSizeChange}>
          <SelectTrigger aria-label="每页条数" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PAGE_SIZE_AUTO}>自动</SelectItem>
            {MANUAL_PAGE_SIZE_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option} 条
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button aria-label="上一页" disabled={pagination.page <= 1} size="sm" type="button" variant="outline" onClick={onPreviousPage}>
        上一页
      </Button>
      <div className="image-center-pagination-pages" aria-label="页码">
        {visiblePages.map((pageNumber) => (
          <Button
            key={pageNumber}
            aria-label={`第 ${pageNumber} 页`}
            aria-pressed={pageNumber === pagination.page}
            size="icon-xs"
            type="button"
            variant={pageNumber === pagination.page ? 'default' : 'outline'}
            onClick={() => onPageSelect(pageNumber)}
          >
            {pageNumber}
          </Button>
        ))}
      </div>
      <Button
        aria-label="下一页"
        disabled={pagination.page >= pagination.totalPages}
        size="sm"
        type="button"
        variant="outline"
        onClick={onNextPage}
      >
        下一页
      </Button>
      <label className="image-center-pagination-jump">
        <span>跳转到</span>
        <Input
          aria-label="跳转到页码"
          min={1}
          max={pagination.totalPages}
          type="number"
          value={jumpPageValue}
          onChange={(event) => onJumpPageValueChange(event.target.value)}
        />
      </label>
      <Button aria-label="跳转" size="sm" type="button" variant="outline" onClick={onJumpPage}>
        跳转
      </Button>
      <span className="image-center-pagination-summary">
        第 {pagination.page} / {pagination.totalPages} 页
      </span>
    </div>
  );
}
