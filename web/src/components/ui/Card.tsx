import { cn } from '@/lib/utils';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Card({ className, children, style, ...props }: CardProps) {
  return (
    <div
      className={cn('rounded-2xl', className)}
      style={{
        background: 'var(--glass-bg, rgba(255,255,255,0.72))',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--glass-border, rgba(255,255,255,0.4))',
        boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.08))',
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, style, ...props }: CardProps) {
  return (
    <div
      className={cn('px-6 py-4', className)}
      style={{
        background: 'var(--card-header-bg, rgba(250,250,250,0.8))',
        borderBottom: '1px solid var(--glass-border, rgba(0,0,0,0.06))',
        borderRadius: '1rem 1rem 0 0',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: CardProps) {
  return (
    <h3 className={cn('text-base font-semibold text-gray-800', className)} {...props}>
      {children}
    </h3>
  );
}

export function CardContent({ className, children, ...props }: CardProps) {
  return (
    <div className={cn('px-6 py-4', className)} {...props}>
      {children}
    </div>
  );
}
