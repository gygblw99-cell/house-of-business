import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function SupplierDetailScreen({ navigation, route }) {
  const { supplierId } = route.params;
  const [supplier, setSupplier] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getSupplier(supplierId)
      .then(data => { setSupplier(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [supplierId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <ActivityIndicator color="#6366F1" size="large" />
    </View>
  );

  if (error || !supplier) return (
    <View style={[s.container, { justifyContent: 'center', alignItems: 'center', padding: 32 }]}>
      <Text style={{ color: '#F87171', fontSize: 15, textAlign: 'center', marginBottom: 20 }}>
        {error || 'לא ניתן לטעון ספק'}
      </Text>
      <TouchableOpacity onPress={load} style={{ backgroundColor: '#6366F1', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 }}>
        <Text style={{ color: '#fff', fontWeight: '700' }}>נסה שנית</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.container}>
      <ScreenHeader
        title={supplier.name}
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.section}>
          <Text style={s.label}>קטגוריה</Text>
          <Text style={s.value}>{supplier.category || '—'}</Text>
        </View>
        <View style={s.section}>
          <Text style={s.label}>שיטת שליחה</Text>
          <Text style={s.value}>{supplier.send_method === 'email' ? 'מייל' : 'וואטסאפ'}</Text>
        </View>
        {supplier.email && (
          <View style={s.section}>
            <Text style={s.label}>מייל</Text>
            <Text style={s.value}>{supplier.email}</Text>
          </View>
        )}

        <Text style={s.sectionTitle}>אנשי קשר</Text>
        {supplier.contacts?.map((c, i) => (
          <View key={i} style={s.contactCard}>
            <Text style={s.contactName}>{c.name}</Text>
            <Text style={s.contactDetail}>{c.phone}</Text>
            {c.email && <Text style={s.contactDetail}>{c.email}</Text>}
            {c.is_primary && <Text style={s.primary}>ראשי</Text>}
          </View>
        ))}

        {supplier.price_history?.length > 0 && (
          <>
            <Text style={s.sectionTitle}>היסטוריית מחירים</Text>
            {supplier.price_history.slice(0, 5).map((p, i) => (
              <View key={i} style={s.priceRow}>
                <Text style={s.priceItem}>{p.item}</Text>
                <Text style={s.priceVal}>₪{parseFloat(p.unit_price).toFixed(2)}</Text>
                <Text style={s.priceDate}>{new Date(p.invoice_date).toLocaleDateString('he-IL')}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  back:         { color: '#6366F1', fontSize: 15 },
  section:      { marginBottom: 16 },
  label:        { color: '#6B7280', fontSize: 12, textAlign: 'right', marginBottom: 4 },
  value:        { color: '#F9FAFB', fontSize: 16, textAlign: 'right' },
  sectionTitle: { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 12, textAlign: 'right' },
  contactCard:  { backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, marginBottom: 8 },
  contactName:  { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  contactDetail:{ color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginTop: 4 },
  primary:      { color: '#6366F1', fontSize: 11, marginTop: 4, textAlign: 'right' },
  priceRow:     { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' },
  priceItem:    { color: '#D1D5DB', fontSize: 14, flex: 2, textAlign: 'right' },
  priceVal:     { color: '#10B981', fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'center' },
  priceDate:    { color: '#6B7280', fontSize: 12, flex: 1 },
});
