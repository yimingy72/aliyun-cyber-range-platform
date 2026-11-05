'use client';

import { useEffect, useRef, type CSSProperties, type PointerEvent, type RefObject } from 'react';

const preferredWidth = '--billing-detail-preferred-width';
const widthKey = 'admin-billing-detail-width';
const defaultWidth = 768, minWidth = 416, maxWidth = 1120, listInset = 192;

export function billingDetailStyle(): CSSProperties {
  let saved = defaultWidth;
  try {
    const value = Number(localStorage.getItem(widthKey));
    if (value >= minWidth && value <= maxWidth) saved = value;
  } catch { /* The panel still works with browser storage disabled. */ }
  return {
    [preferredWidth]: `${saved}px`,
    '--billing-detail-width': `clamp(${minWidth}px, var(${preferredWidth}), min(${maxWidth}px, max(${minWidth}px, 100% - ${listInset}px)))`,
  } as CSSProperties;
}

export function BillingDetailResize({ panel, panelId }: { panel: RefObject<HTMLDivElement | null>; panelId: string }) {
  const grip = useRef<HTMLDivElement>(null), frame = useRef(0);
  const drag = useRef<{ id: number; x: number; width: number; max: number } | null>(null);
  const available = (element: HTMLElement) => Math.min(maxWidth, Math.max(minWidth, (element.parentElement?.clientWidth || window.innerWidth) - listInset));
  const resize = (width: number, max: number, save = false) => {
    const next = Math.round(Math.max(minWidth, Math.min(max, width)));
    panel.current?.style.setProperty(preferredWidth, `${next}px`);
    if (save) try { localStorage.setItem(widthKey, String(next)); } catch { /* Optional preference. */ }
  };
  useEffect(() => {
    const element = panel.current, handle = grip.current;
    if (!element || !handle) return;
    const update = () => {
      handle.setAttribute('aria-valuemax', String(available(element)));
      handle.setAttribute('aria-valuenow', String(Math.round(element.getBoundingClientRect().width)));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    if (element.parentElement) observer?.observe(element.parentElement);
    return () => { observer?.disconnect(); cancelAnimationFrame(frame.current); };
  }, [panel]);
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    if (!cancelled) resize(start.width + start.x - event.clientX, start.max, true);
  };
  return <div ref={grip} role="separator" aria-label="调整明细宽度" aria-orientation="vertical" aria-controls={panelId}
    aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={defaultWidth} tabIndex={0} title="拖动或使用左右方向键调整明细宽度"
    className="group absolute inset-y-0 -left-2 z-10 hidden w-4 touch-none cursor-col-resize select-none items-center justify-center outline-none sm:flex"
    onPointerDown={event => {
      const element = panel.current;
      if (!element || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width: element.getBoundingClientRect().width, max: available(element) };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      const next = start.width + start.x - event.clientX;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => resize(next, start.max));
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onKeyDown={event => {
      const element = panel.current;
      if (!element || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const width = element.getBoundingClientRect().width, max = available(element);
      resize(event.key === 'Home' ? minWidth : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? 32 : -32), max, true);
    }}>
    <span aria-hidden="true" className="h-9 w-0.5 rounded-full bg-muted-foreground/60 group-hover:bg-primary group-focus-visible:bg-primary group-focus-visible:ring-2 group-focus-visible:ring-ring" />
  </div>;
}
