'use client';

import { useEffect, useState } from 'react';

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
    <div className="image-center-pagination" aria-label={label}>
      <label className="image-center-pagination-size">
        <span>每页条数</span>
        <select aria-label="每页条数" value={pageSizeMode} onChange={(event) => onPageSizeChange(event.target.value)}>
          <option value={PAGE_SIZE_AUTO}>自动</option>
          {MANUAL_PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={String(option)}>
              {option} 条
            </option>
          ))}
        </select>
      </label>
      <button type="button" aria-label="上一页" disabled={pagination.page <= 1} onClick={onPreviousPage}>
        上一页
      </button>
      <div className="image-center-pagination-pages" aria-label="页码">
        {visiblePages.map((pageNumber) => (
          <button
            key={pageNumber}
            type="button"
            aria-label={`第 ${pageNumber} 页`}
            aria-pressed={pageNumber === pagination.page}
            onClick={() => onPageSelect(pageNumber)}
          >
            {pageNumber}
          </button>
        ))}
      </div>
      <button type="button" aria-label="下一页" disabled={pagination.page >= pagination.totalPages} onClick={onNextPage}>
        下一页
      </button>
      <label className="image-center-pagination-jump">
        <span>跳转到</span>
        <input
          aria-label="跳转到页码"
          type="number"
          min={1}
          max={pagination.totalPages}
          value={jumpPageValue}
          onChange={(event) => onJumpPageValueChange(event.target.value)}
        />
      </label>
      <button type="button" aria-label="跳转" onClick={onJumpPage}>
        跳转
      </button>
      <span className="image-center-pagination-summary">
        第 {pagination.page} / {pagination.totalPages} 页
      </span>
    </div>
  );
}
