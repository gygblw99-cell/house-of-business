// ── Auth ──────────────────────────────────────────────────
export interface User {
  userId: string;
  businessId: string;
  email: string;
  fullName: string;
  role: 'owner' | 'partner' | 'manager' | 'employee';
  avatar?: string;
}

export interface Business {
  id: string;
  name: string;
  business_type: string;
  address?: string;
  phone?: string;
  logo_url?: string;
  onboarding_completed?: boolean;
  is_suspended?: boolean;
  suspended_reason?: string | null;
}

// ── Employee ──────────────────────────────────────────────
export interface Employee {
  id: string;
  full_name: string;
  email: string | null;
  phone?: string;
  role: 'owner' | 'partner' | 'manager' | 'employee';
  /** תפקיד מפורט (שף/מלצר/ברמן וכו') — נפרד מ-role שהוא רק דרג הרשאה */
  position?: string | null;
  salary_type: 'hourly' | 'global' | 'tips';
  participates_in_tips?: boolean;
  salary_amount?: number;
  /** @deprecated use salary_amount */
  hourly_rate?: number;
  /** @deprecated use salary_amount */
  global_salary?: number;
  is_active: boolean;
  pending_invite?: boolean;
  username?: string | null;
  avatar_url?: string;
  created_at: string;
  zreport_hours_30d?: number;
  zreport_hours_total?: number;
  zreport_shifts?: number;
}

// ── Shift ─────────────────────────────────────────────────
export interface Shift {
  id: string;
  employee_id: string;
  employee_name?: string;
  start_time: string;
  end_time?: string;
  is_open: boolean;
  notes?: string;
  gross_pay?: number;
  hours_worked?: number;
}

// ── Supplier ──────────────────────────────────────────────
export interface StandingOrderItem {
  name: string;
  qty: number;
  unit?: string;
}

export interface Supplier {
  id: string;
  name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  categories: string[];
  preferred_channel: 'whatsapp' | 'email' | 'phone' | 'fax';
  notes?: string;
  is_active?: boolean;
  standing_order?: {
    items: StandingOrderItem[];
    order_days?: number[];   // 0=ראשון … 6=שבת. null/undefined = כל יום
    auto_send?: boolean;     // true = שלח אוטו, false = המתן לאישור
  };
}

// ── Invoice ───────────────────────────────────────────────
export interface Invoice {
  id: string;
  supplier_id?: string;
  supplier_name?: string;
  invoice_number?: string;
  invoice_date?: string;
  total_amount: number;
  is_paid: boolean;
  paid_at?: string;
  paid_amount?: number;
  approved_at?: string | null;
  ai_confidence?: number;
  is_duplicate: boolean;
  image_urls?: string[];
  notes?: string;
  created_at: string;
  items?: InvoiceItem[];
}

export interface InvoiceItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  unit_price: number;
  total_price: number;
}

// ── Inventory ─────────────────────────────────────────────
export interface InventoryItem {
  id: string;
  name: string;
  category_id?: string;
  category_name?: string;
  unit: string;
  current_qty: number;
  min_qty: number;
  max_qty?: number;
  cost_per_unit: number;
  is_low: boolean;
  expiry_date?: string | null;
  is_expiring_soon?: boolean;
  is_expired?: boolean;
  supplier_id?: string;
  supplier_name?: string;
  item_type?: string;
  purchase_unit?: string | null;
  units_per_purchase?: number;
}

// ── Recipe ────────────────────────────────────────────────
export interface Recipe {
  id: string;
  name: string;
  category?: string;
  selling_price: number;
  prep_time_minutes?: number;
  is_active: boolean;
  cost?: number;
  profit?: number;
  margin?: number;
  ingredients?: RecipeIngredient[];
}

export interface RecipeIngredient {
  id: string;
  inventory_item_id: string;
  item_name: string;
  qty: number;
  unit: string;
  cost?: number;
}

// ── Finance ───────────────────────────────────────────────
export interface DailyProfit {
  date: string;
  revenue: number;
  cost_of_goods: number;
  expenses: number;
  salary: number;
  waste: number;
  profit: number;
  margin: number;
}

export interface CashflowEntry {
  date: string;
  revenue: number;
  transactions: number;
  fixedCost: number;
  estimatedProfit: number;
}

export interface FixedExpense {
  id: string;
  name: string;
  amount: number;
  frequency: 'monthly' | 'weekly' | 'yearly' | 'one_time';
  category: string;
  next_due?: string;
}

// ── AI ────────────────────────────────────────────────────
export interface AiMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  sources?: AiSource[];
  toolsUsed?: string[];
  provider?: 'grok' | 'claude' | 'gemini';
  fallbackTriggered?: boolean;
}

export interface AiSource {
  type: string;
  summary: string;
}

// ── Notification ──────────────────────────────────────────
export interface Notification {
  id: string;
  title: string;
  body: string;
  type: string;
  is_read: boolean;
  created_at: string;
  data?: Record<string, unknown>;
}

// ── Audit ─────────────────────────────────────────────────
export interface AuditReport {
  score: number;
  score_profitability: number;
  score_inventory: number;
  score_employees: number;
  score_avg_order: number;
  recommendations: AuditRecommendation[];
  created_at: string;
  from_date?: string | null;
  to_date?: string | null;
}

export interface AuditRecommendation {
  priority?: number;
  type?: string;
  action: string;
  impact?: string;
}

// ── Dashboard ─────────────────────────────────────────────
// Matches the actual response shape of GET /api/dashboard
// (backend/src/services/dashboard/dashboard.data.js getDashboardData +
// profitLeaks from backend/src/api/dashboard.routes.js) — this previously
// declared a today/week/alerts/audit_score/active_shifts shape that the
// backend never returned, so every field read from it on the dashboard page
// was silently undefined (revenue/profit KPIs always showed ₪0).
export interface DashboardData {
  todayRevenue: {
    revenue: number;
    netProfit: number;
    ordersCount: number;
    revenueChange: number | null;
    profitChange: number | null;
  };
  comparisonDate: 'yesterday' | 'same_weekday_last_week';
  ordersToday: {
    total: number;
    deliveries: number;
    tables: number;
    takeaway: number;
  };
  openTables: {
    count: number;
    tables: { table_number: number; amount: number; opened_at: string; orders: number }[];
  };
  topSellers: { name: string; total_qty: number; total_revenue: number }[];
  weakSellers: { name: string; total_qty: number; total_revenue: number }[];
  lastOrders: { id: string; sale_type: string; table_number: number | null; total_amount: number; sold_at: string; items: { name: string; qty: number }[] }[];
  weeklyChart: { days: { date: string; revenue: number; orders_count: number }[]; weeklyAvg: number };
  emergencyAlerts: { name: string; current_qty: number; min_qty: number; unit: string }[];
  profitLeaks: unknown;
}
