import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function InvoiceDetailScreen({ navigation, route }) {
  const { invoiceId } = route.params;
  const [invoice, setInvoice] = useState(null);

  useEffect(() => {
    api.getInvoice(invoiceId)
      .then(setInvoice)
      .catch(err => Alert.alert('שגיאה', err.message));
  }, [invoiceId]);

  if (!invoice) return null;

  return (
    <View style={s.container}>
      <ScreenHeader
        title="פרטי חשבונית"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.headerCard}>
          <Text style={s.amount}>₪{(parseFloat(invoice.total_amount) || 0).toFixed(2)}</Text>
          <Text style={s.supplier}>{invoice.supplier_name || 'ספק לא מזוהה'}</Text>
          <Text style={s.date}>{new Date(invoice.invoice_date).toLocaleDateString('he-IL')}</Text>
          {invoice.invoice_number && <Text style={s.number}>חשבונית #{invoice.invoice_number}</Text>}
        </View>

        {invoice.items?.length > 0 && (
          <>
            <Text style={s.sectionTitle}>פריטים</Text>
            {invoice.items.map((item, i) => (
              <View key={i} style={s.itemRow}>
                <Text style={s.itemPrice}>₪{parseFloat(item.unit_price * item.qty).toFixed(2)}</Text>
                <View style={s.itemMid}>
                  <Text style={s.itemName}>{item.description || item.inventory_item_name || 'פריט'}</Text>
                  <Text style={s.itemQty}>{item.qty} × ₪{parseFloat(item.unit_price).toFixed(2)}</Text>
                </View>
              </View>
            ))}
          </>
        )}

        {invoice.notes && (
          <View style={s.notes}>
            <Text style={s.notesLabel}>הערות</Text>
            <Text style={s.notesText}>{invoice.notes}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  back:         { color: '#6366F1', fontSize: 15 },
  headerCard:   { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 20 },
  amount:       { color: '#F9FAFB', fontSize: 32, fontWeight: '700' },
  supplier:     { color: '#9CA3AF', fontSize: 16, marginTop: 8 },
  date:         { color: '#6B7280', fontSize: 14, marginTop: 4 },
  number:       { color: '#6366F1', fontSize: 13, marginTop: 4 },
  sectionTitle: { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginBottom: 12, textAlign: 'right' },
  itemRow:      { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#1E1E2E', borderRadius: 10, padding: 12, marginBottom: 8 },
  itemMid:      { flex: 1, marginRight: 12 },
  itemName:     { color: '#F9FAFB', fontSize: 14, textAlign: 'right' },
  itemQty:      { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 4 },
  itemPrice:    { color: '#10B981', fontSize: 15, fontWeight: '600' },
  notes:        { backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, marginTop: 8 },
  notesLabel:   { color: '#6B7280', fontSize: 12, textAlign: 'right', marginBottom: 6 },
  notesText:    { color: '#D1D5DB', fontSize: 14, textAlign: 'right' },
});
