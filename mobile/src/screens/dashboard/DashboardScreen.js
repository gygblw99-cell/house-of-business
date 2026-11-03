import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { fetchDashboard } from '../../store/slices/dashboardSlice';
import { fetchUnreadCount } from '../../store/slices/notificationsSlice';
import StatCard from '../../components/StatCard';
import AlertBanner from '../../components/AlertBanner';
import api from '../../services/api';

export default function DashboardScreen({ navigation }) {
  const dispatch  = useDispatch();
  const { data, loading } = useSelector(s => s.dashboard);
  const { unreadCount }   = useSelector(s => s.notifications);
  const { user, business } = useSelector(s => s.auth);

  // /dashboard לא מחזיר את השדות האלה — כל אחד נטען בנפרד מה-endpoint האמיתי שלו.
  // activeShifts ו-auditScore דורשים הרשאות מיוחדות (employees/audit) — נכשל בשקט אם אין.
  const [activeShiftsCount, setActiveShiftsCount] = useState(0);
  const [auditScore,        setAuditScore]        = useState(null);
  const [foodCostPct,       setFoodCostPct]        = useState(null);

  const load = useCallback(() => {
    dispatch(fetchDashboard());
    dispatch(fetchUnreadCount());
    api.getActiveShifts()
      .then(res => setActiveShiftsCount((res?.shifts || []).length))
      .catch(() => setActiveShiftsCount(0));
    api.getAuditLatest()
      .then(res => setAuditScore(res?.hasData ? res.score : null))
      .catch(() => setAuditScore(null));
    api.getMenuEngineering(30)
      .then(res => setFoodCostPct(res?.summary?.avgFoodCostPct ?? null))
      .catch(() => setFoodCostPct(null));
  }, [dispatch]);

  useEffect(() => { load(); }, [load]);

  // Normalize backend field names to match screen expectations
  const d = data ? {
    ...data,
    inventoryAlerts: data.emergencyAlerts || [],
    today: {
      revenue:      data.todayRevenue?.revenue || 0,
      transactions: parseInt(data.ordersToday?.total || 0),
      avgOrder:     parseInt(data.ordersToday?.total || 0) > 0
        ? (data.todayRevenue?.revenue || 0) / parseInt(data.ordersToday.total)
        : 0,
    },
    comparison: {
      direction: (data.todayRevenue?.revenueChange ?? 0) >= 0 ? 'up' : 'down',
      pct:       Math.abs(data.todayRevenue?.revenueChange || 0),
    },
    recentSales:  data.lastOrders || [],
  } : null;

  return (
    <ScrollView
      style={s.container}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
    >
      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.greeting}>שלום, {user?.fullName || 'בעל עסק'}</Text>
          <Text style={s.businessName}>{business?.name || ''}</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate('Notifications')}>
          <View style={s.bellWrap}>
            <Text style={s.bell}>🔔</Text>
            {unreadCount > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeText}>{unreadCount}</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>

      {loading && !d ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 60 }} />
      ) : (
        <>
          {/* התראות מלאי */}
          {d?.inventoryAlerts?.length > 0 && (
            <AlertBanner
              title={`⚠️ מלאי נמוך — ${d.inventoryAlerts.length} פריטים`}
              onPress={() => navigation.navigate('Inventory', { lowStock: true })}
            />
          )}

          {/* כרטיסי סטטיסטיקה */}
          <View style={s.statsGrid}>
            <StatCard
              label="הכנסות היום"
              value={`₪${d?.today?.revenue?.toFixed(0) || 0}`}
              sub={d?.comparison?.direction === 'up' ? '↑ לעומת אתמול' : '↓ לעומת אתמול'}
              color={d?.comparison?.direction === 'up' ? '#10B981' : '#EF4444'}
            />
            <StatCard
              label="עסקאות היום"
              value={d?.today?.transactions || 0}
              sub="מספר הזמנות"
              color="#6366F1"
            />
            <StatCard
              label="ממוצע הזמנה"
              value={`₪${d?.today?.avgOrder?.toFixed(0) || 0}`}
              sub="ממוצע לעסקה"
              color="#F59E0B"
            />
            <StatCard
              label="עובדים פעילים"
              value={activeShiftsCount}
              sub="במשמרת עכשיו"
              color="#8B5CF6"
            />
          </View>

          {/* ניקוד ביקורת */}
          {auditScore != null && (
            <TouchableOpacity style={s.auditCard} onPress={() => navigation.navigate('Audit')}>
              <Text style={s.auditLabel}>ניקוד עסקי</Text>
              <View style={s.auditRow}>
                <Text style={s.auditScore}>{auditScore}/100</Text>
                <Text style={s.auditArrow}>←</Text>
              </View>
              <View style={s.auditBar}>
                <View style={[s.auditFill, {
                  width: `${auditScore}%`,
                  backgroundColor: auditScore >= 70 ? '#10B981' : auditScore >= 50 ? '#F59E0B' : '#EF4444',
                }]} />
              </View>
            </TouchableOpacity>
          )}

          {/* Food Cost % */}
          {foodCostPct != null && (
            <View style={[s.foodCostCard, { borderLeftColor: foodCostPct > 35 ? '#EF4444' : '#10B981' }]}>
              <Text style={s.foodCostLabel}>Food Cost</Text>
              <Text style={[s.foodCostVal, { color: foodCostPct > 35 ? '#EF4444' : '#10B981' }]}>
                {parseFloat(foodCostPct).toFixed(1)}%
              </Text>
              <Text style={s.foodCostBench}>{foodCostPct > 35 ? '⚠️ מעל יעד 35%' : '✅ בטווח תקין'}</Text>
            </View>
          )}

          {/* קיצורי דרך */}
          <Text style={s.sectionTitle}>ניווט מהיר</Text>
          <View style={s.shortcuts}>
            {[
              { icon: '📦', label: 'מלאי',     screen: 'Inventory' },
              { icon: '🧾', label: 'חשבוניות', screen: 'Invoices' },
              { icon: '🍽️', label: 'מתכונים',  screen: 'Recipes' },
              { icon: '📊', label: 'כספים',     screen: 'Finance' },
            ].map(item => (
              <TouchableOpacity
                key={item.screen}
                style={s.shortcut}
                onPress={() => navigation.navigate(item.screen)}
              >
                <Text style={s.shortcutIcon}>{item.icon}</Text>
                <Text style={s.shortcutLabel}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* פיצ'רים נוספים */}
          <Text style={s.sectionTitle}>כלי ניהול</Text>
          <View style={s.extraGrid}>
            {[
              { icon: '✅', label: 'משימות',     tab: 'More', screen: 'Tasks' },
              { icon: '👥', label: 'לקוחות',     tab: 'More', screen: 'Customers' },
              { icon: '🔢', label: 'תור',         tab: 'More', screen: 'Queue' },
              { icon: '⭐', label: 'ביקורות',     tab: 'More', screen: 'Reviews' },
              { icon: '📊', label: 'דוח שבועי',  tab: 'More', screen: 'WeeklyReports' },
              { icon: '🍽️', label: 'תפריט',      tab: 'More', screen: 'MenuEngineering' },
            ].map(item => (
              <TouchableOpacity
                key={item.screen}
                style={s.extraCard}
                onPress={() => navigation.navigate(item.tab, { screen: item.screen })}
              >
                <Text style={s.extraIcon}>{item.icon}</Text>
                <Text style={s.extraLabel}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 5 מכירות אחרונות */}
          {d?.recentSales?.length > 0 && (
            <>
              <Text style={s.sectionTitle}>מכירות אחרונות</Text>
              {d.recentSales.map((sale, i) => (
                <View key={i} style={s.saleRow}>
                  <Text style={s.saleAmount}>₪{parseFloat(sale.total_amount).toFixed(2)}</Text>
                  <Text style={s.saleType}>{sale.sale_type}</Text>
                  <Text style={s.saleDate}>
                    {new Date(sale.sold_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 56 },
  greeting:     { color: '#F9FAFB', fontSize: 20, fontWeight: '700' },
  businessName: { color: '#9CA3AF', fontSize: 13, marginTop: 2 },
  bellWrap:     { position: 'relative' },
  bell:         { fontSize: 24 },
  badge:        {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: '#EF4444', borderRadius: 10, minWidth: 18, height: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  badgeText:    { color: '#fff', fontSize: 10, fontWeight: '700' },
  statsGrid:    { flexDirection: 'row', flexWrap: 'wrap', padding: 12, gap: 12 },
  auditCard:    { margin: 16, backgroundColor: '#1E1E2E', borderRadius: 16, padding: 16 },
  auditLabel:   { color: '#9CA3AF', fontSize: 13, textAlign: 'right' },
  auditRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 8 },
  auditScore:   { color: '#F9FAFB', fontSize: 28, fontWeight: '700' },
  auditArrow:   { color: '#6366F1', fontSize: 18 },
  auditBar:     { height: 8, backgroundColor: '#374151', borderRadius: 4, overflow: 'hidden' },
  auditFill:    { height: '100%', borderRadius: 4 },
  sectionTitle:  { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginHorizontal: 16, marginTop: 20, marginBottom: 12, textAlign: 'right' },
  shortcuts:     { flexDirection: 'row', justifyContent: 'space-around', marginHorizontal: 16, marginBottom: 8 },
  shortcut:      { alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 16, padding: 16, flex: 1, marginHorizontal: 4 },
  shortcutIcon:  { fontSize: 28, marginBottom: 6 },
  shortcutLabel: { color: '#F9FAFB', fontSize: 12, fontWeight: '600' },
  foodCostCard:  { marginHorizontal: 16, marginTop: 8, backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', borderLeftWidth: 4 },
  foodCostLabel: { color: '#9CA3AF', fontSize: 13, flex: 1, textAlign: 'right' },
  foodCostVal:   { fontSize: 24, fontWeight: '700', marginHorizontal: 12 },
  foodCostBench: { color: '#9CA3AF', fontSize: 12 },
  extraGrid:     { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: 12, gap: 8, marginBottom: 24 },
  extraCard:     { alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, width: '30%' },
  extraIcon:     { fontSize: 24, marginBottom: 4 },
  extraLabel:    { color: '#D1D5DB', fontSize: 11, fontWeight: '600', textAlign: 'center' },
  saleRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' },
  saleAmount:   { color: '#10B981', fontSize: 16, fontWeight: '700' },
  saleType:     { color: '#9CA3AF', fontSize: 13 },
  saleDate:     { color: '#6B7280', fontSize: 12 },
});
