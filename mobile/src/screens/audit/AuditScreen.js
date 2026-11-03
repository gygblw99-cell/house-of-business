import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function AuditScreen({ navigation }) {
  const [audit,   setAudit]   = useState(null);
  const [score,   setScore]   = useState(null);
  const [running, setRunning] = useState(false);

  const load = async () => {
    try {
      const [a, s] = await Promise.all([api.getAuditLatest(), api.getAuditScore()]);
      setAudit(a);
      setScore(s);
    } catch (err) { Alert.alert('שגיאה', err.message); }
  };

  useEffect(() => { load(); }, []);

  const runAudit = async () => {
    setRunning(true);
    try {
      await api.runAudit();
      await load();
      Alert.alert('✅ ביקורת הושלמה', 'הניקוד עודכן');
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setRunning(false); }
  };

  const scoreColor = (s) => s >= 70 ? '#10B981' : s >= 50 ? '#F59E0B' : '#EF4444';

  return (
    <View style={s.container}>
      <ScreenHeader
        title="ביקורת עסקית"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {score && (
          <View style={s.scoreCard}>
            <Text style={s.scoreLabel}>ניקוד כולל</Text>
            <Text style={[s.scoreBig, { color: scoreColor(score.score) }]}>{score.score}</Text>
            <Text style={s.scoreMax}>/100</Text>
            <View style={s.scoreBar}>
              <View style={[s.scoreBarFill, {
                width: `${score.score}%`,
                backgroundColor: scoreColor(score.score),
              }]} />
            </View>
            <Text style={[s.scoreDirection, {
              color: score.direction === 'up' ? '#10B981' : score.direction === 'down' ? '#EF4444' : '#9CA3AF',
            }]}>
              {score.direction === 'up' ? '↑ עלייה' : score.direction === 'down' ? '↓ ירידה' : '→ יציב'} לעומת הביקורת הקודמת
            </Text>
          </View>
        )}

        {audit?.breakdown && (
          <>
            <Text style={s.sectionTitle}>פירוט ציונים</Text>
            {Object.entries(audit.breakdown).map(([key, val]) => {
              const labels = { profitability: 'רווחיות', inventory: 'מלאי', employees: 'עובדים', avgOrder: 'ממוצע הזמנה' };
              return (
                <View key={key} style={s.breakdownRow}>
                  <Text style={[s.breakdownScore, { color: scoreColor(val) }]}>{Math.round(val)}</Text>
                  <View style={s.breakdownBar}>
                    <View style={[s.breakdownFill, { width: `${val}%`, backgroundColor: scoreColor(val) }]} />
                  </View>
                  <Text style={s.breakdownLabel}>{labels[key] || key}</Text>
                </View>
              );
            })}
          </>
        )}

        {audit?.issues?.length > 0 && (
          <>
            <Text style={s.sectionTitle}>בעיות שזוהו</Text>
            {audit.issues.map((issue, i) => (
              <View key={i} style={s.issueCard}>
                <Text style={s.issueTitle}>{issue.title}</Text>
                <Text style={s.issueDesc}>{issue.description}</Text>
              </View>
            ))}
          </>
        )}

        {audit?.recommendations?.length > 0 && (
          <>
            <Text style={s.sectionTitle}>המלצות</Text>
            {audit.recommendations.map((rec, i) => (
              <View key={i} style={s.recCard}>
                <Text style={s.recIcon}>💡</Text>
                <Text style={s.recText}>{rec}</Text>
              </View>
            ))}
          </>
        )}

        <TouchableOpacity style={s.runBtn} onPress={runAudit} disabled={running}>
          {running
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.runBtnText}>הרץ ביקורת עכשיו</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0F0F1A' },
  back:           { color: '#6366F1', fontSize: 15 },
  scoreCard:      { backgroundColor: '#1E1E2E', borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 20 },
  scoreLabel:     { color: '#9CA3AF', fontSize: 13, marginBottom: 8 },
  scoreBig:       { fontSize: 72, fontWeight: '700' },
  scoreMax:       { color: '#6B7280', fontSize: 20, marginTop: -8 },
  scoreBar:       { height: 10, backgroundColor: '#374151', borderRadius: 5, overflow: 'hidden', width: '100%', marginTop: 16 },
  scoreBarFill:   { height: '100%', borderRadius: 5 },
  scoreDirection: { fontSize: 13, marginTop: 12 },
  sectionTitle:   { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginBottom: 12, textAlign: 'right' },
  breakdownRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  breakdownLabel: { color: '#D1D5DB', fontSize: 13, width: 80, textAlign: 'right' },
  breakdownBar:   { flex: 1, height: 6, backgroundColor: '#374151', borderRadius: 3, overflow: 'hidden' },
  breakdownFill:  { height: '100%', borderRadius: 3 },
  breakdownScore: { width: 32, fontSize: 14, fontWeight: '700', textAlign: 'right' },
  issueCard:      { backgroundColor: '#1F1515', borderRadius: 12, padding: 14, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: '#EF4444' },
  issueTitle:     { color: '#F87171', fontSize: 14, fontWeight: '700', textAlign: 'right', marginBottom: 4 },
  issueDesc:      { color: '#D1D5DB', fontSize: 13, textAlign: 'right', lineHeight: 18 },
  recCard:        { flexDirection: 'row', gap: 10, backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, marginBottom: 8, alignItems: 'flex-start' },
  recIcon:        { fontSize: 18 },
  recText:        { color: '#D1D5DB', fontSize: 13, flex: 1, textAlign: 'right', lineHeight: 18 },
  runBtn:         { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 16 },
  runBtnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
});
