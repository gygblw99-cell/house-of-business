import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, Alert,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const W = Dimensions.get('window').width;

export default function CashflowScreen({ navigation }) {
  const [data, setData] = useState([]);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getCashflow(days)
      .then(setData)
      .catch(err => Alert.alert('שגיאה', err.message))
      .finally(() => setLoading(false));
  }, [days]);

  const maxRevenue = Math.max(...data.map(d => d.revenue), 1);

  return (
    <View style={s.container}>
      <ScreenHeader
        title="תזרים מזומנים"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <View style={s.filterRow}>
        {[7, 14, 30].map(d => (
          <TouchableOpacity
            key={d}
            style={[s.dayBtn, days === d && s.dayBtnActive]}
            onPress={() => setDays(d)}
          >
            <Text style={[s.dayBtnText, days === d && s.dayBtnTextActive]}>{d} ימים</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* גרף פשוט */}
        <View style={s.chart}>
          {data.map((d, i) => (
            <View key={i} style={s.barWrap}>
              <View style={s.barContainer}>
                <View style={[s.bar, {
                  height: Math.max((d.revenue / maxRevenue) * 120, 4),
                  backgroundColor: d.estimatedProfit >= 0 ? '#6366F1' : '#EF4444',
                }]} />
              </View>
              <Text style={s.barLabel}>
                {new Date(d.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
              </Text>
            </View>
          ))}
        </View>

        {/* טבלה */}
        {data.slice().reverse().map((d, i) => (
          <View key={i} style={s.row}>
            <Text style={[s.profit, { color: d.estimatedProfit >= 0 ? '#10B981' : '#EF4444' }]}>
              ₪{parseFloat(d.estimatedProfit).toFixed(0)}
            </Text>
            <Text style={s.revenue}>₪{parseFloat(d.revenue).toFixed(0)}</Text>
            <Text style={s.date}>
              {new Date(d.date).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' })}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  back:            { color: '#6366F1', fontSize: 15 },
  filterRow:       { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 8 },
  dayBtn:          { flex: 1, backgroundColor: '#1E1E2E', borderRadius: 10, padding: 10, alignItems: 'center' },
  dayBtnActive:    { backgroundColor: '#6366F1' },
  dayBtnText:      { color: '#9CA3AF', fontSize: 13 },
  dayBtnTextActive:{ color: '#fff', fontWeight: '600' },
  chart:           { flexDirection: 'row', alignItems: 'flex-end', height: 140, backgroundColor: '#1E1E2E', borderRadius: 16, padding: 12, marginBottom: 20, gap: 4 },
  barWrap:         { flex: 1, alignItems: 'center' },
  barContainer:    { flex: 1, justifyContent: 'flex-end', width: '100%', alignItems: 'center' },
  bar:             { width: '80%', borderRadius: 3 },
  barLabel:        { color: '#6B7280', fontSize: 8, marginTop: 4, textAlign: 'center' },
  row:             { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' },
  date:            { color: '#9CA3AF', fontSize: 13, flex: 2, textAlign: 'right' },
  revenue:         { color: '#D1D5DB', fontSize: 13, flex: 1, textAlign: 'center' },
  profit:          { fontSize: 14, fontWeight: '700', flex: 1 },
});
