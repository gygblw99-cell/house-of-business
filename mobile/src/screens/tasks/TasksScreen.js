import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, TextInput, RefreshControl, Modal,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const PRIORITY_COLORS = { high: '#EF4444', medium: '#F59E0B', low: '#10B981' };
const PRIORITY_LABELS = { high: 'גבוה', medium: 'בינוני', low: 'נמוך' };

export default function TasksScreen({ navigation }) {
  const [tasks,     setTasks]     = useState([]);
  const [reminders, setReminders] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [tab,       setTab]       = useState('tasks'); // tasks | reminders
  const [showAdd,   setShowAdd]   = useState(false);
  const [newTitle,  setNewTitle]  = useState('');
  const [newPrio,   setNewPrio]   = useState('medium');
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, r] = await Promise.all([api.getTasks(), api.getReminders()]);
      setTasks(Array.isArray(t) ? t : (t.tasks || []));
      setReminders(Array.isArray(r) ? r : (r.reminders || []));
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleComplete = async (id) => {
    try {
      await api.completeTask(id);
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'completed' } : t));
    } catch (err) { Alert.alert('שגיאה', err.message); }
  };

  const handleDelete = (id) => {
    Alert.alert('מחיקת משימה', 'האם למחוק את המשימה?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'מחק', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteTask(id);
            setTasks(prev => prev.filter(t => t.id !== id));
          } catch (err) { Alert.alert('שגיאה', err.message); }
        },
      },
    ]);
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const res = await api.createTask({ title: newTitle.trim(), priority: newPrio });
      const t = res.task || res;
      setTasks(prev => [t, ...prev]);
      setNewTitle('');
      setShowAdd(false);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setSaving(false); }
  };

  const handleSnooze = async (id) => {
    try {
      await api.snoozeReminder(id);
      Alert.alert('נדחה', 'התזכורת נדחתה ב-24 שעות');
      load();
    } catch (err) { Alert.alert('שגיאה', err.message); }
  };

  const pendingTasks    = tasks.filter(t => t.status !== 'completed');
  const completedTasks  = tasks.filter(t => t.status === 'completed');

  return (
    <View style={s.container}>
      <ScreenHeader
        title="משימות ותזכורות"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        right={
          tab === 'tasks' && (
            <TouchableOpacity onPress={() => setShowAdd(true)}>
              <Text style={s.addBtn}>+ הוסף</Text>
            </TouchableOpacity>
          )
        }
      />

      {/* Tabs */}
      <View style={s.tabs}>
        <TouchableOpacity style={[s.tab, tab === 'tasks' && s.tabActive]} onPress={() => setTab('tasks')}>
          <Text style={[s.tabText, tab === 'tasks' && s.tabTextActive]}>משימות ({pendingTasks.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'reminders' && s.tabActive]} onPress={() => setTab('reminders')}>
          <Text style={[s.tabText, tab === 'reminders' && s.tabTextActive]}>תזכורות ({reminders.length})</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : tab === 'tasks' ? (
        <FlatList
          data={[...pendingTasks, ...completedTasks]}
          keyExtractor={t => String(t.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין משימות פתוחות</Text>}
          renderItem={({ item }) => {
            const done = item.status === 'completed';
            return (
              <View style={[s.taskCard, done && s.taskDone]}>
                <TouchableOpacity style={s.checkbox} onPress={() => !done && handleComplete(item.id)}>
                  <Text style={s.checkboxIcon}>{done ? '✅' : '⬜'}</Text>
                </TouchableOpacity>
                <View style={s.taskBody}>
                  <Text style={[s.taskTitle, done && s.taskTitleDone]}>{item.title}</Text>
                  {item.description ? <Text style={s.taskDesc}>{item.description}</Text> : null}
                  <View style={s.taskMeta}>
                    <View style={[s.prioBadge, { backgroundColor: PRIORITY_COLORS[item.priority] + '33' }]}>
                      <Text style={[s.prioText, { color: PRIORITY_COLORS[item.priority] }]}>
                        {PRIORITY_LABELS[item.priority] || item.priority}
                      </Text>
                    </View>
                    {item.due_date && (
                      <Text style={s.dueDate}>
                        {new Date(item.due_date).toLocaleDateString('he-IL')}
                      </Text>
                    )}
                  </View>
                </View>
                <TouchableOpacity onPress={() => handleDelete(item.id)}>
                  <Text style={s.deleteBtn}>🗑️</Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      ) : (
        <FlatList
          data={reminders}
          keyExtractor={r => String(r.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין תזכורות</Text>}
          renderItem={({ item }) => (
            <View style={s.reminderCard}>
              <View style={s.reminderBody}>
                <Text style={s.reminderTitle}>{item.title}</Text>
                <Text style={s.reminderTime}>
                  {item.remind_at ? new Date(item.remind_at).toLocaleString('he-IL') : ''}
                </Text>
                {item.is_recurring && <Text style={s.recurBadge}>🔁 חוזר</Text>}
              </View>
              <TouchableOpacity style={s.snoozeBtn} onPress={() => handleSnooze(item.id)}>
                <Text style={s.snoozeBtnText}>דחה</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      {/* Modal הוספת משימה */}
      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>משימה חדשה</Text>
            <TextInput
              style={s.modalInput}
              value={newTitle}
              onChangeText={setNewTitle}
              placeholder="כותרת המשימה..."
              placeholderTextColor="#6B7280"
              textAlign="right"
              autoFocus
            />
            <Text style={s.modalLabel}>עדיפות</Text>
            <View style={s.prioRow}>
              {['high', 'medium', 'low'].map(p => (
                <TouchableOpacity
                  key={p}
                  style={[s.prioBtn, newPrio === p && { backgroundColor: PRIORITY_COLORS[p] }]}
                  onPress={() => setNewPrio(p)}
                >
                  <Text style={[s.prioBtnText, newPrio === p && { color: '#fff' }]}>{PRIORITY_LABELS[p]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => { setShowAdd(false); setNewTitle(''); }}>
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
  container:      { flex: 1, backgroundColor: '#0F0F1A' },
  back:           { color: '#6366F1', fontSize: 15 },
  addBtn:         { color: '#6366F1', fontSize: 15, fontWeight: '700' },
  tabs:           { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, gap: 8 },
  tab:            { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#1E1E2E', alignItems: 'center' },
  tabActive:      { backgroundColor: '#6366F1' },
  tabText:        { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  tabTextActive:  { color: '#fff' },
  empty:          { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  taskCard:       { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12 },
  taskDone:       { opacity: 0.5 },
  checkbox:       { paddingTop: 2 },
  checkboxIcon:   { fontSize: 20 },
  taskBody:       { flex: 1 },
  taskTitle:      { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  taskTitleDone:  { textDecorationLine: 'line-through', color: '#6B7280' },
  taskDesc:       { color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginTop: 4 },
  taskMeta:       { flexDirection: 'row', gap: 8, marginTop: 8, justifyContent: 'flex-end', alignItems: 'center' },
  prioBadge:      { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  prioText:       { fontSize: 11, fontWeight: '700' },
  dueDate:        { color: '#6B7280', fontSize: 11 },
  deleteBtn:      { fontSize: 18, paddingLeft: 4 },
  reminderCard:   { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12 },
  reminderBody:   { flex: 1 },
  reminderTitle:  { color: '#F9FAFB', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  reminderTime:   { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 4 },
  recurBadge:     { color: '#6366F1', fontSize: 12, textAlign: 'right', marginTop: 4 },
  snoozeBtn:      { backgroundColor: '#374151', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  snoozeBtnText:  { color: '#D1D5DB', fontSize: 13 },
  modalOverlay:   { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:          { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalTitle:     { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 16 },
  modalInput:     { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 10, padding: 14, fontSize: 15, borderWidth: 1, borderColor: '#374151', marginBottom: 16 },
  modalLabel:     { color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginBottom: 8 },
  prioRow:        { flexDirection: 'row', gap: 8, marginBottom: 20, justifyContent: 'flex-end' },
  prioBtn:        { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#374151' },
  prioBtnText:    { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  modalActions:   { flexDirection: 'row', gap: 10 },
  modalCancel:    { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText:{ color: '#9CA3AF', fontWeight: '600' },
  modalSave:      { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:  { color: '#fff', fontWeight: '700' },
});
