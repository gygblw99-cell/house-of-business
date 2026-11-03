import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, Alert, Modal, ActivityIndicator, ScrollView,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function InventoryScreen({ navigation, route }) {
  const [items,      setItems]      = useState([]);
  const [value,      setValue]      = useState(null);
  const [categories, setCategories] = useState([]);
  const [expiring,   setExpiring]   = useState([]);
  const [search,     setSearch]     = useState('');
  const [loading,    setLoading]    = useState(false);
  const [lowOnly,    setLowOnly]    = useState(route.params?.lowStock || false);
  const [catFilter,  setCatFilter]  = useState(null);
  const [showAdd,    setShowAdd]    = useState(false);
  const [newName,    setNewName]    = useState('');
  const [newQty,     setNewQty]     = useState('0');
  const [newUnit,    setNewUnit]    = useState('יח');
  const [newCost,    setNewCost]    = useState('0');
  const [newMin,     setNewMin]     = useState('1');
  const [saving,     setSaving]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, val, cats, exp] = await Promise.all([
        api.getInventory(lowOnly ? { lowStock: true } : {}),
        api.getInventoryValue(),
        api.getInventoryCategories().catch(() => []),
        api.getExpiringItems(7).catch(() => []),
      ]);
      setItems(data?.items || data || []);
      setValue(val);
      const catArr = Array.isArray(cats) ? cats : (cats?.categories || []);
      setCategories(catArr);
      const expArr = Array.isArray(exp) ? exp : (exp?.items || []);
      setExpiring(expArr);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  }, [lowOnly]);

  useEffect(() => { load(); }, [load]);

  const handleAddItem = async () => {
    if (!newName.trim()) { Alert.alert('שגיאה', 'שם פריט חובה'); return; }
    setSaving(true);
    try {
      await api.createInventoryItem({
        name: newName.trim(),
        current_qty: parseFloat(newQty) || 0,
        unit: newUnit.trim() || 'יח',
        cost_per_unit: parseFloat(newCost) || 0,
        min_qty: parseFloat(newMin) || 1,
      });
      setShowAdd(false);
      setNewName(''); setNewQty('0'); setNewUnit('יח'); setNewCost('0'); setNewMin('1');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  let filtered = items.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase())
  );
  if (catFilter) {
    filtered = filtered.filter(i => i.category_id === catFilter || i.category === catFilter);
  }

  return (
    <View style={s.container}>
      <ScreenHeader
        title="מלאי"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        right={
          <View style={{ flexDirection: 'row', gap: 14 }}>
            <TouchableOpacity onPress={() => navigation.navigate('Waste')}><Text style={s.wasteBtn}>בזבוז</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAdd(true)}><Text style={s.addBtn}>+ הוסף</Text></TouchableOpacity>
          </View>
        }
      />

      {value && (
        <View style={s.valueBar}>
          <Text style={s.valueText}>שווי מלאי: <Text style={s.valueNum}>₪{parseFloat(value.total_value || 0).toFixed(0)}</Text></Text>
          {value.low_stock_count > 0 && (
            <Text style={s.lowAlert}>⚠️ {value.low_stock_count} חסרים</Text>
          )}
        </View>
      )}

      {/* Expiring soon banner */}
      {expiring.length > 0 && (
        <View style={s.expiryBanner}>
          <Text style={s.expiryTitle}>⏰ פג תוקף בקרוב ({expiring.length})</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
            {expiring.map((e, i) => (
              <View key={e.id || i} style={s.expiryChip}>
                <Text style={s.expiryName}>{e.name}</Text>
                <Text style={s.expiryDays}>
                  {e.days_until_expiry != null
                    ? (e.days_until_expiry <= 0 ? 'פג!' : `${e.days_until_expiry}י`)
                    : ''}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      <View style={s.filterRow}>
        <TextInput
          style={s.search}
          placeholder="חיפוש פריט..."
          placeholderTextColor="#6B7280"
          value={search}
          onChangeText={setSearch}
          textAlign="right"
        />
        <TouchableOpacity
          style={[s.filterBtn, lowOnly && s.filterBtnActive]}
          onPress={() => setLowOnly(v => !v)}
        >
          <Text style={[s.filterBtnText, lowOnly && s.filterBtnTextActive]}>נמוך</Text>
        </TouchableOpacity>
      </View>

      {/* Category chips */}
      {categories.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catScroll} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          <TouchableOpacity style={[s.catChip, !catFilter && s.catChipActive]} onPress={() => setCatFilter(null)}>
            <Text style={[s.catChipText, !catFilter && { color: '#fff' }]}>הכל</Text>
          </TouchableOpacity>
          {categories.map(c => (
            <TouchableOpacity
              key={c.id || c.name}
              style={[s.catChip, catFilter === (c.id || c.name) && s.catChipActive]}
              onPress={() => setCatFilter(catFilter === (c.id || c.name) ? null : (c.id || c.name))}
            >
              <Text style={[s.catChipText, catFilter === (c.id || c.name) && { color: '#fff' }]}>{c.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <FlatList
        data={filtered}
        keyExtractor={i => String(i.id)}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => {
          const isExpiring = expiring.some(e => e.id === item.id);
          return (
            <TouchableOpacity
              style={[s.card, item.is_low && s.cardLow, isExpiring && s.cardExpiring]}
              onPress={() => navigation.navigate('InventoryItem', { itemId: item.id })}
            >
              <View style={s.cardTop}>
                <Text style={s.itemName}>{item.name}</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {item.is_low && <Text style={s.lowBadge}>⚠️ נמוך</Text>}
                  {isExpiring && <Text style={s.expiryBadge}>⏰ פג</Text>}
                </View>
              </View>
              <View style={s.cardBottom}>
                <Text style={s.qty}>{parseFloat(item.current_qty).toFixed(1)} {item.unit}</Text>
                <Text style={s.minQty}>מינ׳: {item.min_qty}</Text>
                <Text style={s.cost}>₪{parseFloat(item.cost_per_unit).toFixed(2)} ליח׳</Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין פריטים</Text>}
      />

      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>פריט מלאי חדש</Text>
            {[
              { label: 'שם פריט *', value: newName, set: setNewName, placeholder: 'למשל: עגבניות' },
              { label: 'יחידות מידה', value: newUnit, set: setNewUnit, placeholder: 'ק"ג / ליטר / יח' },
              { label: 'כמות נוכחית', value: newQty, set: setNewQty, placeholder: '0', keyboard: 'numeric' },
              { label: 'עלות ליחידה (₪)', value: newCost, set: setNewCost, placeholder: '0', keyboard: 'numeric' },
              { label: 'מינימום מלאי', value: newMin, set: setNewMin, placeholder: '1', keyboard: 'numeric' },
            ].map(f => (
              <View key={f.label}>
                <Text style={s.modalLabel}>{f.label}</Text>
                <TextInput
                  style={s.modalInput}
                  value={f.value}
                  onChangeText={f.set}
                  placeholder={f.placeholder}
                  placeholderTextColor="#6B7280"
                  keyboardType={f.keyboard || 'default'}
                  textAlign="right"
                />
              </View>
            ))}
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowAdd(false)}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAddItem} disabled={saving}>
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
  container:        { flex: 1, backgroundColor: '#0F0F1A' },
  back:             { color: '#6366F1', fontSize: 15 },
  wasteBtn:         { color: '#F59E0B', fontWeight: '600', fontSize: 14 },
  addBtn:           { color: '#6366F1', fontWeight: '700', fontSize: 14 },
  valueBar:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 16, marginBottom: 8 },
  valueText:        { color: '#9CA3AF', fontSize: 13 },
  valueNum:         { color: '#F9FAFB', fontWeight: '700' },
  lowAlert:         { color: '#F87171', fontSize: 13, fontWeight: '600' },
  expiryBanner:     { marginHorizontal: 16, backgroundColor: '#7C2D1222', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#F59E0B44' },
  expiryTitle:      { color: '#F59E0B', fontSize: 13, fontWeight: '700', textAlign: 'right' },
  expiryChip:       { backgroundColor: '#7C2D12', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, alignItems: 'center' },
  expiryName:       { color: '#FED7AA', fontSize: 12, fontWeight: '600' },
  expiryDays:       { color: '#F87171', fontSize: 10, marginTop: 2 },
  filterRow:        { flexDirection: 'row', marginHorizontal: 16, gap: 8, marginBottom: 4 },
  search:           { flex: 1, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 15 },
  filterBtn:        { backgroundColor: '#1E1E2E', borderRadius: 12, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#374151' },
  filterBtnActive:  { backgroundColor: '#F59E0B', borderColor: '#F59E0B' },
  filterBtnText:    { color: '#9CA3AF', fontSize: 13 },
  filterBtnTextActive: { color: '#fff', fontWeight: '600' },
  catScroll:        { marginBottom: 8 },
  catChip:          { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#1E1E2E', borderWidth: 1, borderColor: '#374151', marginRight: 8 },
  catChipActive:    { backgroundColor: '#6366F1', borderColor: '#6366F1' },
  catChipText:      { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  card:             { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, marginBottom: 8 },
  cardLow:          { borderLeftWidth: 3, borderLeftColor: '#EF4444' },
  cardExpiring:     { borderLeftWidth: 3, borderLeftColor: '#F59E0B' },
  cardTop:          { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  itemName:         { color: '#F9FAFB', fontSize: 15, fontWeight: '600' },
  lowBadge:         { color: '#F87171', fontSize: 12 },
  expiryBadge:      { color: '#F59E0B', fontSize: 12 },
  cardBottom:       { flexDirection: 'row', justifyContent: 'space-between' },
  qty:              { color: '#D1D5DB', fontSize: 14, fontWeight: '600' },
  minQty:           { color: '#6B7280', fontSize: 12 },
  cost:             { color: '#9CA3AF', fontSize: 12 },
  empty:            { color: '#6B7280', textAlign: 'center', marginTop: 40 },
  modalOverlay:     { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:            { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:       { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 14 },
  modalLabel:       { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginBottom: 4, marginTop: 8 },
  modalInput:       { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 12, fontSize: 14, borderWidth: 1, borderColor: '#374151' },
  modalActions:     { flexDirection: 'row', gap: 10, marginTop: 16 },
  modalCancel:      { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText:  { color: '#9CA3AF', fontWeight: '600' },
  modalSave:        { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:    { color: '#fff', fontWeight: '700' },
});
