'use client';

/**
 * DatePicker & DateRangePicker — Hebrew-friendly date selection components.
 * Replaces all raw <input type="date"> across the platform.
 *
 * Usage:
 *   <DatePicker value="2026-06-08" onChange={v => ...} />
 *   <DateRangePicker from={from} to={to} onFromChange={...} onToChange={...} />
 */

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft, ChevronRight, Calendar, X } from 'lucide-react';

// ── Date helpers (no timezone shift) ────────────────────────────────────────

function parseLocal(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toIso(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function display(s: string): string {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function isBetween(d: Date, from: Date | null, to: Date | null) {
  if (!from || !to) return false;
  return d >= from && d <= to;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DAYS_HE    = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const MONTHS_HE  = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// ── Build calendar grid (Sun-Sat, 6 weeks) ───────────────────────────────────

function buildGrid(year: number, month: number): Date[] {
  const first   = new Date(year, month, 1);
  const last    = new Date(year, month + 1, 0);
  const startDow = first.getDay();          // 0=Sun
  const endDow   = last.getDay();
  const days: Date[] = [];

  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    days.push(d);
  }
  for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d));
  for (let i = 1; i <= (6 - endDow); i++) days.push(new Date(year, month + 1, i));

  return days;
}

// ── Popup positioning (portal-based, escapes ancestor overflow/scroll clipping) ─

const POPUP_WIDTH = 270; // must match CalendarPopup's w-[270px]

function usePopupPosition(open: boolean, triggerRef: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // RTL: popup's start edge (right side) aligns with the trigger's right edge
      setPos({ top: rect.bottom + 4, left: rect.right - POPUP_WIDTH });
    };
    update();
    window.addEventListener('scroll', update, true); // capture — catches scroll on nested containers (e.g. Modal's overflow-y-auto)
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, triggerRef]);

  return open ? pos : null;
}

// ── Shared calendar popup ────────────────────────────────────────────────────

interface CalendarProps {
  selected: string;           // ISO string, or ''
  rangeFrom?: string;
  rangeTo?: string;
  onSelect: (iso: string) => void;
  min?: string;
  max?: string;
  initialMonth?: string;      // ISO string to focus month on
}

function CalendarPopup({ selected, rangeFrom, rangeTo, onSelect, min, max, initialMonth }: CalendarProps) {
  const focus   = parseLocal(initialMonth || selected || toIso(new Date())) || new Date();
  const [year,  setYear]  = useState(focus.getFullYear());
  const [month, setMonth] = useState(focus.getMonth());

  const selDate  = parseLocal(selected);
  const fromDate = parseLocal(rangeFrom || '');
  const toDate   = parseLocal(rangeTo   || '');
  const minDate  = parseLocal(min || '');
  const maxDate  = parseLocal(max || '');
  const today    = new Date();

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const days = buildGrid(year, month);

  return (
    <div className="p-3 w-[270px]" dir="rtl">
      {/* Month / year navigation */}
      <div className="flex items-center justify-between mb-3">
        <button type="button" onClick={nextMonth}
          className="p-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.1)] text-[rgba(232,232,228,0.5)] transition-colors">
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="text-sm font-bold text-[#e8e8e4]">
          {MONTHS_HE[month]} {year}
        </span>
        <button type="button" onClick={prevMonth}
          className="p-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.1)] text-[rgba(232,232,228,0.5)] transition-colors">
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS_HE.map(d => (
          <div key={d} className="text-center text-[10px] font-semibold text-[rgba(232,232,228,0.28)] py-1">{d}</div>
        ))}
      </div>

      {/* Days */}
      <div className="grid grid-cols-7">
        {days.map((day, i) => {
          const iso          = toIso(day);
          const inCurMonth   = day.getMonth() === month;
          const isSelected   = selDate   ? isSameDay(day, selDate)   : false;
          const isFrom       = fromDate  ? isSameDay(day, fromDate)  : false;
          const isTo         = toDate    ? isSameDay(day, toDate)    : false;
          const inRange      = isBetween(day, fromDate, toDate);
          const isToday      = isSameDay(day, today);
          const disabled     = (minDate && day < minDate) || (maxDate && day > maxDate);

          const highlighted  = isSelected || isFrom || isTo;

          return (
            <button
              key={i}
              type="button"
              disabled={!!disabled}
              onClick={() => !disabled && onSelect(iso)}
              className={[
                'h-8 w-8 mx-auto rounded-lg text-xs font-medium transition-all',
                highlighted
                  ? 'bg-[#c9a227] text-[#0f0f12] font-bold shadow-sm'
                  : inRange
                    ? 'bg-[rgba(201,162,39,0.18)] text-[#e8e8e4]'
                    : isToday
                      ? 'border border-[rgba(201,162,39,0.55)] text-[#e8e8e4]'
                      : inCurMonth
                        ? 'text-[rgba(232,232,228,0.75)] hover:bg-[rgba(201,162,39,0.1)]'
                        : 'text-[rgba(232,232,228,0.2)]',
                disabled ? 'opacity-25 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Single DatePicker ────────────────────────────────────────────────────────

export interface DatePickerProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: string;
  max?: string;
  className?: string;
  label?: string;
  clearable?: boolean;
}

export function DatePicker({
  value, onChange,
  placeholder = 'בחר תאריך',
  min, max,
  className = '',
  label,
  clearable = true,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const pos = usePopupPosition(open, ref);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popupRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={ref} className={`relative ${className}`} dir="rtl">
      {label && <label className="block text-xs font-medium text-[rgba(232,232,228,0.65)] mb-1">{label}</label>}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={[
          'flex items-center gap-2 w-full px-3 py-2 rounded-xl border text-sm transition-colors',
          'bg-[#1a1a20] border-[rgba(201,162,39,0.2)] hover:border-[rgba(201,162,39,0.45)]',
          open ? 'border-[rgba(201,162,39,0.55)]' : '',
        ].join(' ')}
      >
        <Calendar className="w-4 h-4 text-[rgba(201,162,39,0.55)] flex-shrink-0" />
        <span className={`flex-1 text-right ${value ? 'text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.3)]'}`}>
          {value ? display(value) : placeholder}
        </span>
        {clearable && value && (
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); onChange(''); }}
            onKeyDown={e => e.key === 'Enter' && onChange('')}
            className="text-[rgba(232,232,228,0.3)] hover:text-[rgba(232,232,228,0.7)] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        )}
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={popupRef} dir="rtl" className="fixed z-[10000] rounded-2xl border border-[rgba(201,162,39,0.2)] bg-[#141418] shadow-2xl shadow-black/50"
             style={{ top: pos.top, left: pos.left }}>
          <CalendarPopup
            selected={value}
            onSelect={v => { onChange(v); setOpen(false); }}
            min={min}
            max={max}
          />
          {/* Today shortcut */}
          <div className="border-t border-[rgba(201,162,39,0.1)] px-3 pb-3">
            <button
              type="button"
              onClick={() => { onChange(toIso(new Date())); setOpen(false); }}
              className="w-full text-xs text-[rgba(201,162,39,0.65)] hover:text-[#c9a227] py-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.06)] transition-colors font-medium"
            >
              היום
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── DateRangePicker ──────────────────────────────────────────────────────────

type RangeFn = () => [string, string];

const PRESETS: { label: string; getRange: RangeFn }[] = [
  { label: 'היום',    getRange: () => { const t = toIso(new Date()); return [t, t]; } },
  { label: 'אתמול',  getRange: () => { const d = new Date(); d.setDate(d.getDate()-1); const t = toIso(d); return [t, t]; } },
  { label: '7 ימים', getRange: () => { const t = new Date(); const f = new Date(t); f.setDate(f.getDate()-6); return [toIso(f), toIso(t)]; } },
  { label: '30 ימים',getRange: () => { const t = new Date(); const f = new Date(t); f.setDate(f.getDate()-29); return [toIso(f), toIso(t)]; } },
  { label: 'החודש',  getRange: () => { const t = new Date(); const f = new Date(t.getFullYear(), t.getMonth(), 1); return [toIso(f), toIso(t)]; } },
];

export interface DateRangePickerProps {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  className?: string;
  compact?: boolean;    // hide preset labels, show as small chips
}

export function DateRangePicker({
  from, to, onFromChange, onToChange, className = '', compact = false,
}: DateRangePickerProps) {
  const [activePanel, setActivePanel] = useState<'from' | 'to' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const fromBtnRef = useRef<HTMLButtonElement>(null);
  const toBtnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const fromPos = usePopupPosition(activePanel === 'from', fromBtnRef);
  const toPos = usePopupPosition(activePanel === 'to', toBtnRef);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popupRef.current?.contains(t)) return;
      setActivePanel(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const applyPreset = (getRange: RangeFn) => {
    const [f, t] = getRange();
    onFromChange(f);
    onToChange(t);
    setActivePanel(null);
  };

  const clearAll = () => { onFromChange(''); onToChange(''); };

  // shared calendar popup for range — first click sets from, second sets to
  const handleRangeSelect = (iso: string, panel: 'from' | 'to') => {
    if (panel === 'from') {
      onFromChange(iso);
      // if new from > current to, clear to
      if (to && iso > to) onToChange('');
      setActivePanel('to');
    } else {
      if (from && iso < from) {
        // swap
        onToChange(from);
        onFromChange(iso);
      } else {
        onToChange(iso);
      }
      setActivePanel(null);
    }
  };

  return (
    <div ref={ref} className={`flex items-center gap-2 flex-wrap ${className}`} dir="rtl">
      {/* Presets */}
      <div className="flex items-center gap-1">
        {PRESETS.map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.getRange)}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-[#1a1a20] border border-[rgba(201,162,39,0.15)] text-[rgba(232,232,228,0.5)] hover:text-[#c9a227] hover:border-[rgba(201,162,39,0.45)] transition-colors font-medium whitespace-nowrap"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* From / To inputs */}
      <div className="flex items-center gap-1.5">
        {/* From */}
        <div className="relative">
          <button
            ref={fromBtnRef}
            type="button"
            onClick={() => setActivePanel(p => p === 'from' ? null : 'from')}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs transition-colors bg-[#1a1a20]',
              activePanel === 'from'
                ? 'border-[rgba(201,162,39,0.55)] text-[#e8e8e4]'
                : 'border-[rgba(201,162,39,0.2)] hover:border-[rgba(201,162,39,0.4)]',
              from ? 'text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.35)]',
            ].join(' ')}
          >
            <Calendar className="w-3.5 h-3.5 text-[rgba(201,162,39,0.5)]" />
            {from ? display(from) : 'מתאריך'}
          </button>

          {activePanel === 'from' && fromPos && typeof document !== 'undefined' && createPortal(
            <div ref={popupRef} dir="rtl" className="fixed z-[10000] rounded-2xl border border-[rgba(201,162,39,0.2)] bg-[#141418] shadow-2xl shadow-black/50"
                 style={{ top: fromPos.top, left: fromPos.left }}>
              <CalendarPopup
                selected={from}
                rangeFrom={from}
                rangeTo={to}
                onSelect={iso => handleRangeSelect(iso, 'from')}
                max={to || undefined}
              />
            </div>,
            document.body
          )}
        </div>

        <span className="text-[rgba(232,232,228,0.25)] text-xs select-none">—</span>

        {/* To */}
        <div className="relative">
          <button
            ref={toBtnRef}
            type="button"
            onClick={() => setActivePanel(p => p === 'to' ? null : 'to')}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs transition-colors bg-[#1a1a20]',
              activePanel === 'to'
                ? 'border-[rgba(201,162,39,0.55)] text-[#e8e8e4]'
                : 'border-[rgba(201,162,39,0.2)] hover:border-[rgba(201,162,39,0.4)]',
              to ? 'text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.35)]',
            ].join(' ')}
          >
            <Calendar className="w-3.5 h-3.5 text-[rgba(201,162,39,0.5)]" />
            {to ? display(to) : 'עד תאריך'}
          </button>

          {activePanel === 'to' && toPos && typeof document !== 'undefined' && createPortal(
            <div ref={popupRef} dir="rtl" className="fixed z-[10000] rounded-2xl border border-[rgba(201,162,39,0.2)] bg-[#141418] shadow-2xl shadow-black/50"
                 style={{ top: toPos.top, left: toPos.left }}>
              <CalendarPopup
                selected={to}
                rangeFrom={from}
                rangeTo={to}
                onSelect={iso => handleRangeSelect(iso, 'to')}
                min={from || undefined}
              />
            </div>,
            document.body
          )}
        </div>

        {/* Clear */}
        {(from || to) && (
          <button
            type="button"
            onClick={clearAll}
            className="p-1.5 rounded-lg text-[rgba(232,232,228,0.3)] hover:text-[rgba(232,232,228,0.65)] hover:bg-[rgba(232,232,228,0.05)] transition-colors"
            title="נקה תאריכים"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
