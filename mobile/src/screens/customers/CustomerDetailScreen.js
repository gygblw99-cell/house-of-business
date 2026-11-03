import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, TextInput, Modal,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function CustomerDetailScreen({ navigation, route }) {
  const { customerId } = route.params;
  const [customer, setCustomer] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [showVisit, setShowVisit] = useState(false);
  const [amount,   setAmount]   = useState('');
  const [note,     setNote]     = useState('');
  const [saving,   setSaving]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await api.getCustomer(customerId);
      setCustomer(c);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  const handleLogVisit = async () => {
    setSaving(true);
    try {
      const res = await api.logCustomerVisit(customerId, {
        amount: parseFloat(amount) || 0,
        note: note.trim() || undefined,
      });
      Alert.alert('✅ ביקור נרשם!', res.message || `+${res.pointsEarned || 0} נקודות`);
      setShowVisit(false);
      setAmount(''); setNote('');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  if (loading) return <View style={s.container}><ActivityIndicator color="#6366F1" style={{ marginTop: 60 }} /></View>;
  if (!customer) return <View style={s.container}><Text style={s.empty}>לקוח לא נמצא</Text></View>;

  const tierColor = customer.points >= 300 ? '#A78BFA' : customer.points >= 100 ? '#F59E0B' : customer.points >= 40 ? '#9CA3AF' : '#374151';
  const tierLabel = customer.points >= 300 ? 'פלטינה' : customer.points >= 100 ? 'זהב' : customer.points >= 40 ? 'כסף' : 'בסיסי';

  return (
    <View style={s.container}>
      <ScreenHeader
        title={customer.name || customer.phone}
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* פרופיל לקוח */}
        <View style={s.profileCard}>
          <View style={[s.avatar, { borderColor: tierColor }]}>
            <Text style={s.avatarText}>{(customer.name || customer.phone || '?').charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={s.name}>{customer.name || '—'}</Text>
          <Text style={s.phone}>{customer.phone}</Text>
          <View style={[s.tierBadge, { backgroundColor: tierColor + '33', borderColor: tierColor }]}>
            <Text style={[s.tierText, { color: tierColor }]}>דרגת {tierLabel}</Text>
          </View>
        </View>

        {/* סטטיסטיקות */}
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{customer.points || 0}</Text>
            <Text style={s.statLabel}>נקודות</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{customer.total_visits || 0}</Text>
            <Text style={s.statLabel}>ביקורים</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>₪{parseFloat(customer.total_spent || 0).toFixed(0)}</Text>
            <Text style={s.statLabel}>סה"כ הוצאות</Text>
          </View>
        </View>

        {/* רישום ביקור */}
        <TouchableOpacity style={s.visitBtn} onPress={() => setShowVisit(true)}>
          <Text style={s.visitBtnText}>+ רשום ביקור</Text>
        </TouchableOpacity>

        {/* פרטים נוספים */}
        {customer.birthday && (
          <View style={s.infoRow}>
            <Text style={s.infoVal}>{new Date(customer.birthday).toLocaleDateString('he-IL')}</Text>
            <Text style={s.infoLabel}>🎂 יום הולדת</Text>
          </View>
        )}
        {customer.email && (
          <View style={s.infoRow}>
            <Text style={s.infoVal}>{customer.email}</Text>
            <Text style={s.infoLabel}>📧 אימייל</Text>
          </View>
        )}
        <View style={s.infoRow}>
          <Text style={s.infoVal}>{customer.last_visit ? new Date(customer.last_visit).toLocaleDateString('he-IL') : '—'}</Text>
          <Text style={s.infoLabel}>📅 ביקור אחרון</Text>
        </View>
        <View style={s.infoRow}>
          <Text style={s.infoVal}>{customer.first_visit ? new Date(customer.first_visit).toLocaleDateString('he-IL') : '—'}</Text>
          <Text style={s.infoLabel}>🗓️ לקוח מאז</Text>
        </View>

        {/* היסטוריית ביקורים */}
        {customer.visits?.length > 0 && (
          <>
            <Text style={s.sectionTitle}>ביקורים אחרונים</Text>
            {customer.visits.map((v, i) => (
              <View key={v.id || i} style={s.visitRow}>
                <Text style={s.visitDate}>
                  {new Date(v.visited_at).toLocaleDateString('he-IL')}
                </Text>
                <Text style={s.visitPoints}>+{v.points_earned} נק'</Text>
                <Text style={s.visitAmount}>₪{parseFloat(v.amount || 0).toFixed(0)}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      {/* Modal רישום ביקור */}
      <Modal visible={showVisit} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>רישום ביקור — {customer.name || customer.phone}</Text>
            <TextInput
              style={s.modalInput}
              value={amount}
              onChangeText={setAmount}
              placeholder="סכום הזמנה (₪)"
              placeholderTextColor="#6B7280"
              keyboardType="numeric"
              textAlign="right"
              autoFocus
            />
            <TextInput
              style={s.modalInput}
              value={note}
              onChangeText={setNote}
              placeholder="הערה (אופציונלי)"
              placeholderTextColor="#6B7280"
              textAlign="right"
            />
            <Text style={s.pointsPreview}>
              יצברו {Math.floor((parseFloat(amount) || 0) / 10)} נקודות
            </Text>
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => { setShowVisit(false); setAmount(''); setNote(''); }}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleLogVisit} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.modalSaveText}>שמור ביקור</Text>}
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
  back:            { color: '#6366F1', fontSize: 15 },
  empty:           { color: '#6B7280', textAlign: 'center', marginTop: 60, fontSize: 16 },
  profileCard:     { backgroundColor: '#1E1E2E', borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 16 },
  avatar:          { width: 72, height: 72, borderRadius: 36, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center', borderWidth: 3, marginBottom: 12 },
  avatarText:      { color: '#fff', fontSize: 28, fontWeight: '700' },
  name:            { color: '#F9FAFB', fontSize: 20, fontWeight: '700', marginBottom: 4 },
  phone:           { color: '#9CA3AF', fontSize: 14, marginBottom: 12 },
  tierBadge:       { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1 },
  tierText:        { fontSize: 13, fontWeight: '700' },
  statsRow:        { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 16 },
  stat:            { flex: 1, alignItems: 'center' },
  statVal:         { color: '#F9FAFB', fontSize: 22, fontWeight: '700' },
  statLabel:       { color: '#6B7280', fontSize: 11, marginTop: 4 },
  visitBtn:        { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 16 },
  visitBtnText:    { color: '#fff', fontWeight: '700', fontSize: 16 },
  infoRow:         { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' },
  infoLabel:       { color: '#9CA3AF', fontSize: 14 },
  infoVal:         { color: '#F9FAFB', fontSize: 14, fontWeight: '600' },
  sectionTitle:    { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 10, textAlign: 'right' },
  visitRow:        { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#1E1E2E', borderRadius: 10, padding: 12, marginBottom: 6 },
  visitDate:       { color: '#9CA3AF', fontSize: 13 },
  visitPoints:     { color: '#6366F1', fontSize: 13, fontWeight: '700' },
  visitAmount:     { color: '#10B981', fontSize: 13, fontWeight: '700' },
  modalOverlay:    { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:           { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:      { color: '#F9FAFB', fontSize: 17, fontWeight: '700', textAlign: 'right', marginBottom: 16 },
  modalInput:      { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 14, fontSize: 15, borderWidth: 1, borderColor: '#374151', marginBottom: 12 },
  pointsPreview:   { color: '#6366F1', fontSize: 14, textAlign: 'right', marginBottom: 16 },
  modalActions:    { flexDirection: 'row', gap: 10 },
  modalCancel:     { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText: { color: '#9CA3AF', fontWeight: '600' },
  modalSave:       { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:   { color: '#fff', fontWeight: '700' },
});
