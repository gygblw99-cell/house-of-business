import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, Modal, TextInput, AppState,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function QueueScreen({ navigation }) {
  const [queue,    setQueue]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showAdd,  setShowAdd]  = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [partySize, setPartySize]   = useState('2');
  const [saving,   setSaving]   = useState(false);
  const pollRef = useRef(null);
  const appStateRef = useRef(AppState.currentState);

  const load = useCallback(async () => {
    try {
      const data = await api.getQueue();
      setQueue(Array.isArray(data) ? data : (data.queue || []));
    } catch (err) {
      // silent fail on poll
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    // poll every 15 seconds for real-time queue updates
    pollRef.current = setInterval(load, 15000);
    const sub = AppState.addEventListener('change', state => {
      if (appStateRef.current.match(/inactive|background/) && state === 'active') {
        load();
      }
      appStateRef.current = state;
    });
    return () => {
      clearInterval(pollRef.current);
      sub.remove();
    };
  }, [load]);

  const handleReady = async (id, guestName_) => {
    try {
      await api.markReady(id);
      Alert.alert('📢 נשלחה הודעה', `${guestName_ || 'הלקוח'} קיבל הודעת WhatsApp שהשולחן מוכן`);
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
  };

  const handleRemove = (id) => {
    Alert.alert('הסרה מהתור', 'האם להסיר לקוח זה מהתור?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'הסר', style: 'destructive',
        onPress: async () => {
          try { await api.removeFromQueue(id); load(); }
          catch (err) { Alert.alert('שגיאה', err.message); }
        },
      },
    ]);
  };

  const handleAdd = async () => {
    if (!guestName.trim() && !guestPhone.trim()) {
      Alert.alert('שגיאה', 'הזן שם או טלפון');
      return;
    }
    setSaving(true);
    try {
      await api.addToQueue({
        guest_name: guestName.trim() || undefined,
        phone: guestPhone.trim() || undefined,
        party_size: parseInt(partySize) || 2,
      });
      setShowAdd(false);
      setGuestName(''); setGuestPhone(''); setPartySize('2');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  const waiting  = queue.filter(q => q.status !== 'seated' && q.status !== 'left');
  const seated   = queue.filter(q => q.status === 'seated');

  const waitTime = (joinedAt) => {
    const mins = Math.floor((Date.now() - new Date(joinedAt).getTime()) / 60000);
    return mins >= 60 ? `${Math.floor(mins/60)}ש' ${mins%60}ד'` : `${mins} ד'`;
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title={`תור / המתנה (${waiting.length})`}
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        right={<TouchableOpacity onPress={() => setShowAdd(true)}><Text style={s.addBtn}>+ הוסף</Text></TouchableOpacity>}
      />

      {/* סטטיסטיקת תור */}
      <View style={s.statsRow}>
        <View style={s.stat}>
          <Text style={[s.statVal, { color: '#EF4444' }]}>{waiting.length}</Text>
          <Text style={s.statLabel}>ממתינים</Text>
        </View>
        <View style={s.stat}>
          <Text style={[s.statVal, { color: '#10B981' }]}>{seated.length}</Text>
          <Text style={s.statLabel}>ישובים</Text>
        </View>
        <View style={s.stat}>
          <Text style={s.statVal}>{queue.reduce((s, q) => s + (q.party_size || 1), 0)}</Text>
          <Text style={s.statLabel}>אורחים סה"כ</Text>
        </View>
      </View>

      {loading && queue.length === 0 ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={[...waiting, ...seated]}
          keyExtractor={q => String(q.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>התור ריק — אין המתינים 🎉</Text>}
          renderItem={({ item }) => {
            const isSeated = item.status === 'seated';
            return (
              <View style={[s.queueCard, isSeated && s.queueSeated]}>
                <View style={s.positionBadge}>
                  <Text style={s.positionNum}>{item.position || '—'}</Text>
                </View>
                <View style={s.cardBody}>
                  <Text style={s.guestName}>{item.guest_name || item.phone || 'אנונימי'}</Text>
                  <View style={s.cardMeta}>
                    <Text style={s.partySize}>👥 {item.party_size || 1} אורחים</Text>
                    {item.joined_at && (
                      <Text style={[s.waitTime, { color: isSeated ? '#10B981' : '#F59E0B' }]}>
                        ⏱ {waitTime(item.joined_at)}
                      </Text>
                    )}
                    {isSeated && <Text style={s.seatedBadge}>✅ ישוב</Text>}
                  </View>
                </View>
                {!isSeated && (
                  <View style={s.actions}>
                    <TouchableOpacity
                      style={s.readyBtn}
                      onPress={() => handleReady(item.id, item.guest_name)}
                    >
                      <Text style={s.readyBtnText}>שולחן מוכן</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleRemove(item.id)}>
                      <Text style={s.removeBtn}>✕</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {/* Modal הוספה לתור */}
      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>הוסף לתור</Text>
            <TextInput
              style={s.modalInput}
              value={guestName}
              onChangeText={setGuestName}
              placeholder="שם אורח"
              placeholderTextColor="#6B7280"
              textAlign="right"
              autoFocus
            />
            <TextInput
              style={s.modalInput}
              value={guestPhone}
              onChangeText={setGuestPhone}
              placeholder="טלפון (לשליחת WhatsApp)"
              placeholderTextColor="#6B7280"
              keyboardType="phone-pad"
              textAlign="right"
            />
            <Text style={s.modalLabel}>מספר אורחים</Text>
            <View style={s.partySizeRow}>
              {[1,2,3,4,5,6,8,10].map(n => (
                <TouchableOpacity
                  key={n}
                  style={[s.sizeBtn, partySize === String(n) && s.sizeBtnActive]}
                  onPress={() => setPartySize(String(n))}
                >
                  <Text style={[s.sizeBtnText, partySize === String(n) && s.sizeBtnTextActive]}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowAdd(false)}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAdd} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.modalSaveText}>הוסף לתור</Text>}
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
  back:              { color: '#6366F1', fontSize: 15 },
  addBtn:            { color: '#6366F1', fontSize: 15, fontWeight: '700' },
  statsRow:          { flexDirection: 'row', margin: 16, backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14 },
  stat:              { flex: 1, alignItems: 'center' },
  statVal:           { color: '#F9FAFB', fontSize: 24, fontWeight: '700' },
  statLabel:         { color: '#6B7280', fontSize: 11, marginTop: 2 },
  empty:             { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  queueCard:         { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12 },
  queueSeated:       { opacity: 0.6 },
  positionBadge:     { width: 40, height: 40, borderRadius: 20, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center' },
  positionNum:       { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardBody:          { flex: 1 },
  guestName:         { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  cardMeta:          { flexDirection: 'row', gap: 10, marginTop: 4, justifyContent: 'flex-end', alignItems: 'center' },
  partySize:         { color: '#9CA3AF', fontSize: 12 },
  waitTime:          { fontSize: 12, fontWeight: '700' },
  seatedBadge:       { color: '#10B981', fontSize: 12, fontWeight: '700' },
  actions:           { flexDirection: 'column', gap: 6, alignItems: 'center' },
  readyBtn:          { backgroundColor: '#10B981', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  readyBtnText:      { color: '#fff', fontSize: 12, fontWeight: '700' },
  removeBtn:         { color: '#EF4444', fontSize: 20, fontWeight: '700' },
  modalOverlay:      { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:             { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:        { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 16 },
  modalInput:        { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 14, fontSize: 15, borderWidth: 1, borderColor: '#374151', marginBottom: 12 },
  modalLabel:        { color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginBottom: 8 },
  partySizeRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  sizeBtn:           { width: 44, height: 44, borderRadius: 22, backgroundColor: '#374151', alignItems: 'center', justifyContent: 'center' },
  sizeBtnActive:     { backgroundColor: '#6366F1' },
  sizeBtnText:       { color: '#9CA3AF', fontSize: 14, fontWeight: '700' },
  sizeBtnTextActive: { color: '#fff' },
  modalActions:      { flexDirection: 'row', gap: 10 },
  modalCancel:       { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText:   { color: '#9CA3AF', fontWeight: '600' },
  modalSave:         { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:     { color: '#fff', fontWeight: '700' },
});
