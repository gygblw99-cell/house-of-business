import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const QUADRANTS = {
  star:       { label: '⭐ כוכב',      color: '#10B981', bg: '#10B98122', desc: 'פופולרי ורווחי — שמור ושפר' },
  plowhorse:  { label: '🐴 פרה חולבת', color: '#F59E0B', bg: '#F59E0B22', desc: 'פופולרי אך לא רווחי — שקול העלאת מחיר' },
  puzzle:     { label: '❓ חידה',      color: '#6366F1', bg: '#6366F122', desc: 'רווחי אך לא פופולרי — שפר שיווק' },
  dog:        { label: '🐕 כלב',       color: '#EF4444', bg: '#EF444422', desc: 'לא פופולרי ולא רווחי — שקול הסרה' },
};

export default function MenuEngineeringScreen({ navigation }) {
  const [analysis, setAnalysis]  = useState(null);
  const [actions,  setActions]   = useState([]);
  const [loading,  setLoading]   = useState(true);
  const [filter,   setFilter]    = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const a = await api.getMenuAnalysis();
      setAnalysis(a);
      // extract top actions from analysis response
      const actList = a?.top_actions || a?.actions || a?.recommendations || [];
      setActions(Array.isArray(actList) ? actList : []);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const items = analysis?.items || analysis?.dishes || analysis?.menu || [];
  const filtered = filter === 'all' ? items : items.filter(i => i.quadrant === filter);

  const summary = {
    star:      items.filter(i => i.quadrant === 'star').length,
    plowhorse: items.filter(i => i.quadrant === 'plowhorse').length,
    puzzle:    items.filter(i => i.quadrant === 'puzzle').length,
    dog:       items.filter(i => i.quadrant === 'dog').length,
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="הנדסת תפריט"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item, i) => String(item.id || i)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListHeaderComponent={
            <>
              {/* Quadrant Summary */}
              <View style={s.quadrantGrid}>
                {Object.entries(QUADRANTS).map(([key, q]) => (
                  <TouchableOpacity
                    key={key}
                    style={[s.quadrantCard, { backgroundColor: q.bg, borderColor: q.color }, filter === key && { borderWidth: 2 }]}
                    onPress={() => setFilter(filter === key ? 'all' : key)}
                  >
                    <Text style={s.quadrantLabel}>{q.label}</Text>
                    <Text style={[s.quadrantCount, { color: q.color }]}>{summary[key]}</Text>
                    <Text style={s.quadrantDesc}>{q.desc}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Top Actions from AI */}
              {actions.length > 0 && (
                <>
                  <Text style={s.sectionTitle}>💡 המלצות מובילות</Text>
                  {actions.slice(0, 3).map((a, i) => (
                    <View key={i} style={s.actionCard}>
                      <View style={s.actionNum}><Text style={s.actionNumText}>{i + 1}</Text></View>
                      <View style={s.actionBody}>
                        <Text style={s.actionTitle}>{a.title || a.action || String(a)}</Text>
                        {a.impact && <Text style={s.actionImpact}>💰 {a.impact}</Text>}
                      </View>
                    </View>
                  ))}
                </>
              )}

              {/* Summary stats */}
              {analysis?.avg_food_cost != null && (
                <View style={s.statsRow}>
                  <View style={s.stat}>
                    <Text style={[s.statVal, { color: analysis.avg_food_cost > 35 ? '#EF4444' : '#10B981' }]}>
                      {parseFloat(analysis.avg_food_cost).toFixed(1)}%
                    </Text>
                    <Text style={s.statLabel}>ממוצע Food Cost</Text>
                  </View>
                  {analysis?.avg_margin != null && (
                    <View style={s.stat}>
                      <Text style={s.statVal}>{parseFloat(analysis.avg_margin).toFixed(1)}%</Text>
                      <Text style={s.statLabel}>ממוצע מרווח</Text>
                    </View>
                  )}
                  <View style={s.stat}>
                    <Text style={s.statVal}>{items.length}</Text>
                    <Text style={s.statLabel}>מנות בניתוח</Text>
                  </View>
                </View>
              )}

              {items.length > 0 && (
                <>
                  <View style={s.filterRow}>
                    <TouchableOpacity style={[s.filterBtn, filter === 'all' && s.filterActive]} onPress={() => setFilter('all')}>
                      <Text style={[s.filterText, filter === 'all' && s.filterTextActive]}>הכל</Text>
                    </TouchableOpacity>
                    {Object.entries(QUADRANTS).map(([key, q]) => (
                      <TouchableOpacity
                        key={key}
                        style={[s.filterBtn, filter === key && { backgroundColor: q.color }]}
                        onPress={() => setFilter(filter === key ? 'all' : key)}
                      >
                        <Text style={[s.filterText, filter === key && { color: '#fff' }]}>{q.label.split(' ')[0]}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.sectionTitle}>מנות ({filtered.length})</Text>
                </>
              )}
            </>
          }
          ListEmptyComponent={
            items.length === 0
              ? <Text style={s.empty}>אין נתוני תפריט. הוסף מנות ומתכונים תחילה.</Text>
              : <Text style={s.empty}>אין מנות בקטגוריה זו</Text>
          }
          renderItem={({ item }) => {
            const q = QUADRANTS[item.quadrant];
            const margin = item.margin_pct || item.margin || 0;
            const marginColor = margin >= 60 ? '#10B981' : margin >= 30 ? '#F59E0B' : '#EF4444';
            return (
              <View style={[s.dishCard, q && { borderLeftColor: q.color, borderLeftWidth: 3 }]}>
                <View style={s.dishTop}>
                  <Text style={s.dishName}>{item.name || item.dish_name}</Text>
                  {q && (
                    <View style={[s.qBadge, { backgroundColor: q.bg }]}>
                      <Text style={[s.qBadgeText, { color: q.color }]}>{q.label}</Text>
                    </View>
                  )}
                </View>
                <View style={s.dishStats}>
                  <Text style={s.dishStat}>₪{parseFloat(item.selling_price || item.price || 0).toFixed(0)} מחיר</Text>
                  <Text style={s.dishStat}>
                    <Text style={{ color: marginColor }}>{parseFloat(margin).toFixed(1)}%</Text> מרווח
                  </Text>
                  {item.popularity != null && (
                    <Text style={s.dishStat}>🔥 {parseFloat(item.popularity).toFixed(0)} הזמנות</Text>
                  )}
                </View>
                {item.suggestion && (
                  <Text style={s.dishSuggestion}>💡 {item.suggestion}</Text>
                )}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#0F0F1A' },
  back:             { color: '#6366F1', fontSize: 15 },
  quadrantGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  quadrantCard:     { width: '47%', borderRadius: 14, padding: 14, borderWidth: 1 },
  quadrantLabel:    { color: '#F9FAFB', fontSize: 13, fontWeight: '700', textAlign: 'right', marginBottom: 4 },
  quadrantCount:    { fontSize: 28, fontWeight: '700', textAlign: 'right' },
  quadrantDesc:     { color: '#9CA3AF', fontSize: 11, textAlign: 'right', marginTop: 4, lineHeight: 16 },
  sectionTitle:     { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginBottom: 10, textAlign: 'right' },
  actionCard:       { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, marginBottom: 8, gap: 12, alignItems: 'flex-start' },
  actionNum:        { width: 28, height: 28, borderRadius: 14, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center' },
  actionNumText:    { color: '#fff', fontSize: 13, fontWeight: '700' },
  actionBody:       { flex: 1 },
  actionTitle:      { color: '#F9FAFB', fontSize: 14, fontWeight: '600', textAlign: 'right' },
  actionImpact:     { color: '#10B981', fontSize: 12, textAlign: 'right', marginTop: 4 },
  statsRow:         { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, marginBottom: 16 },
  stat:             { flex: 1, alignItems: 'center' },
  statVal:          { color: '#F9FAFB', fontSize: 20, fontWeight: '700' },
  statLabel:        { color: '#6B7280', fontSize: 10, marginTop: 2, textAlign: 'center' },
  filterRow:        { flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  filterBtn:        { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#1E1E2E' },
  filterActive:     { backgroundColor: '#6366F1' },
  filterText:       { color: '#9CA3AF', fontSize: 12, fontWeight: '600' },
  filterTextActive: { color: '#fff' },
  empty:            { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  dishCard:         { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14 },
  dishTop:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  dishName:         { color: '#F9FAFB', fontSize: 15, fontWeight: '600', flex: 1, textAlign: 'right' },
  qBadge:           { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginLeft: 8 },
  qBadgeText:       { fontSize: 11, fontWeight: '700' },
  dishStats:        { flexDirection: 'row', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' },
  dishStat:         { color: '#9CA3AF', fontSize: 12 },
  dishSuggestion:   { color: '#D1D5DB', fontSize: 12, textAlign: 'right', marginTop: 8, borderTopWidth: 1, borderTopColor: '#374151', paddingTop: 8 },
});
