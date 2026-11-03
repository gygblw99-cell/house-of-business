import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, Alert, Modal, ActivityIndicator,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function SuppliersScreen({ navigation }) {
  const [suppliers, setSuppliers] = useState([]);
  const [search,    setSearch]    = useState('');
  const [loading,   setLoading]   = useState(false);
  const [showAdd,   setShowAdd]   = useState(false);
  const [newName,   setNewName]   = useState('');
  const [newPhone,  setNewPhone]  = useState('');
  const [newCat,    setNewCat]    = useState('');
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getSuppliers();
      setSuppliers(data?.items || data || []);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newName.trim()) { Alert.alert('שגיאה', 'שם ספק חובה'); return; }
    setSaving(true);
    try {
      await api.createSupplier({
        name: newName.trim(),
        category: newCat.trim() || undefined,
        contacts: newPhone.trim() ? [{ phone: newPhone.trim() }] : [],
      });
      setShowAdd(false);
      setNewName(''); setNewPhone(''); setNewCat('');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  const filtered = suppliers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <View style={s.container}>
      <ScreenHeader
        title={`ספקים (${suppliers.length})`}
        right={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TouchableOpacity onPress={() => navigation.navigate('DailyOrders')}>
              <Text style={s.ordersBtn}>הזמנות</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAdd(true)}>
              <Text style={s.addBtn}>+ הוסף</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <TextInput
        style={s.search}
        placeholder="חיפוש ספק..."
        placeholderTextColor="#6B7280"
        value={search}
        onChangeText={setSearch}
        textAlign="right"
      />

      <FlatList
        data={filtered}
        keyExtractor={i => i.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.card}
            onPress={() => navigation.navigate('SupplierDetail', { supplierId: item.id })}
          >
            <View style={s.cardTop}>
              <Text style={s.name}>{item.name}</Text>
              <View style={[s.statusDot, { backgroundColor: item.is_active ? '#10B981' : '#6B7280' }]} />
            </View>
            <Text style={s.category}>{item.category || 'ללא קטגוריה'}</Text>
            {item.contacts?.length > 0 && (
              <Text style={s.contact}>{item.contacts[0].name} • {item.contacts[0].phone}</Text>
            )}
          </TouchableOpacity>
        )}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין ספקים</Text>}
      />

      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>ספק חדש</Text>
            <TextInput style={s.modalInput} value={newName} onChangeText={setNewName}
              placeholder="שם ספק *" placeholderTextColor="#6B7280" textAlign="right" autoFocus />
            <TextInput style={s.modalInput} value={newPhone} onChangeText={setNewPhone}
              placeholder="טלפון ליצירת קשר" placeholderTextColor="#6B7280" keyboardType="phone-pad" textAlign="right" />
            <TextInput style={s.modalInput} value={newCat} onChangeText={setNewCat}
              placeholder="קטגוריה (ירקות / בשר / ...)" placeholderTextColor="#6B7280" textAlign="right" />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowAdd(false)}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAdd} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.modalSaveText}>הוסף ספק</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  search:    { margin: 16, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 15 },
  card:      { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 10 },
  cardTop:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  name:      { color: '#F9FAFB', fontSize: 16, fontWeight: '600' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  category:  { color: '#9CA3AF', fontSize: 12, textAlign: 'right' },
  contact:   { color: '#6B7280', fontSize: 12, marginTop: 4, textAlign: 'right' },
  ordersBtn:       { color: '#6366F1', fontWeight: '600', fontSize: 14 },
  addBtn:          { color: '#10B981', fontWeight: '700', fontSize: 14 },
  empty:           { color: '#6B7280', textAlign: 'center', marginTop: 40 },
  modalOverlay:    { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:           { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:      { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 14 },
  modalInput:      { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 12, fontSize: 14, borderWidth: 1, borderColor: '#374151', marginBottom: 10 },
  modalActions:    { flexDirection: 'row', gap: 10, marginTop: 12 },
  modalCancel:     { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText: { color: '#9CA3AF', fontWeight: '600' },
  modalSave:       { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:   { color: '#fff', fontWeight: '700' },
});
