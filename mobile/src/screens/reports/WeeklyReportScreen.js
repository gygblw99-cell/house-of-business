import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, ScrollView,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function WeeklyReportScreen({ navigation }) {
  const [reports,  setReports]  = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getWeeklyReports();
      // Backend returns latest report or array of reports
      if (Array.isArray(data)) {
        setReports(data);
        if (data.length > 0 && !selected) setSelected(data[0]);
      } else if (data && (data.report_body || data.summary || data.recommendations)) {
        // Single report object
        const list = [data];
        setReports(list);
        if (!selected) setSelected(data);
      } else if (data?.reports) {
        setReports(data.reports);
        if (data.reports.length > 0 && !selected) setSelected(data.reports[0]);
      } else {
        setReports([]);
      }
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await api.generateWeeklyReport();
      Alert.alert('✅ הדוח נוצר', 'הדוח השבועי הופק בהצלחה');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setGenerating(false); }
  };

  if (selected) {
    return (
      <View style={s.container}>
        <ScreenHeader
          title="דוח שבועי"
          left={
            <TouchableOpacity onPress={() => setSelected(null)}>
              <Text style={s.back}>→ רשימה</Text>
            </TouchableOpacity>
          }
        />
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View style={s.reportHeader}>
            <Text style={s.reportWeek}>
              {selected.week_start
                ? `שבוע ${new Date(selected.week_start).toLocaleDateString('he-IL')} – ${new Date(selected.week_end || selected.week_start).toLocaleDateString('he-IL')}`
                : selected.period || 'דוח שבועי'}
            </Text>
            {selected.total_revenue && (
              <Text style={s.reportRevenue}>₪{parseFloat(selected.total_revenue).toLocaleString('he-IL')}</Text>
            )}
          </View>

          {selected.summary && (
            <>
              <Text style={s.sectionTitle}>סיכום</Text>
              <View style={s.textCard}>
                <Text style={s.reportText}>{selected.summary}</Text>
              </View>
            </>
          )}

          {selected.report_body && (
            <>
              <Text style={s.sectionTitle}>ניתוח מפורט</Text>
              <View style={s.textCard}>
                <Text style={s.reportText}>{selected.report_body}</Text>
              </View>
            </>
          )}

          {selected.recommendations?.length > 0 && (
            <>
              <Text style={s.sectionTitle}>המלצות אסטרטגיות</Text>
              {selected.recommendations.map((rec, i) => (
                <View key={i} style={s.recCard}>
                  <Text style={s.recNum}>{i + 1}</Text>
                  <View style={s.recBody}>
                    <Text style={s.recTitle}>{rec.title || rec}</Text>
                    {rec.action && <Text style={s.recAction}>{rec.action}</Text>}
                    {rec.expected_impact && (
                      <Text style={s.recImpact}>💰 {rec.expected_impact}</Text>
                    )}
                  </View>
                </View>
              ))}
            </>
          )}

          {selected.kpis && (
            <>
              <Text style={s.sectionTitle}>מדדי ביצוע</Text>
              <View style={s.kpisGrid}>
                {Object.entries(selected.kpis).map(([k, v]) => (
                  <View key={k} style={s.kpiCard}>
                    <Text style={s.kpiVal}>{typeof v === 'number' ? v.toLocaleString('he-IL') : String(v)}</Text>
                    <Text style={s.kpiLabel}>{k}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <ScreenHeader
        title="דוחות שבועיים"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <TouchableOpacity style={s.generateBtn} onPress={handleGenerate} disabled={generating}>
        {generating
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.generateBtnText}>⚡ הפק דוח עכשיו</Text>
        }
      </TouchableOpacity>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={reports}
          keyExtractor={r => String(r.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין דוחות עדיין</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.reportCard} onPress={() => setSelected(item)}>
              <View style={s.reportCardLeft}>
                <Text style={s.reportCardDate}>
                  {item.week_start
                    ? new Date(item.week_start).toLocaleDateString('he-IL')
                    : item.period || '—'}
                </Text>
                {item.total_revenue && (
                  <Text style={s.reportCardRevenue}>₪{parseFloat(item.total_revenue).toLocaleString('he-IL')}</Text>
                )}
              </View>
              <Text style={s.arrow}>←</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:         { flex: 1, backgroundColor: '#0F0F1A' },
  back:              { color: '#6366F1', fontSize: 15 },
  generateBtn:       { backgroundColor: '#6366F1', margin: 16, borderRadius: 14, padding: 14, alignItems: 'center' },
  generateBtnText:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  empty:             { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  reportCard:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16 },
  reportCardLeft:    { flex: 1 },
  reportCardDate:    { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  reportCardRevenue: { color: '#10B981', fontSize: 18, fontWeight: '700', textAlign: 'right', marginTop: 4 },
  arrow:             { color: '#374151', fontSize: 18 },
  reportHeader:      { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 20 },
  reportWeek:        { color: '#9CA3AF', fontSize: 13, marginBottom: 8 },
  reportRevenue:     { color: '#10B981', fontSize: 32, fontWeight: '700' },
  sectionTitle:      { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginBottom: 10, marginTop: 16, textAlign: 'right' },
  textCard:          { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16 },
  reportText:        { color: '#D1D5DB', fontSize: 14, lineHeight: 22, textAlign: 'right' },
  recCard:           { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, marginBottom: 8, gap: 12 },
  recNum:            { color: '#6366F1', fontSize: 20, fontWeight: '700', width: 28 },
  recBody:           { flex: 1 },
  recTitle:          { color: '#F9FAFB', fontSize: 14, fontWeight: '700', textAlign: 'right' },
  recAction:         { color: '#D1D5DB', fontSize: 13, textAlign: 'right', marginTop: 4 },
  recImpact:         { color: '#10B981', fontSize: 12, textAlign: 'right', marginTop: 4 },
  kpisGrid:          { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpiCard:           { flex: 1, minWidth: '45%', backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, alignItems: 'center' },
  kpiVal:            { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  kpiLabel:          { color: '#6B7280', fontSize: 11, marginTop: 4, textAlign: 'center' },
});
