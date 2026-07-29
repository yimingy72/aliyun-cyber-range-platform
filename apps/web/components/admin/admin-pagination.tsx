'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const ADMIN_PAGE_SIZE_STORAGE_KEY = 'admin-page-size';
export const ADMIN_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const DEFAULT_ADMIN_PAGE_SIZE = 20;

export type AdminPageSize = (typeof ADMIN_PAGE_SIZE_OPTIONS)[number];
export type VisiblePage = number | 'ellipsis-left' | 'ellipsis-right';

function parsePageSize(value: number | string | null | undefined): AdminPageSize {
  const numericValue = typeof value === 'number' ? value : Number(value);

  return ADMIN_PAGE_SIZE_OPTIONS.includes(numericValue as AdminPageSize)
    ? (numericValue as AdminPageSize)
    : DEFAULT_ADMIN_PAGE_SIZE;
}

export function getPagination(totalItems: number, currentPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(currentPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;

  return {
    totalItems,
    page,
    totalPages,
    startIndex,
    endIndex: startIndex + pageSize,
    itemStart: totalItems === 0 ? 0 : startIndex + 1,
    itemEnd: Math.min(startIndex + pageSize, totalItems),
  };
}

export function buildVisiblePages(totalPages: number, currentPage: number): VisiblePage[] {
  if (totalPages <= 1) {
    return [1];
  }

  const page = Math.min(Math.max(currentPage, 1), totalPages);
  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  const sortedPages = [...pages].filter((candidate) => candidate >= 1 && candidate <= totalPages).sort((left, right) => left - right);
  const visiblePages: VisiblePage[] = [];

  for (const pageNumber of sortedPages) {
    const previousPage = visiblePages.at(-1);
    const previousNumber = typeof previousPage === 'number' ? previousPage : 0;

    if (previousNumber && pageNumber - previousNumber > 1) {
      visiblePages.push(previousNumber === 1 ? 'ellipsis-left' : 'ellipsis-right');
    }

    visiblePages.push(pageNumber);
  }

  return visiblePages;
}

export function useAdminPageSize() {
  const [pageSize, setPageSizeState] = useState<AdminPageSize>(DEFAULT_ADMIN_PAGE_SIZE);

  useEffect(() => {
    const savedPageSize = window.localStorage.getItem(ADMIN_PAGE_SIZE_STORAGE_KEY);
    const nextPageSize = parsePageSize(savedPageSize);

    if (nextPageSize === DEFAULT_ADMIN_PAGE_SIZE && savedPageSize !== null && savedPageSize !== String(nextPageSize)) {
      window.localStorage.removeItem(ADMIN_PAGE_SIZE_STORAGE_KEY);
    }

    setPageSizeState(nextPageSize);
  }, []);

  const setPageSize = useCallback((nextValue: number | string) => {
    const nextPageSize = parsePageSize(nextValue);
    setPageSizeState(nextPageSize);

    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(ADMIN_PAGE_SIZE_STORAGE_KEY, String(nextPageSize));
  }, []);

  return {
    pageSize,
    setPageSize,
  };
}

export function AdminPaginationControls({
  label,
  pageSize,
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
  pageSize: AdminPageSize;
  pagination: ReturnType<typeof getPagination>;
  visiblePages: VisiblePage[];
  jumpPageValue: string;
  onPageSizeChange: (value: AdminPageSize) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onPageSelect: (page: number) => void;
  onJumpPageValueChange: (value: string) => void;
  onJumpPage: () => void;
}) {
  return (
    <div aria-label={label} className="admin-pagination">
      <span className="admin-pagination-summary">
        显示 {pagination.itemStart}–{pagination.itemEnd} 条，共 {pagination.totalItems} 条
      </span>
      <div className="admin-pagination-actions">
        <div className="admin-pagination-size">
          <span>每页条数</span>
          <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(parsePageSize(value))}>
            <SelectTrigger aria-label="每页条数" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADMIN_PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} 条
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="admin-pagination-navigation">
          <Button aria-label="上一页" disabled={pagination.page <= 1} size="sm" type="button" variant="outline" onClick={onPreviousPage}>
            上一页
          </Button>
          <div className="admin-pagination-pages" aria-label="页码">
            {visiblePages.map((pageNumber, index) =>
              typeof pageNumber === 'number' ? (
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
              ) : (
                <span aria-hidden="true" className="admin-pagination-ellipsis" key={`${pageNumber}-${index}`}>
                  …
                </span>
              ),
            )}
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
        </div>
        <div className="admin-pagination-jump">
          <label>
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
        </div>
      </div>
    </div>
  );
}
