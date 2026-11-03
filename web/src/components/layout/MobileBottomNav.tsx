'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { setMobileSidebar } from '@/store/slices/uiSlice';
import {
  LayoutDashboard, Monitor, Users, Menu, Package, FileText } from 'lucide-react';

const MAIN_TABS = [
  { href: '/dashboard',  label: 'דשבורד',  icon: LayoutDashboard },
  { href: '/pos',        label: 'קופה',     icon: Monitor },
  { href: '/inventory',  label: 'מלאי',     icon: Package },
  { href: '/invoices',   label: 'חשבוניות', icon: FileText },
  { href: '/employees',  label: 'עובדים',   icon: Users },
];

export function MobileBottomNav() {
  const pathname  = usePathname();
  const dispatch  = useAppDispatch();
  const { mobileSidebarOpen, theme } = useAppSelector((s) => s.ui);
  const dark = theme === 'dark';

  const bg     = dark ? 'rgba(15,17,23,0.97)' : 'rgba(255,255,255,0.97)';
  const border = dark ? '1px solid rgba(45,49,72,0.8)' : '1px solid rgba(0,0,0,0.08)';

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 flex lg:hidden"
      style={{
        background: bg,
        borderTop: border,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.10)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {MAIN_TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + '/');
        return (
          <Link
            key={href}
            href={href}
            className="flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-all"
            style={{ color: active ? 'var(--sb-accent, #60b8e8)' : (dark ? '#6b7280' : '#9ca3af') }}
          >
            <div
              className="w-9 h-9 flex items-center justify-center rounded-xl transition-all"
              style={{ background: active ? 'var(--sb-accent-dim, rgba(100,180,230,0.2))' : 'transparent' }}
            >
              <Icon className="w-5 h-5" />
            </div>
            <span className="text-[10px] font-medium leading-none">{label}</span>
          </Link>
        );
      })}

      {/* כפתור "עוד" — פותח את הסיידבר */}
      <button
        onClick={() => dispatch(setMobileSidebar(!mobileSidebarOpen))}
        className="flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-all"
        style={{ color: mobileSidebarOpen ? 'var(--sb-accent, #60b8e8)' : (dark ? '#6b7280' : '#9ca3af') }}
      >
        <div
          className="w-9 h-9 flex items-center justify-center rounded-xl transition-all"
          style={{ background: mobileSidebarOpen ? 'var(--sb-accent-dim, rgba(100,180,230,0.2))' : 'transparent' }}
        >
          <Menu className="w-5 h-5" />
        </div>
        <span className="text-[10px] font-medium leading-none">עוד</span>
      </button>
    </nav>
  );
}
