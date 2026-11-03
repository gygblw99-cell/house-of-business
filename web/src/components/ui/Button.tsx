import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'gold';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  children: React.ReactNode;
}

const sizes = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  disabled,
  className,
  children,
  style,
  ...props
}: ButtonProps) {
  const computedStyle: React.CSSProperties =
    variant === 'primary'
      ? { background: 'var(--color-primary, #1a5c2a)', color: '#fff', ...style }
      : variant === 'gold'
      ? {
          background: 'linear-gradient(135deg, var(--color-accent, #c9a227) 0%, var(--color-accent, #d4af37) 100%)',
          color: 'var(--color-primary-dark, #0d3518)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.15)',
          ...style,
        }
      : (style ?? {});

  const variantClass =
    variant === 'primary'   ? 'hover:brightness-110 shadow-sm' :
    variant === 'gold'      ? 'font-bold hover:brightness-105' :
    variant === 'secondary' ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' :
    variant === 'outline'   ? 'border border-gray-300 text-gray-700 hover:bg-gray-50' :
    variant === 'ghost'     ? 'text-gray-600 hover:bg-gray-100' :
    /* danger */              'bg-red-600 text-white hover:bg-red-700';

  return (
    <button
      disabled={disabled || loading}
      style={computedStyle}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all',
        'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-primary,#1a5c2a)]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClass,
        sizes[size],
        className
      )}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}
