import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, Alert,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const STATUS_LABELS = { pending:'ממתין', approved:'אושר', paid:'שולם', manual_required:'ידני' };
const STATUS_COLORS = { pending:'#F59E0B', approved:'#6366F1', paid:'#10B981', manual_required:'#EF4444' };

export default function InvoicesScreen({ navigation }) {
  const [invoices, setInvoices] = useState([]);
  const [search,   setSearch]   = useState('');
  const [loading,  setLoading]  = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getInvoices();
      setInvoices(data);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSearch = async (text) => {
    setSearch(text);
    if (text.length < 2) { load(); return; }
    try {
      const data = await api.searchInvoices(text);
      setInvoices(data);
    } catch { /* silent */ }
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="חשבוניות"
        right={
          <TouchableOpacity onPress={() => navigation.navigate('InvoiceScan')}>
            <Text style={s.scanBtn}>📷 סרוק</Text>
          </TouchableOpacity>
        }
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <TextInput
        style={s.search}
        placeholder="חיפוש חשבונית..."
        placeholderTextColor="#6B7280"
        value={search}
        onChangeText={handleSearch}
        textAlign="right"
      />

      <FlatList
        data={invoices}
        keyExtractor={i => i.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.card}
            onPress={() => navigation.navigate('InvoiceDetail', { invoiceId: item.id })}
          >
            <View style={s.cardTop}>
              <Text style={s.amount}>₪{parseFloat(item.total_amount).toFixed(2)}</Text>
              <View style={[s.statusBadge, { backgroundColor: STATUS_COLORS[item.status] + '22' }]}>
                <Text style={[s.statusText, { color: STATUS_COLORS[item.status] }]}>
                  {STATUS_LABELS[item.status] || item.status}
                </Text>
              </View>
            </View>
            <Text style={s.supplier}>{item.supplier_name || 'ספק לא מזוהה'}</Text>
            <View style={s.cardBottom}>
              <Text style={s.date}>{new Date(item.invoice_date).toLocaleDateString('he-IL')}</Text>
              {item.invoice_number && <Text style={s.number}>#{item.invoice_number}</Text>}
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין חשבוניות</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0F0F1A' },
  back:        { color: '#6366F1', fontSize: 15 },
  scanBtn:     { color: '#6366F1', fontWeight: '600', fontSize: 15 },
  search:      { margin: 16, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 15 },
  card:        { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 10 },
  cardTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  amount:      { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  statusBadge: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  statusText:  { fontSize: 12, fontWeight: '600' },
  supplier:    { color: '#9CA3AF', fontSize: 14, textAlign: 'right', marginBottom: 6 },
  cardBottom:  { flexDirection: 'row', justifyContent: 'space-between' },
  date:        { color: '#6B7280', fontSize: 12 },
  number:      { color: '#6B7280', fontSize: 12 },
  empty:       { color: '#6B7280', textAlign: 'center', marginTop: 40 },
});
