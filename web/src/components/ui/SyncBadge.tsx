'use client';
import { useSyncContext } from '@/context/SyncContext';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';

export function SyncBadge() {
  const { connected, lastSync } = useSyncContext();
  const [syncing, setSyncing] = useState(false);

  // Brief "syncing" flash on lastSync change
  useEffect(() => {
    if (!lastSync) return;
    setSyncing(true);
    const t = setTimeout(() => setSyncing(false), 1200);
    return () => clearTimeout(t);
  }, [lastSync]);

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
      syncing ? 'bg-amber-100 text-amber-700' :
      connected ? 'bg-green-100 text-green-700' :
      'bg-red-100 text-red-600'
    }`}>
      {syncing ? <RefreshCw className="w-3 h-3 animate-spin" /> :
       connected ? <Wifi className="w-3 h-3" /> :
       <WifiOff className="w-3 h-3" />}
      <span>{syncing ? 'מסנכרן...' : connected ? 'מחובר' : 'מנותק'}</span>
    </div>
  );
}
