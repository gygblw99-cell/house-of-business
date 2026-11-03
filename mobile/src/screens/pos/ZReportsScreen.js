import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

// GET /zreport/summary returns { ...aggregateFields, reports: [{ pos_sale_id,
// total_amount, sold_at, cash_amount, credit_amount, wolt_amount, ten_bis_amount }] }
// — there is no id/report_date/total_revenue/status/transaction_count/
// avg_transaction/cancellations/categories field anywhere on these rows, and
// no approve/status-mutation endpoint exists on the backend at all. This
// screen previously read fields that never existed (always showing blank
// dates and ₪0) and had a fake "approve" button that only mutated local
// state and never persisted anything — a false-success UI for a feature
// that doesn't exist server-side.

export default function ZReportsScreen({ navigation }) {
  const [reports,  setReports]  = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await api.getZReports();
      setReports(Array.isArray(summary?.reports) ? summary.reports : []);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (selected) {
    return (
      <View style={s.container}>
        <ScreenHeader
          title="דוח"
          left={<TouchableOpacity onPress={() => setSelected(null)}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        />
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {/* כותרת */}
          <View style={s.reportHeader}>
            <Text style={s.reportDate}>
              {selected.sold_at ? new Date(selected.sold_at).toLocaleDateString('he-IL') : '—'}
            </Text>
            <Text style={s.reportPos}>{selected.pos_sale_id}</Text>
          </View>

          {/* פירוט תשלומים */}
          <View style={s.salesGrid}>
            {[
              ['סה״כ',    `₪${parseFloat(selected.total_amount || 0).toLocaleString('he-IL')}`, '#10B981'],
              ['מזומן',   `₪${parseFloat(selected.cash_amount || 0).toLocaleString('he-IL')}`,   '#6366F1'],
              ['אשראי',   `₪${parseFloat(selected.credit_amount || 0).toLocaleString('he-IL')}`, '#F59E0B'],
              ['וולט/תן-ביס', `₪${(parseFloat(selected.wolt_amount || 0) + parseFloat(selected.ten_bis_amount || 0)).toLocaleString('he-IL')}`, '#8B5CF6'],
            ].map(([label, val, color]) => (
              <View key={label} style={s.salesCard}>
                <Text style={[s.salesVal, { color }]}>{val}</Text>
                <Text style={s.salesLabel}>{label}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }

  const totalRevenue = reports.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);

  return (
    <View style={s.container}>
      <ScreenHeader
        title="דוחות / מכירות"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      {/* סטטיסטיקה */}
      <View style={s.statsRow}>
        <View style={s.stat}>
          <Text style={[s.statVal, { color: '#10B981' }]}>₪{totalRevenue.toLocaleString('he-IL')}</Text>
          <Text style={s.statLabel}>סה״כ הכנסות</Text>
        </View>
        <View style={s.stat}>
          <Text style={s.statVal}>{reports.length}</Text>
          <Text style={s.statLabel}>דוחות</Text>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={reports}
          keyExtractor={r => r.pos_sale_id}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין דוחות</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.reportCard} onPress={() => setSelected(item)}>
              <View style={s.reportBody}>
                <Text style={s.reportCardDate}>
                  {item.sold_at ? new Date(item.sold_at).toLocaleDateString('he-IL') : '—'}
                </Text>
                <Text style={s.reportCardPos}>{item.pos_sale_id}</Text>
              </View>
              <Text style={[s.reportRevenue, { color: '#10B981' }]}>
                ₪{parseFloat(item.total_amount || 0).toLocaleString('he-IL')}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  back:            { color: '#6366F1', fontSize: 15 },
  statsRow:        { flexDirection: 'row', margin: 16, backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14 },
  stat:            { flex: 1, alignItems: 'center' },
  statVal:         { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  statLabel:       { color: '#6B7280', fontSize: 10, marginTop: 2, textAlign: 'center' },
  empty:           { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  reportCard:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12 },
  reportBody:      { flex: 1 },
  reportCardDate:  { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  reportCardPos:   { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 2 },
  reportRevenue:   { fontSize: 16, fontWeight: '700' },
  reportHeader:    { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 16, gap: 8 },
  reportDate:      { color: '#F9FAFB', fontSize: 20, fontWeight: '700' },
  reportPos:       { color: '#9CA3AF', fontSize: 14 },
  salesGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  salesCard:       { flex: 1, minWidth: '45%', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, alignItems: 'center' },
  salesVal:        { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  salesLabel:      { color: '#6B7280', fontSize: 12 },
});
