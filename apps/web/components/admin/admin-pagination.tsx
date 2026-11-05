'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
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
  totalItems = Number.isFinite(totalItems) ? Math.max(0, Math.floor(totalItems)) : 0;
  pageSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : DEFAULT_ADMIN_PAGE_SIZE;
  currentPage = Number.isFinite(currentPage) ? Math.floor(currentPage) : 1;
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
  const { page, totalPages: count } = getPagination(totalPages, currentPage, 1);
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis-right', count];
  if (page >= count - 3) return [1, 'ellipsis-left', count - 4, count - 3, count - 2, count - 1, count];
  return [1, 'ellipsis-left', page - 1, page, page + 1, 'ellipsis-right', count];
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
  isPending = false,
  onPageSizeChange,
  onPageSelect,
}: {
  label: string;
  pageSize: AdminPageSize;
  pagination: ReturnType<typeof getPagination>;
  isPending?: boolean;
  onPageSizeChange: (value: AdminPageSize) => void;
  onPageSelect: (page: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [jumpPageValue, setJumpPageValue] = useState(String(pagination.page));
  const visiblePages = buildVisiblePages(pagination.totalPages, pagination.page);
  useLayoutEffect(() => {
    setJumpPageValue(String(pagination.page));
    const body = root.current?.closest('.admin-paginated-list')?.querySelector('.admin-paginated-list-body');
    if (body) body.scrollTop = 0;
  }, [label, pageSize, pagination.page]);
  function selectPage(value: number) {
    const page = getPagination(pagination.totalPages, value, 1).page;
    if (page !== pagination.page) onPageSelect(page);
  }
  function jump() {
    const value = Number(jumpPageValue);
    const page = jumpPageValue.trim() && Number.isSafeInteger(value)
      ? getPagination(pagination.totalPages, value, 1).page : pagination.page;
    setJumpPageValue(String(page));
    selectPage(page);
  }
  return (
    <div aria-label={label} aria-busy={isPending || undefined} className="admin-pagination" ref={root}>
      <span className="admin-pagination-summary">
        {isPending ? `正在加载第 ${pagination.page} 页，共 ${pagination.totalItems} 条` : `显示 ${pagination.itemStart}–${pagination.itemEnd} 条，共 ${pagination.totalItems} 条`}
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
        <Pagination aria-label={`${label}导航`} className="mx-0 w-auto">
          <PaginationContent className="flex-wrap justify-end">
            <PaginationItem><PaginationPrevious aria-label="上一页" aria-disabled={pagination.page <= 1}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50" href="#" tabIndex={pagination.page <= 1 ? -1 : 0}
              text="上一页" onClick={event => { event.preventDefault(); selectPage(pagination.page - 1); }} /></PaginationItem>
            {visiblePages.map(pageNumber => <PaginationItem key={pageNumber}>
              {typeof pageNumber === 'number' ? <PaginationLink aria-label={`第 ${pageNumber} 页`} href="#" isActive={pageNumber === pagination.page}
                onClick={event => { event.preventDefault(); selectPage(pageNumber); }}>{pageNumber}</PaginationLink> : <PaginationEllipsis />}
            </PaginationItem>)}
            <PaginationItem><PaginationNext aria-label="下一页" aria-disabled={pagination.page >= pagination.totalPages}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50" href="#" tabIndex={pagination.page >= pagination.totalPages ? -1 : 0}
              text="下一页" onClick={event => { event.preventDefault(); selectPage(pagination.page + 1); }} /></PaginationItem>
          </PaginationContent>
        </Pagination>
        <form className="admin-pagination-jump" noValidate onSubmit={event => { event.preventDefault(); jump(); }}>
          <label>
            <span>跳转到</span>
            <Input
              aria-label="跳转到页码"
              min={1}
              max={pagination.totalPages}
              type="number"
              value={jumpPageValue}
              onChange={(event) => setJumpPageValue(event.target.value)}
            />
          </label>
          <Button aria-label="跳转" size="sm" type="submit" variant="outline">
            跳转
          </Button>
        </form>
      </div>
    </div>
  );
}
