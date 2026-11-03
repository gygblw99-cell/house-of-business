import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, Alert, TouchableOpacity } from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function WasteScreen({ navigation }) {
  const [waste,   setWaste]   = useState([]);
  const [days,    setDays]    = useState(7);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getWaste(days)
      .then(setWaste)
      .catch(err => Alert.alert('שגיאה', err.message))
      .finally(() => setLoading(false));
  }, [days]);

  const totalLoss = waste.reduce((s, w) => s + parseFloat(w.estimated_loss || 0), 0);

  return (
    <View style={s.container}>
      <ScreenHeader
        title="בזבוז מלאי"
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

      {totalLoss > 0 && (
        <View style={s.totalCard}>
          <Text style={s.totalLabel}>סה״כ הפסד</Text>
          <Text style={s.totalVal}>₪{totalLoss.toFixed(2)}</Text>
        </View>
      )}

      <FlatList
        data={waste}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <View style={s.row}>
            <View>
              <Text style={s.itemName}>{item.name}</Text>
              <Text style={s.itemQty}>{parseFloat(item.total_qty_wasted).toFixed(1)} {item.unit} • {item.incidents} אירועים</Text>
            </View>
            <Text style={s.loss}>₪{parseFloat(item.estimated_loss).toFixed(2)}</Text>
          </View>
        )}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין בזבוז מדווח</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0F0F1A' },
  back:           { color: '#6366F1', fontSize: 15 },
  filterRow:      { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 12 },
  dayBtn:         { flex: 1, backgroundColor: '#1E1E2E', borderRadius: 10, padding: 10, alignItems: 'center' },
  dayBtnActive:   { backgroundColor: '#F59E0B' },
  dayBtnText:     { color: '#9CA3AF', fontSize: 13 },
  dayBtnTextActive:{ color: '#fff', fontWeight: '600' },
  totalCard:      { marginHorizontal: 16, backgroundColor: '#7C2D12', borderRadius: 14, padding: 16, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  totalLabel:     { color: '#FCA5A5', fontSize: 14 },
  totalVal:       { color: '#fff', fontSize: 20, fontWeight: '700' },
  row:            { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, marginBottom: 8 },
  itemName:       { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  itemQty:        { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 4 },
  loss:           { color: '#F87171', fontSize: 16, fontWeight: '700' },
  empty:          { color: '#6B7280', textAlign: 'center', marginTop: 40 },
});
