import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, Alert, Modal, ActivityIndicator,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function EmployeesScreen({ navigation }) {
  const [employees, setEmployees] = useState([]);
  const [active,    setActive]    = useState([]);
  const [search,    setSearch]    = useState('');
  const [loading,   setLoading]   = useState(false);
  const [showAdd,   setShowAdd]   = useState(false);
  const [newName,   setNewName]   = useState('');
  const [newPhone,  setNewPhone]  = useState('');
  const [newRole,   setNewRole]   = useState('employee');
  const [newSalary, setNewSalary] = useState('');
  const [newSalaryType, setNewSalaryType] = useState('hourly');
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [emps, shifts] = await Promise.all([
        api.getEmployees(),
        api.getActiveShifts(),
      ]);
      setEmployees(emps);
      setActive(shifts);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAddEmployee = async () => {
    if (!newName.trim()) { Alert.alert('שגיאה', 'שם עובד חובה'); return; }
    setSaving(true);
    try {
      await api.createEmployee({
        full_name: newName.trim(),
        phone: newPhone.trim() || undefined,
        role: newRole,
        salary_type: newSalaryType,
        salary_amount: parseFloat(newSalary) || 0,
      });
      setShowAdd(false);
      setNewName(''); setNewPhone(''); setNewSalary('');
      load();
      Alert.alert('✅ נוסף', `${newName} נוסף בהצלחה`);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  const filtered = employees.filter(e =>
    e.full_name.toLowerCase().includes(search.toLowerCase())
  );

  const isActive = (id) => active.some(s => s.employee_id === id);

  const renderEmployee = ({ item }) => {
    const onShift = isActive(item.id);
    return (
      <TouchableOpacity
        style={s.card}
        onPress={() => navigation.navigate('Shifts', { employeeId: item.id, name: item.full_name })}
      >
        <View style={s.cardLeft}>
          <View style={[s.dot, { backgroundColor: onShift ? '#10B981' : '#374151' }]} />
          <View>
            <Text style={s.name}>{item.full_name}</Text>
            <Text style={s.role}>{item.role === 'manager' ? 'מנהל' : 'עובד'} • {item.salary_type === 'hourly' ? `₪${item.salary_amount}/שעה` : `₪${item.salary_amount}/חודש`}</Text>
          </View>
        </View>
        {onShift && <Text style={s.activeBadge}>פעיל</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="עובדים"
        right={
          <View style={{ flexDirection: 'row', gap: 14 }}>
            <TouchableOpacity onPress={() => navigation.navigate('ClockIn')}>
              <Text style={s.clockBtn}>שעון</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAdd(true)}>
              <Text style={s.addEmpBtn}>+ הוסף</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <TextInput
        style={s.search}
        placeholder="חיפוש עובד..."
        placeholderTextColor="#6B7280"
        value={search}
        onChangeText={setSearch}
        textAlign="right"
      />

      {active.length > 0 && (
        <View style={s.activeWrap}>
          <Text style={s.activeSectionTitle}>כרגע במשמרת ({active.length})</Text>
          {active.map(s_ => (
            <View key={s_.id} style={s.activeRow}>
              <Text style={s.activeName}>{s_.full_name}</Text>
              <Text style={s.activeHours}>{parseFloat(s_.hours_so_far).toFixed(1)} שעות</Text>
            </View>
          ))}
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={i => i.id}
        renderItem={renderEmployee}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={<Text style={s.empty}>אין עובדים</Text>}
      />

      {/* Modal הוספת עובד */}
      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>עובד חדש</Text>
            <TextInput style={s.modalInput} value={newName} onChangeText={setNewName}
              placeholder="שם מלא *" placeholderTextColor="#6B7280" textAlign="right" autoFocus />
            <TextInput style={s.modalInput} value={newPhone} onChangeText={setNewPhone}
              placeholder="טלפון" placeholderTextColor="#6B7280" keyboardType="phone-pad" textAlign="right" />

            <Text style={s.modalLabel}>תפקיד</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              {[['employee','עובד'],['manager','מנהל']].map(([v,l]) => (
                <TouchableOpacity key={v} style={[s.roleBtn, newRole === v && s.roleBtnActive]} onPress={() => setNewRole(v)}>
                  <Text style={[s.roleBtnText, newRole === v && { color: '#fff' }]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.modalLabel}>סוג שכר</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              {[['hourly','שעתי'],['monthly','חודשי'],['global','גלובלי']].map(([v,l]) => (
                <TouchableOpacity key={v} style={[s.roleBtn, newSalaryType === v && s.roleBtnActive]} onPress={() => setNewSalaryType(v)}>
                  <Text style={[s.roleBtnText, newSalaryType === v && { color: '#fff' }]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput style={s.modalInput} value={newSalary} onChangeText={setNewSalary}
              placeholder={`שכר (₪/${newSalaryType === 'hourly' ? 'שעה' : 'חודש'})`}
              placeholderTextColor="#6B7280" keyboardType="numeric" textAlign="right" />

            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowAdd(false)}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAddEmployee} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.modalSaveText}>הוסף עובד</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:         { flex: 1, backgroundColor: '#0F0F1A' },
  search:            { margin: 16, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 15 },
  card:              { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft:          { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot:               { width: 10, height: 10, borderRadius: 5 },
  name:              { color: '#F9FAFB', fontSize: 16, fontWeight: '600', textAlign: 'right' },
  role:              { color: '#9CA3AF', fontSize: 12, marginTop: 2, textAlign: 'right' },
  activeBadge:       { backgroundColor: '#064E3B', color: '#10B981', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, fontSize: 12, fontWeight: '600' },
  activeWrap:        { marginHorizontal: 16, backgroundColor: '#064E3B', borderRadius: 14, padding: 14, marginBottom: 8 },
  activeSectionTitle:{ color: '#10B981', fontWeight: '700', fontSize: 14, textAlign: 'right', marginBottom: 8 },
  activeRow:         { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  activeName:        { color: '#F9FAFB', fontSize: 14 },
  activeHours:       { color: '#6EE7B7', fontSize: 14, fontWeight: '600' },
  clockBtn:          { color: '#6366F1', fontWeight: '600', fontSize: 15 },
  addEmpBtn:         { color: '#10B981', fontWeight: '700', fontSize: 15 },
  empty:             { color: '#6B7280', textAlign: 'center', marginTop: 40 },
  modalOverlay:      { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:             { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:        { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 14 },
  modalLabel:        { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginBottom: 6 },
  modalInput:        { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 12, fontSize: 14, borderWidth: 1, borderColor: '#374151', marginBottom: 10 },
  roleBtn:           { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#374151' },
  roleBtnActive:     { backgroundColor: '#6366F1' },
  roleBtnText:       { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  modalActions:      { flexDirection: 'row', gap: 10, marginTop: 12 },
  modalCancel:       { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText:   { color: '#9CA3AF', fontWeight: '600' },
  modalSave:         { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:     { color: '#fff', fontWeight: '700' },
});
