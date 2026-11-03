'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend, LineChart, Line,
  PieChart, Pie, Cell,
} from 'recharts';
import { formatCurrency, formatDate } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PosBarChartProps {
  days: { day: number; revenue: number; dailyExpense: number; isProfitable: boolean }[];
}

export interface IncomePieChartProps {
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
  profitMargin: number;
}

export interface MonthlyPieChartProps {
  pieData: { name: string; value: number; color: string }[];
}

export interface CashflowChartProps {
  cashflow: { date: string; revenue: number; estimatedProfit: number }[];
}

export interface Forecast90ChartProps {
  days: { date: string; forecastRevenue: number; cumProfit: number }[];
}

export interface ForecastBarChartProps {
  forecast: { date: string; dow: number; forecastRevenue: number; forecastProfit: number }[];
}

export interface SimulatorLineChartProps {
  simData: {
    date: string;
    revenue: number;
    profit: number;
    sim_revenue: number;
    sim_profit: number;
  }[];
}

// ── POS daily revenue bar chart ───────────────────────────────────────────────

export function PosBarChart({ days }: PosBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={days} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={d => `${d}`} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} width={40} />
        <Tooltip
          formatter={(val, name) => [
            formatCurrency(Number(val)),
            name === 'revenue' ? 'מחזור' : name === 'dailyExpense' ? 'הוצאה יומית' : String(name),
          ]}
          labelFormatter={d => `יום ${d}`}
        />
        <Legend formatter={v => v === 'revenue' ? 'מחזור' : 'הוצאה יומית'} />
        <Bar dataKey="revenue" fill="#3b82f6" radius={[3, 3, 0, 0]} name="revenue">
          {days.map((d, i) => (
            <Cell key={i} fill={d.isProfitable ? '#10b981' : '#3b82f6'} />
          ))}
        </Bar>
        <Bar dataKey="dailyExpense" fill="#f97316" radius={[3, 3, 0, 0]} name="dailyExpense" opacity={0.7} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Income vs expense donut ───────────────────────────────────────────────────

export function IncomePieChart({ totalIncome, totalExpense, netProfit, profitMargin }: IncomePieChartProps) {
  const pieData = [
    { name: 'הכנסות', value: Math.max(totalIncome, 0) },
    { name: 'הוצאות', value: Math.max(totalExpense, 0) },
    ...(netProfit > 0 ? [{ name: 'רווח', value: netProfit }] : []),
  ].filter(d => d.value > 0);

  return (
    <div className="relative flex-shrink-0">
      <PieChart width={200} height={200}>
        <Pie
          data={pieData}
          cx={100} cy={100}
          innerRadius={55} outerRadius={90}
          paddingAngle={2}
          dataKey="value"
        >
          <Cell fill="#10b981" />
          <Cell fill="#ef4444" />
          {netProfit > 0 && <Cell fill="#6366f1" />}
        </Pie>
        <Tooltip formatter={val => formatCurrency(Number(val))} />
      </PieChart>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <p className="text-xs text-gray-400">מרווח</p>
        <p className={`text-lg font-black ${profitMargin >= 0 ? 'text-green-700' : 'text-red-700'}`}>
          {profitMargin.toFixed(0)}%
        </p>
      </div>
    </div>
  );
}

// ── Monthly summary donut ─────────────────────────────────────────────────────

export function MonthlyPieChart({ pieData }: MonthlyPieChartProps) {
  return (
    <ResponsiveContainer width={260} height={260}>
      <PieChart>
        <Pie
          data={pieData}
          cx="50%" cy="50%"
          innerRadius={65} outerRadius={110}
          paddingAngle={3}
          dataKey="value"
        >
          {pieData.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip formatter={val => formatCurrency(Number(val))} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ── Cashflow 30-day area chart ────────────────────────────────────────────────

export function CashflowChart({ cashflow }: CashflowChartProps) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={cashflow}>
        <defs>
          <linearGradient id="revenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="profit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={v => formatDate(v, 'dd/MM')} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          formatter={(val, name) => [formatCurrency(Number(val)), name === 'revenue' ? 'הכנסות' : 'רווח משוער']}
          labelFormatter={l => formatDate(l)}
        />
        <Area type="monotone" dataKey="revenue" stroke="#3b82f6" fill="url(#revenue)" strokeWidth={2} />
        <Area type="monotone" dataKey="estimatedProfit" stroke="#10b981" fill="url(#profit)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── 90-day forecast area chart ────────────────────────────────────────────────

export function Forecast90Chart({ days }: Forecast90ChartProps) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={days}>
        <defs>
          <linearGradient id="rev90" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="cum90" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 9 }}
          tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth() + 1}`; }}
          interval={9}
        />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} width={40} />
        <Tooltip
          formatter={(val, name) => [formatCurrency(Number(val)), name === 'forecastRevenue' ? 'הכנסה' : 'רווח מצטבר']}
          labelFormatter={l => new Date(l).toLocaleDateString('he-IL')}
        />
        <Area type="monotone" dataKey="forecastRevenue" stroke="#6366f1" fill="url(#rev90)" strokeWidth={1.5} />
        <Area type="monotone" dataKey="cumProfit" stroke="#10b981" fill="url(#cum90)" strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── 7-day forecast bar chart ──────────────────────────────────────────────────

export function ForecastBarChart({ forecast }: ForecastBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={forecast}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={v => formatDate(v, 'dd/MM')} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          formatter={(val, name) => [formatCurrency(Number(val)), name === 'forecastRevenue' ? 'הכנסה צפויה' : 'רווח צפוי']}
          labelFormatter={l => formatDate(l)}
        />
        <Legend formatter={v => v === 'forecastRevenue' ? 'הכנסה צפויה' : 'רווח צפוי'} />
        <Bar dataKey="forecastRevenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
        <Bar dataKey="forecastProfit" fill="#10b981" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Simulator "what if" line chart ────────────────────────────────────────────

export function SimulatorLineChart({ simData }: SimulatorLineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={simData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={v => formatDate(v, 'dd/MM')} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          formatter={(val, name) => {
            const labels: Record<string, string> = {
              profit: 'רווח בפועל', sim_profit: 'רווח משוער',
              revenue: 'הכנסה בפועל', sim_revenue: 'הכנסה משוערת',
            };
            return [formatCurrency(Number(val)), labels[name as string] || String(name)];
          }}
          labelFormatter={l => formatDate(l)}
        />
        <Legend formatter={v => ({ profit: 'רווח בפועל', sim_profit: 'רווח משוער', revenue: 'הכנסה בפועל', sim_revenue: 'הכנסה משוערת' }[v as string] || v)} />
        <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="4 4" />
        <Line type="monotone" dataKey="sim_profit" stroke="#10b981" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="revenue" stroke="#3b82f6" strokeWidth={2} dot={false} strokeDasharray="4 4" />
        <Line type="monotone" dataKey="sim_revenue" stroke="#3b82f6" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
