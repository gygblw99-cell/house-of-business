import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, Alert,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function ShiftsScreen({ navigation, route }) {
  const { employeeId, name } = route.params || {};
  const [summary, setSummary] = useState(null);
  const [expectedSalary, setExpectedSalary] = useState(null);
  const [loading, setLoading] = useState(false);

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const load = useCallback(async () => {
    if (!employeeId) return;
    setLoading(true);
    try {
      const data = await api.getMonthlySummary(employeeId, year, month);
      setSummary(data);
      // שכר צפוי — endpoint נפרד, לא נכשל את המסך אם אין הרשאה/שגיאה
      api.getExpectedSalary(employeeId)
        .then(res => setExpectedSalary(res))
        .catch(() => setExpectedSalary(null));
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  }, [employeeId, year, month]);

  useEffect(() => { load(); }, [load]);

  const shifts = summary?.shifts || [];
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  return (
    <View style={s.container}>
      <ScreenHeader
        title={name || 'משמרות'}
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      {summary && (
        <View style={s.summaryCard}>
          <Text style={s.summaryTitle}>{monthNames[month - 1]} {year}</Text>
          <View style={s.summaryRow}>
            <View style={s.summaryItem}>
              <Text style={s.summaryVal}>{parseFloat(summary.total_hours || 0).toFixed(1)}</Text>
              <Text style={s.summaryLabel}>שעות</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={s.summaryVal}>{shifts.length}</Text>
              <Text style={s.summaryLabel}>משמרות</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: '#10B981' }]}>₪{parseFloat(expectedSalary?.grossSalary || 0).toFixed(0)}</Text>
              <Text style={s.summaryLabel}>שכר צפוי</Text>
            </View>
          </View>
        </View>
      )}

      <FlatList
        data={shifts}
        keyExtractor={(_, i) => String(i)}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => {
          const start = item.start ? new Date(item.start) : null;
          const end   = item.end   ? new Date(item.end)   : null;
          const hours = start && end ? ((end - start) / 3_600_000).toFixed(1) : null;

          return (
            <View style={s.shiftCard}>
              <View style={s.shiftHeader}>
                <Text style={s.shiftDate}>{start ? start.toLocaleDateString('he-IL') : 'לא ידוע'}</Text>
                <View style={[s.shiftBadge, { backgroundColor: item.status === 'completed' ? '#064E3B' : item.status === 'active' ? '#1E3A5F' : '#4B1515' }]}>
                  <Text style={[s.shiftBadgeText, { color: item.status === 'completed' ? '#10B981' : item.status === 'active' ? '#60A5FA' : '#F87171' }]}>
                    {item.status === 'completed' ? 'הושלם' : item.status === 'active' ? 'פעיל' : item.status}
                  </Text>
                </View>
              </View>
              <View style={s.shiftTimes}>
                <Text style={s.shiftTime}>{start ? start.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '--'}</Text>
                <Text style={s.shiftArrow}>←</Text>
                <Text style={s.shiftTime}>{end ? end.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '---'}</Text>
                {hours && <Text style={s.shiftHours}>{hours} שעות</Text>}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין משמרות החודש</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0F0F1A' },
  back:           { color: '#6366F1', fontSize: 15 },
  summaryCard:    { margin: 16, backgroundColor: '#1E1E2E', borderRadius: 16, padding: 16 },
  summaryTitle:   { color: '#9CA3AF', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  summaryRow:     { flexDirection: 'row', justifyContent: 'space-around' },
  summaryItem:    { alignItems: 'center' },
  summaryVal:     { color: '#F9FAFB', fontSize: 22, fontWeight: '700' },
  summaryLabel:   { color: '#6B7280', fontSize: 12, marginTop: 4 },
  shiftCard:      { backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, marginBottom: 10 },
  shiftHeader:    { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  shiftDate:      { color: '#F9FAFB', fontSize: 14, fontWeight: '600' },
  shiftBadge:     { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 2 },
  shiftBadgeText: { fontSize: 11, fontWeight: '600' },
  shiftTimes:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shiftTime:      { color: '#D1D5DB', fontSize: 14 },
  shiftArrow:     { color: '#6B7280' },
  shiftHours:     { color: '#6366F1', fontSize: 13, fontWeight: '600', marginLeft: 8 },
  empty:          { color: '#6B7280', textAlign: 'center', marginTop: 40 },
});
