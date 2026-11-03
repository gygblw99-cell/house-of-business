import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, RefreshControl, TextInput, Linking,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function DailyOrdersScreen({ navigation }) {
  const [orders,  setOrders]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState({}); // supplierId → items[]

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDailyOrders();
      setOrders(data);
      // אתחול עריכה — backend מחזיר camelCase: supplierId, items[].qty / items[].suggested_qty
      const init = {};
      data.forEach(o => {
        init[o.supplierId] = (o.items || []).map((item, idx) => ({
          ...item,
          _idx: idx,
          qty: String(item.qty ?? item.suggested_qty ?? 0),
        }));
      });
      setEditing(init);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleConfirm = async (supplierId, supplierName) => {
    const items = editing[supplierId]?.filter(i => parseFloat(i.qty) > 0);
    if (!items?.length) {
      Alert.alert('שגיאה', 'אין פריטים להזמנה');
      return;
    }
    Alert.alert(`שלח הזמנה ל${supplierName}?`, `${items.length} פריטים`, [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'שלח',
        onPress: async () => {
          try {
            // backend מצפה ל: { name, qtyOrdered, unit, inventoryItemId? }
            const payload = items.map(i => ({
              name:           i.name,
              qtyOrdered:     parseFloat(i.qty),
              unit:           i.unit || '',
              inventoryItemId: i.inventoryItemId || null,
            }));
            const result = await api.confirmOrder(supplierId, payload);
            if (result.waLink) {
              Alert.alert('הזמנה מוכנה', 'לחץ שלח בוואטסאפ', [
                { text: 'פתח וואטסאפ', onPress: () => Linking.openURL(result.waLink) },
              ]);
            } else {
              Alert.alert('✅ הזמנה נשלחה', 'מייל נשלח לספק');
            }
            load();
          } catch (err) {
            Alert.alert('שגיאה', err.message);
          }
        },
      },
    ]);
  };

  const handleSkip = async (supplierId) => {
    try {
      await api.skipOrder(supplierId);
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
  };

  // עדכון כמות לפי index בתוך המערך
  const updateQty = (supplierId, idx, qty) => {
    setEditing(prev => ({
      ...prev,
      [supplierId]: prev[supplierId]?.map(i => i._idx === idx ? { ...i, qty } : i),
    }));
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="הזמנות יומיות"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <FlatList
        data={orders}
        keyExtractor={o => o.supplierId}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item: order }) => (
          <View style={s.card}>
            <View style={s.cardHeader}>
              <Text style={s.supplierName}>{order.supplierName}</Text>
              <Text style={s.orderMethod}>
                {order.preferredChannel === 'email' ? '📧' : '📱'}
              </Text>
            </View>

            {(editing[order.supplierId] || []).map(item => (
              <View key={item._idx} style={s.itemRow}>
                <TextInput
                  style={s.qtyInput}
                  value={String(item.qty)}
                  onChangeText={v => updateQty(order.supplierId, item._idx, v)}
                  keyboardType="numeric"
                />
                <Text style={s.itemName}>{item.name} ({item.unit || ''})</Text>
              </View>
            ))}

            {order.status && order.status !== 'pending' ? (
              <View style={s.statusBadge}>
                <Text style={s.statusText}>
                  {order.status === 'sent'      ? '✅ נשלח'
                   : order.status === 'skipped'  ? '⏭ דולג'
                   : order.status === 'confirmed' ? '✓ מאושר'
                   : order.status}
                </Text>
              </View>
            ) : (
              <View style={s.actions}>
                <TouchableOpacity
                  style={s.skipBtn}
                  onPress={() => handleSkip(order.supplierId)}
                >
                  <Text style={s.skipText}>דלג</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.confirmBtn}
                  onPress={() => handleConfirm(order.supplierId, order.supplierName)}
                >
                  <Text style={s.confirmText}>שלח הזמנה</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין הזמנות להיום</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  back:         { color: '#6366F1', fontSize: 15 },
  card:         { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 12 },
  cardHeader:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  supplierName: { color: '#F9FAFB', fontSize: 17, fontWeight: '700' },
  orderMethod:  { fontSize: 20 },
  itemRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  qtyInput:     { backgroundColor: '#374151', color: '#F9FAFB', borderRadius: 8, width: 60, padding: 8, textAlign: 'center', fontSize: 15 },
  itemName:     { color: '#D1D5DB', fontSize: 14, flex: 1, textAlign: 'right' },
  actions:      { flexDirection: 'row', gap: 10, marginTop: 12 },
  skipBtn:      { flex: 1, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#374151', alignItems: 'center' },
  skipText:     { color: '#9CA3AF', fontWeight: '600' },
  confirmBtn:   { flex: 2, backgroundColor: '#6366F1', borderRadius: 10, padding: 12, alignItems: 'center' },
  confirmText:  { color: '#fff', fontWeight: '700' },
  statusBadge:  { marginTop: 12, padding: 10, backgroundColor: '#374151', borderRadius: 8, alignItems: 'center' },
  statusText:   { color: '#9CA3AF', fontWeight: '600' },
  empty:        { color: '#6B7280', textAlign: 'center', marginTop: 40 },
});
