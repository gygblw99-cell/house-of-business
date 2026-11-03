import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, Alert, Modal, TextInput, ActivityIndicator,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const EXPENSE_CATS = ['שכר', 'ספקים', 'שכירות', 'ציוד', 'שיווק', 'אחר'];

export default function FinanceScreen({ navigation }) {
  const [daily,    setDaily]    = useState(null);
  const [monthly,  setMonthly]  = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [showAdd,  setShowAdd]  = useState(false);
  const [newDesc,  setNewDesc]  = useState('');
  const [newAmt,   setNewAmt]   = useState('');
  const [newCat,   setNewCat]   = useState('אחר');
  const [saving,   setSaving]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, m, exp] = await Promise.all([
        api.getDailyProfit(),
        api.getMonthlySummaryFinance(new Date().getFullYear(), new Date().getMonth() + 1),
        api.getExpenses({ limit: 10 }).catch(() => []),
      ]);
      setDaily(d);
      setMonthly(m);
      const arr = Array.isArray(exp) ? exp : (exp?.expenses || exp?.data || []);
      setExpenses(arr);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAddExpense = async () => {
    if (!newAmt || isNaN(parseFloat(newAmt))) { Alert.alert('שגיאה', 'הזן סכום תקין'); return; }
    setSaving(true);
    try {
      await api.createExpense({
        description: newDesc.trim() || newCat,
        amount: parseFloat(newAmt),
        category: newCat,
        date: new Date().toISOString().split('T')[0],
      });
      setShowAdd(false);
      setNewDesc(''); setNewAmt(''); setNewCat('אחר');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  const profitColor = (val) => parseFloat(val) >= 0 ? '#10B981' : '#EF4444';

  return (
    <View style={s.container}>
      <ScreenHeader
        title="כספים"
        right={
          <TouchableOpacity onPress={() => setShowAdd(true)}>
            <Text style={s.addBtn}>+ הוצאה</Text>
          </TouchableOpacity>
        }
      />

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
      >
        {/* רווח היום */}
        {daily && (
          <View style={s.card}>
            <Text style={s.cardTitle}>רווח היום</Text>
            <Text style={[s.bigNum, { color: profitColor(daily.profit) }]}>
              ₪{parseFloat(daily.profit).toFixed(2)}
            </Text>
            <View style={s.row}>
              <Text style={s.rowLabel}>הכנסות</Text>
              <Text style={s.rowVal}>₪{parseFloat(daily.revenue).toFixed(2)}</Text>
            </View>
            <View style={s.row}>
              <Text style={s.rowLabel}>עלות ספקים</Text>
              <Text style={[s.rowVal, { color: '#F87171' }]}>- ₪{parseFloat(daily.cost_of_goods).toFixed(2)}</Text>
            </View>
            <View style={s.row}>
              <Text style={s.rowLabel}>הוצאות קבועות</Text>
              <Text style={[s.rowVal, { color: '#F87171' }]}>- ₪{parseFloat(daily.expenses).toFixed(2)}</Text>
            </View>
            <View style={s.row}>
              <Text style={s.rowLabel}>שכר עובדים</Text>
              <Text style={[s.rowVal, { color: '#F87171' }]}>- ₪{parseFloat(daily.salary).toFixed(2)}</Text>
            </View>
            <View style={s.row}>
              <Text style={s.rowLabel}>בזבוז</Text>
              <Text style={[s.rowVal, { color: '#F87171' }]}>- ₪{parseFloat(daily.waste || 0).toFixed(2)}</Text>
            </View>
          </View>
        )}

        {/* סיכום חודשי */}
        {monthly && (
          <View style={s.card}>
            <Text style={s.cardTitle}>סיכום חודשי</Text>
            <Text style={[s.bigNum, { color: profitColor(monthly.netProfit) }]}>
              ₪{parseFloat(monthly.netProfit).toFixed(0)}
            </Text>
            <View style={s.row}>
              <Text style={s.rowLabel}>הכנסות</Text>
              <Text style={s.rowVal}>₪{parseFloat(monthly.revenue).toFixed(0)}</Text>
            </View>
            <View style={s.row}>
              <Text style={s.rowLabel}>רווח גולמי</Text>
              <Text style={[s.rowVal, { color: '#60A5FA' }]}>₪{parseFloat(monthly.grossProfit).toFixed(0)}</Text>
            </View>
            <View style={s.row}>
              <Text style={s.rowLabel}>מרווח נטו</Text>
              <Text style={[s.rowVal, { color: profitColor(monthly.netProfit) }]}>{monthly.margin}%</Text>
            </View>
          </View>
        )}

        {/* הוצאות אחרונות */}
        {expenses.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>הוצאות אחרונות</Text>
            {expenses.slice(0, 8).map((exp, i) => (
              <View key={exp.id || i} style={[s.row, i === 0 && { borderTopWidth: 0 }]}>
                <View style={s.expLeft}>
                  <Text style={s.expDesc}>{exp.description || exp.category}</Text>
                  <Text style={s.expDate}>
                    {exp.date ? new Date(exp.date).toLocaleDateString('he-IL') : ''}
                    {exp.category ? ` • ${exp.category}` : ''}
                  </Text>
                </View>
                <Text style={[s.rowVal, { color: '#F87171' }]}>- ₪{parseFloat(exp.amount).toFixed(0)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* כפתורי ניווט */}
        <View style={s.navRow}>
          <TouchableOpacity style={s.navBtn} onPress={() => navigation.navigate('Cashflow')}>
            <Text style={s.navIcon}>📈</Text>
            <Text style={s.navLabel}>תזרים מזומנים</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.navBtn} onPress={() => navigation.navigate('Forecast')}>
            <Text style={s.navIcon}>🔮</Text>
            <Text style={s.navLabel}>תחזית 30 יום</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>הוצאה חדשה</Text>

            <TextInput
              style={s.modalInput}
              value={newAmt}
              onChangeText={setNewAmt}
              placeholder="סכום (₪) *"
              placeholderTextColor="#6B7280"
              keyboardType="numeric"
              textAlign="right"
              autoFocus
            />
            <TextInput
              style={s.modalInput}
              value={newDesc}
              onChangeText={setNewDesc}
              placeholder="תיאור הוצאה"
              placeholderTextColor="#6B7280"
              textAlign="right"
            />

            <Text style={s.modalLabel}>קטגוריה</Text>
            <View style={s.catGrid}>
              {EXPENSE_CATS.map(c => (
                <TouchableOpacity
                  key={c}
                  style={[s.catBtn, newCat === c && s.catBtnActive]}
                  onPress={() => setNewCat(c)}
                >
                  <Text style={[s.catBtnText, newCat === c && { color: '#fff' }]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => { setShowAdd(false); setNewDesc(''); setNewAmt(''); setNewCat('אחר'); }}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAddExpense} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.modalSaveText}>הוסף</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  addBtn:          { color: '#10B981', fontWeight: '700', fontSize: 14 },
  card:            { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 18, marginBottom: 16 },
  cardTitle:       { color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginBottom: 8 },
  bigNum:          { fontSize: 36, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  row:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#374151' },
  rowLabel:        { color: '#6B7280', fontSize: 14 },
  rowVal:          { color: '#F9FAFB', fontSize: 14, fontWeight: '600' },
  expLeft:         { flex: 1 },
  expDesc:         { color: '#F9FAFB', fontSize: 14, textAlign: 'right' },
  expDate:         { color: '#6B7280', fontSize: 11, textAlign: 'right', marginTop: 2 },
  navRow:          { flexDirection: 'row', gap: 12 },
  navBtn:          { flex: 1, backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, alignItems: 'center' },
  navIcon:         { fontSize: 32, marginBottom: 8 },
  navLabel:        { color: '#F9FAFB', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  modalOverlay:    { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:           { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:      { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 14 },
  modalLabel:      { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginBottom: 8, marginTop: 4 },
  modalInput:      { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 12, fontSize: 14, borderWidth: 1, borderColor: '#374151', marginBottom: 10 },
  catGrid:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  catBtn:          { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#374151' },
  catBtnActive:    { backgroundColor: '#6366F1' },
  catBtnText:      { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  modalActions:    { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalCancel:     { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText: { color: '#9CA3AF', fontWeight: '600' },
  modalSave:       { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:   { color: '#fff', fontWeight: '700' },
});
