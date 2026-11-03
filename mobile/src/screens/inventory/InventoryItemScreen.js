import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, TextInput, Modal,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const TX_TYPES = [
  { key: 'purchase',   label: 'רכישה',  color: '#10B981', sign: +1 },
  { key: 'waste',      label: 'בזבוז',  color: '#EF4444', sign: -1 },
  { key: 'adjustment', label: 'תיקון',  color: '#F59E0B', sign: 0  },
  { key: 'sale',       label: 'מכירה',  color: '#6366F1', sign: -1 },
];

export default function InventoryItemScreen({ navigation, route }) {
  const { itemId } = route.params;
  const [item,       setItem]       = useState(null);
  const [txVisible,  setTxVisible]  = useState(false);
  const [txType,     setTxType]     = useState('purchase');
  const [qty,        setQty]        = useState('');
  const [note,       setNote]       = useState('');
  const [saving,     setSaving]     = useState(false);

  const load = async () => {
    try {
      const items = await api.getInventory({});
      const found = (Array.isArray(items) ? items : items?.items || []).find(i => i.id === itemId);
      if (found) setItem(found);
      else Alert.alert('שגיאה', 'פריט לא נמצא');
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    }
  };

  useEffect(() => { load(); }, [itemId]);

  const handleTransaction = async () => {
    if (!qty || isNaN(parseFloat(qty))) {
      Alert.alert('שגיאה', 'כמות לא חוקית');
      return;
    }
    setSaving(true);
    try {
      const txDef = TX_TYPES.find(t => t.key === txType);
      const sign  = txDef.sign !== 0 ? txDef.sign : parseFloat(qty) >= 0 ? 1 : -1;
      const qtyChange = Math.abs(parseFloat(qty)) * sign;

      await api.recordTransaction(itemId, { type: txType, qtyChange, note });
      setTxVisible(false);
      setQty(''); setNote('');
      await load();
      Alert.alert('✅ נרשם', 'תנועת מלאי נשמרה');
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setSaving(false); }
  };

  if (!item) return null;

  const isLow = item.min_qty > 0 && item.current_qty <= item.min_qty;

  return (
    <View style={s.container}>
      <ScreenHeader
        title={item.name}
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[s.mainCard, isLow && s.mainCardLow]}>
          <Text style={s.qtyBig}>{parseFloat(item.current_qty).toFixed(1)}</Text>
          <Text style={s.unit}>{item.unit}</Text>
          {isLow && <Text style={s.lowWarning}>⚠️ מתחת למינימום ({item.min_qty})</Text>}
        </View>

        <View style={s.detailsCard}>
          <View style={s.detailRow}>
            <Text style={s.detailVal}>₪{parseFloat(item.cost_per_unit).toFixed(2)}</Text>
            <Text style={s.detailLabel}>עלות ליחידה</Text>
          </View>
          <View style={s.detailRow}>
            <Text style={s.detailVal}>₪{(parseFloat(item.current_qty) * parseFloat(item.cost_per_unit)).toFixed(2)}</Text>
            <Text style={s.detailLabel}>שווי כולל</Text>
          </View>
          <View style={s.detailRow}>
            <Text style={s.detailVal}>{item.min_qty} {item.unit}</Text>
            <Text style={s.detailLabel}>מינימום</Text>
          </View>
          <View style={s.detailRow}>
            <Text style={s.detailVal}>{item.category || '—'}</Text>
            <Text style={s.detailLabel}>קטגוריה</Text>
          </View>
        </View>

        <TouchableOpacity style={s.txBtn} onPress={() => setTxVisible(true)}>
          <Text style={s.txBtnText}>+ רשום תנועת מלאי</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Modal תנועה */}
      <Modal visible={txVisible} animationType="slide" transparent>
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>תנועת מלאי</Text>

            <View style={s.typeRow}>
              {TX_TYPES.map(t => (
                <TouchableOpacity
                  key={t.key}
                  style={[s.typeBtn, txType === t.key && { backgroundColor: t.color + '33', borderColor: t.color }]}
                  onPress={() => setTxType(t.key)}
                >
                  <Text style={[s.typeBtnText, txType === t.key && { color: t.color }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={s.input}
              placeholder={`כמות (${item.unit})`}
              placeholderTextColor="#6B7280"
              value={qty}
              onChangeText={setQty}
              keyboardType="numeric"
              textAlign="right"
            />
            <TextInput
              style={s.input}
              placeholder="הערה (אופציונלי)"
              placeholderTextColor="#6B7280"
              value={note}
              onChangeText={setNote}
              textAlign="right"
            />

            <View style={s.modalActions}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setTxVisible(false)}>
                <Text style={s.cancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={handleTransaction} disabled={saving}>
                <Text style={s.saveText}>{saving ? 'שומר...' : 'שמור'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  back:         { color: '#6366F1', fontSize: 15 },
  mainCard:     { backgroundColor: '#1E1E2E', borderRadius: 20, padding: 32, alignItems: 'center', marginBottom: 16 },
  mainCardLow:  { borderWidth: 2, borderColor: '#EF4444' },
  qtyBig:       { color: '#F9FAFB', fontSize: 56, fontWeight: '700' },
  unit:         { color: '#9CA3AF', fontSize: 20, marginTop: 4 },
  lowWarning:   { color: '#F87171', fontSize: 14, marginTop: 12, fontWeight: '600' },
  detailsCard:  { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 16, marginBottom: 16 },
  detailRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#374151' },
  detailLabel:  { color: '#6B7280', fontSize: 14 },
  detailVal:    { color: '#F9FAFB', fontSize: 15, fontWeight: '600' },
  txBtn:        { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center' },
  txBtnText:    { color: '#fff', fontWeight: '700', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:        { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:   { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 20 },
  typeRow:      { flexDirection: 'row', gap: 8, marginBottom: 16 },
  typeBtn:      { flex: 1, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#374151', alignItems: 'center' },
  typeBtnText:  { color: '#9CA3AF', fontSize: 12, fontWeight: '600' },
  input:        { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 12, padding: 14, marginBottom: 12, fontSize: 15 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  cancelBtn:    { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: '#374151' },
  cancelText:   { color: '#9CA3AF', fontWeight: '600' },
  saveBtn:      { flex: 2, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  saveText:     { color: '#fff', fontWeight: '700', fontSize: 15 },
});
