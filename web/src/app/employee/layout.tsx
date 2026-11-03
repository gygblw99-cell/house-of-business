import type { Metadata } from 'next';
import '../globals.css';
import { Providers } from '../providers';

export const metadata: Metadata = {
  title: 'אזור עובד — House of Business',
  description: 'פורטל עובדים',
};

export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
