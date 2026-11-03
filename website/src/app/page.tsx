import { LandingClient } from '@/components/LandingClient';

export const revalidate = 3600;

async function fetchPublicStats() {
  try {
    const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
    const res = await fetch(`${API}/public/stats`, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return res.json();
  } catch {}
  return null;
}

export default async function Page() {
  const liveStats = await fetchPublicStats();
  return <LandingClient liveStats={liveStats} />;
}
