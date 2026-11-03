import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const DAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export default function ForecastScreen({ navigation }) {
  const [forecast, setForecast] = useState(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    api.getForecast()
      .then(setForecast)
      .catch(err => Alert.alert('שגיאה', err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <ActivityIndicator color="#6366F1" style={{ flex: 1, backgroundColor: '#0F0F1A' }} />;
  if (!forecast) return null;

  const { summary, forecast: days } = forecast;

  return (
    <View style={s.container}>
      <ScreenHeader
        title="תחזית 30 יום"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.summaryCard}>
          <View style={s.summaryItem}>
            <Text style={s.summaryVal}>₪{parseFloat(summary.forecastMonthRevenue).toFixed(0)}</Text>
            <Text style={s.summaryLabel}>הכנסות צפויות</Text>
          </View>
          <View style={s.summaryItem}>
            <Text style={[s.summaryVal, { color: summary.forecastMonthProfit >= 0 ? '#10B981' : '#EF4444' }]}>
              ₪{parseFloat(summary.forecastMonthProfit).toFixed(0)}
            </Text>
            <Text style={s.summaryLabel}>רווח צפוי</Text>
          </View>
          <View style={s.summaryItem}>
            <Text style={s.summaryVal}>₪{parseFloat(summary.fixedExpenses).toFixed(0)}</Text>
            <Text style={s.summaryLabel}>הוצאות קבועות</Text>
          </View>
        </View>

        <Text style={s.sectionTitle}>30 הימים הקרובים</Text>
        {days.map((d, i) => (
          <View key={i} style={s.dayRow}>
            <Text style={[s.dayProfit, { color: d.forecastProfit >= 0 ? '#10B981' : '#EF4444' }]}>
              ₪{parseFloat(d.forecastProfit).toFixed(0)}
            </Text>
            <Text style={s.dayRevenue}>₪{parseFloat(d.forecastRevenue).toFixed(0)}</Text>
            <View style={s.dayLeft}>
              <Text style={s.dayName}>{DAY_NAMES[d.dow]}</Text>
              <Text style={s.dayDate}>{new Date(d.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  back:         { color: '#6366F1', fontSize: 15 },
  summaryCard:  { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, marginBottom: 20 },
  summaryItem:  { flex: 1, alignItems: 'center' },
  summaryVal:   { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  summaryLabel: { color: '#6B7280', fontSize: 11, marginTop: 4, textAlign: 'center' },
  sectionTitle: { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginBottom: 12, textAlign: 'right' },
  dayRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' },
  dayLeft:      { flex: 2, alignItems: 'flex-end' },
  dayName:      { color: '#F9FAFB', fontSize: 15, fontWeight: '600' },
  dayDate:      { color: '#6B7280', fontSize: 11, marginTop: 2 },
  dayRevenue:   { color: '#D1D5DB', fontSize: 13, flex: 1, textAlign: 'center' },
  dayProfit:    { fontSize: 14, fontWeight: '700', flex: 1 },
});
