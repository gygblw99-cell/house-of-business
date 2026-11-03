import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, Modal, ScrollView,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

export default function PayrollScreen({ navigation }) {
  const now = new Date();
  const [month,     setMonth]     = useState(now.getMonth() + 1);
  const [year,      setYear]      = useState(now.getFullYear());
  const [payslips,  setPayslips]  = useState([]);
  const [summary,   setSummary]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selected,  setSelected]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([
        api.getPayslips({ month, year }),
        api.getPayrollSummary(month, year),
      ]);
      setPayslips(Array.isArray(p) ? p : (p.payslips || []));
      setSummary(s);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, [month, year]);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await api.generatePayslips(month, year);
      Alert.alert('✅ תלושים הופקו', `תלושי שכר ל${MONTHS[month-1]} ${year} הופקו`);
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setGenerating(false); }
  };

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="שכר ותלושים"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      {/* בחירת חודש */}
      <View style={s.monthNav}>
        <TouchableOpacity onPress={nextMonth}><Text style={s.navArrow}>›</Text></TouchableOpacity>
        <Text style={s.monthLabel}>{MONTHS[month-1]} {year}</Text>
        <TouchableOpacity onPress={prevMonth}><Text style={s.navArrow}>‹</Text></TouchableOpacity>
      </View>

      {/* סיכום חודשי */}
      {summary && (
        <View style={s.summaryCard}>
          <View style={s.summaryRow}>
            <View style={s.summaryItem}>
              <Text style={s.summaryVal}>₪{parseFloat(summary.total_gross || 0).toLocaleString('he-IL')}</Text>
              <Text style={s.summaryLabel}>ברוטו סה"כ</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: '#EF4444' }]}>₪{parseFloat(summary.total_deductions || 0).toLocaleString('he-IL')}</Text>
              <Text style={s.summaryLabel}>ניכויים</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: '#10B981' }]}>₪{parseFloat(summary.total_net || 0).toLocaleString('he-IL')}</Text>
              <Text style={s.summaryLabel}>נטו סה"כ</Text>
            </View>
          </View>
          <Text style={s.summaryCount}>{summary.employee_count || payslips.length} עובדים</Text>
        </View>
      )}

      {/* כפתור הפקת תלושים */}
      <TouchableOpacity style={s.generateBtn} onPress={handleGenerate} disabled={generating || loading}>
        {generating
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.generateBtnText}>⚡ הפק תלושי שכר</Text>
        }
      </TouchableOpacity>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={payslips}
          keyExtractor={p => String(p.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין תלושי שכר לחודש זה</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.payslipCard} onPress={() => setSelected(item)}>
              <View style={s.avatar}>
                <Text style={s.avatarText}>{(item.employee_name || '?').charAt(0)}</Text>
              </View>
              <View style={s.payslipBody}>
                <Text style={s.empName}>{item.employee_name || '—'}</Text>
                <Text style={s.empRole}>{item.role || item.position || ''}</Text>
              </View>
              <View style={s.payslipRight}>
                <Text style={[s.netPay, { color: '#10B981' }]}>₪{parseFloat(item.net_salary || item.net || 0).toLocaleString('he-IL')}</Text>
                <Text style={s.grossPay}>ברוטו ₪{parseFloat(item.gross_salary || item.gross || 0).toLocaleString('he-IL')}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Modal פרטי תלוש */}
      <Modal visible={!!selected} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>{selected?.employee_name} — {MONTHS[(selected?.month || month) - 1]} {selected?.year || year}</Text>
            <ScrollView style={{ maxHeight: 400 }}>
              {[
                ['שכר בסיס', selected?.base_salary],
                ['שעות נוספות', selected?.overtime_pay],
                ['בונוס', selected?.bonus],
                ['ברוטו', selected?.gross_salary || selected?.gross],
                ['ביטוח לאומי (עובד)', selected?.bituach_leumi_employee],
                ['מס הכנסה', selected?.income_tax],
                ['ניכויים סה"כ', selected?.total_deductions],
                ['נטו לתשלום', selected?.net_salary || selected?.net],
              ].filter(([, v]) => v != null).map(([label, val]) => (
                <View key={label} style={s.detailRow}>
                  <Text style={[s.detailVal, label.includes('נטו') && { color: '#10B981', fontWeight: '700' }]}>
                    ₪{parseFloat(val || 0).toLocaleString('he-IL')}
                  </Text>
                  <Text style={s.detailLabel}>{label}</Text>
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.closeBtn} onPress={() => setSelected(null)}>
              <Text style={s.closeBtnText}>סגור</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  back:            { color: '#6366F1', fontSize: 15 },
  monthNav:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 16, marginBottom: 8 },
  navArrow:        { color: '#6366F1', fontSize: 28, fontWeight: '700', paddingHorizontal: 10 },
  monthLabel:      { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  summaryCard:     { margin: 16, backgroundColor: '#1E1E2E', borderRadius: 16, padding: 16 },
  summaryRow:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  summaryItem:     { alignItems: 'center' },
  summaryVal:      { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  summaryLabel:    { color: '#6B7280', fontSize: 10, marginTop: 2 },
  summaryCount:    { color: '#9CA3AF', fontSize: 12, textAlign: 'center' },
  generateBtn:     { backgroundColor: '#6366F1', borderRadius: 14, padding: 14, alignItems: 'center', marginHorizontal: 16, marginBottom: 8 },
  generateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  empty:           { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  payslipCard:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12 },
  avatar:          { width: 44, height: 44, borderRadius: 22, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center' },
  avatarText:      { color: '#fff', fontSize: 18, fontWeight: '700' },
  payslipBody:     { flex: 1 },
  empName:         { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  empRole:         { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 2 },
  payslipRight:    { alignItems: 'flex-end' },
  netPay:          { fontSize: 18, fontWeight: '700' },
  grossPay:        { color: '#9CA3AF', fontSize: 11, marginTop: 2 },
  modalOverlay:    { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:           { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:      { color: '#F9FAFB', fontSize: 16, fontWeight: '700', textAlign: 'right', marginBottom: 16 },
  detailRow:       { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#374151' },
  detailLabel:     { color: '#9CA3AF', fontSize: 14 },
  detailVal:       { color: '#F9FAFB', fontSize: 14 },
  closeBtn:        { backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 16 },
  closeBtnText:    { color: '#9CA3AF', fontWeight: '600' },
});
