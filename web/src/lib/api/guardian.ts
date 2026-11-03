// טיפוסים בלבד — פאנל הניטור (health/incidents/scan/fix) הוא platform-admin-only
// (backend: requireAdmin) ורץ ב-web/src/app/admin/guardian, לא כאן.
export interface GuardianIncident {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  feature: string;
  issue_summary: string;
  technical_details?: string;
  root_cause_analysis?: string;
  user_impact?: string;
  estimated_risk?: string;
  recommended_fix?: string;
  confidence_score?: number;
  affected_services?: string[];
  logs_summary?: string;
  prediction_analysis?: string;
  status: 'open' | 'acknowledged' | 'resolved';
  monitoring_actions?: string[];
  recovery_actions?: string[];
  occurrence_count: number;
  created_at: string;
  acknowledged_at?: string;
  resolved_at?: string;
  last_seen_at: string;
}

export interface ServiceHealth {
  service: string;
  endpoint?: string;
  status: 'healthy' | 'degraded' | 'down';
  response_time_ms?: number;
  checked_at: string;
  /** true when this service hasn't been probed by a recent scan — its
   *  `status` is a stale reading and must not be shown as current. */
  stale?: boolean;
  age_ms?: number | null;
}

export interface HealthSummary {
  services: ServiceHealth[];
  openBySeverity: Record<string, number>;
  lastScanAt: string | null;
  /** Services whose newest health check is too old to be trusted. */
  staleServices?: string[];
  overallStatus: 'healthy' | 'degraded' | 'down';
}

export interface ScanResult {
  scanned: boolean;
  errorsFound: number;
  newIncidents: number;
  dbStatus: string;
  dbResponseMs: number;
  endpointResults: { name: string; endpoint: string; status: string; responseTime: number }[];
  scanMs: number;
}

export interface FixResult {
  summary: string;
  steps: { action: string; automated: boolean; command?: string; expected_result?: string; status?: string; result?: string }[];
  can_auto_fix: boolean;
  risk_level: string;
  auto_resolved: boolean;
}
