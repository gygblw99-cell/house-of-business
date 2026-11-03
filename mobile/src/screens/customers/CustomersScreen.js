import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, ActivityIndicator, Alert, RefreshControl, Modal,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const TIER_COLORS = { silver: '#9CA3AF', gold: '#F59E0B', platinum: '#A78BFA' };
const TIER_LABELS = { silver: 'כסף', gold: 'זהב', platinum: 'פלטינה' };

function getTier(points, settings) {
  if (!settings) return null;
  if (points >= (settings.tier_platinum || 300)) return 'platinum';
  if (points >= (settings.tier_gold    || 100)) return 'gold';
  if (points >= (settings.tier_silver  ||  40)) return 'silver';
  return null;
}

export default function CustomersScreen({ navigation }) {
  const [customers, setCustomers]   = useState([]);
  const [stats,     setStats]       = useState(null);
  const [settings,  setSettings]    = useState(null);
  const [search,    setSearch]      = useState('');
  const [loading,   setLoading]     = useState(true);
  const [showAdd,   setShowAdd]     = useState(false);
  const [newPhone,  setNewPhone]    = useState('');
  const [newName,   setNewName]     = useState('');
  const [saving,    setSaving]      = useState(false);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const params = q ? { search: q } : {};
      const [c, st, set] = await Promise.all([
        api.getCustomers(params),
        api.getCustomerStats(),
        api.getLoyaltySettings(),
      ]);
      setCustomers(Array.isArray(c) ? c : []);
      setStats(st);
      setSettings(set);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSearch = (text) => {
    setSearch(text);
    if (text.length === 0 || text.length >= 2) load(text);
  };

  const handleAdd = async () => {
    if (!newPhone.trim()) { Alert.alert('שגיאה', 'מספר טלפון חובה'); return; }
    setSaving(true);
    try {
      await api.createCustomer({ phone: newPhone.trim(), name: newName.trim() || undefined });
      setShowAdd(false);
      setNewPhone(''); setNewName('');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="לקוחות ונאמנות"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        right={<TouchableOpacity onPress={() => setShowAdd(true)}><Text style={s.addBtn}>+ הוסף</Text></TouchableOpacity>}
      />

      {/* סטטיסטיקות */}
      {stats && (
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{stats.total_customers || 0}</Text>
            <Text style={s.statLabel}>סה"כ לקוחות</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{stats.active_this_month || 0}</Text>
            <Text style={s.statLabel}>פעילים החודש</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{stats.vip_count || 0}</Text>
            <Text style={s.statLabel}>VIP</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{stats.visits_today || 0}</Text>
            <Text style={s.statLabel}>ביקורים היום</Text>
          </View>
        </View>
      )}

      {/* חיפוש */}
      <View style={s.searchWrap}>
        <TextInput
          style={s.search}
          value={search}
          onChangeText={handleSearch}
          placeholder="חפש לפי שם או טלפון..."
          placeholderTextColor="#6B7280"
          textAlign="right"
        />
      </View>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={customers}
          keyExtractor={c => String(c.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(search)} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין לקוחות</Text>}
          renderItem={({ item }) => {
            const tier = getTier(item.points, settings);
            return (
              <TouchableOpacity
                style={s.card}
                onPress={() => navigation.navigate('CustomerDetail', { customerId: item.id })}
              >
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{(item.name || item.phone || '?').charAt(0).toUpperCase()}</Text>
                </View>
                <View style={s.cardBody}>
                  <View style={s.cardTop}>
                    <Text style={s.cardName}>{item.name || item.phone}</Text>
                    {tier && (
                      <View style={[s.tierBadge, { backgroundColor: TIER_COLORS[tier] + '33' }]}>
                        <Text style={[s.tierText, { color: TIER_COLORS[tier] }]}>{TIER_LABELS[tier]}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.cardPhone}>{item.phone}</Text>
                  <View style={s.cardStats}>
                    <Text style={s.cardStat}>🏆 {item.points || 0} נקודות</Text>
                    <Text style={s.cardStat}>📅 {item.total_visits || 0} ביקורים</Text>
                  </View>
                </View>
                <Text style={s.arrow}>←</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Modal הוספת לקוח */}
      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>לקוח חדש</Text>
            <TextInput
              style={s.modalInput}
              value={newPhone}
              onChangeText={setNewPhone}
              placeholder="מספר טלפון *"
              placeholderTextColor="#6B7280"
              keyboardType="phone-pad"
              textAlign="right"
              autoFocus
            />
            <TextInput
              style={s.modalInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="שם (אופציונלי)"
              placeholderTextColor="#6B7280"
              textAlign="right"
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => { setShowAdd(false); setNewPhone(''); setNewName(''); }}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAdd} disabled={saving}>
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
  back:            { color: '#6366F1', fontSize: 15 },
  addBtn:          { color: '#6366F1', fontSize: 15, fontWeight: '700' },
  statsRow:        { flexDirection: 'row', margin: 16, backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14 },
  stat:            { flex: 1, alignItems: 'center' },
  statVal:         { color: '#F9FAFB', fontSize: 20, fontWeight: '700' },
  statLabel:       { color: '#6B7280', fontSize: 10, marginTop: 2, textAlign: 'center' },
  searchWrap:      { marginHorizontal: 16, marginBottom: 8 },
  search:          { backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 14 },
  empty:           { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  card:            { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12 },
  avatar:          { width: 44, height: 44, borderRadius: 22, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center' },
  avatarText:      { color: '#fff', fontSize: 18, fontWeight: '700' },
  cardBody:        { flex: 1 },
  cardTop:         { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
  cardName:        { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  cardPhone:       { color: '#6B7280', fontSize: 12, textAlign: 'right', marginTop: 2 },
  cardStats:       { flexDirection: 'row', gap: 12, marginTop: 6, justifyContent: 'flex-end' },
  cardStat:        { color: '#9CA3AF', fontSize: 12 },
  arrow:           { color: '#374151', fontSize: 18 },
  tierBadge:       { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  tierText:        { fontSize: 11, fontWeight: '700' },
  modalOverlay:    { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:           { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:      { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 16 },
  modalInput:      { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 14, fontSize: 15, borderWidth: 1, borderColor: '#374151', marginBottom: 12 },
  modalActions:    { flexDirection: 'row', gap: 10, marginTop: 8 },
  modalCancel:     { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText: { color: '#9CA3AF', fontWeight: '600' },
  modalSave:       { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:   { color: '#fff', fontWeight: '700' },
});
