import React, { useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { fetchNotifications, markRead, markAllRead } from '../../store/slices/notificationsSlice';
import ScreenHeader from '../../components/ScreenHeader';

const TYPE_ICONS = {
  inventory: '📦', audit: '📊', order: '🛒', shift: '👤',
  invoice: '🧾', finance: '💰', manual: '📢', default: '🔔',
};

export default function NotificationsScreen({ navigation }) {
  const dispatch = useDispatch();
  const { items } = useSelector(s => s.notifications);

  useEffect(() => { dispatch(fetchNotifications()); }, []);

  const handleMarkAll = () => dispatch(markAllRead());

  return (
    <View style={s.container}>
      <ScreenHeader
        title="התראות"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        right={
          <TouchableOpacity onPress={handleMarkAll}>
            <Text style={s.markAllBtn}>סמן הכל כנקרא</Text>
          </TouchableOpacity>
        }
      />

      <FlatList
        data={items}
        keyExtractor={i => String(i.id)}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[s.card, !item.is_read && s.cardUnread]}
            onPress={() => dispatch(markRead(item.id))}
          >
            <Text style={s.icon}>{TYPE_ICONS[item.type] || TYPE_ICONS.default}</Text>
            <View style={s.content}>
              <Text style={[s.title, !item.is_read && s.titleUnread]}>{item.title}</Text>
              <Text style={s.body}>{item.body}</Text>
              <Text style={s.time}>
                {new Date(item.created_at).toLocaleString('he-IL', {
                  day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </Text>
            </View>
            {!item.is_read && <View style={s.dot} />}
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={s.empty}>אין התראות</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#0F0F1A' },
  back:       { color: '#6366F1', fontSize: 15 },
  markAllBtn: { color: '#6366F1', fontSize: 12 },
  card:       { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, marginBottom: 8, gap: 12 },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: '#6366F1' },
  icon:       { fontSize: 24 },
  content:    { flex: 1 },
  title:      { color: '#9CA3AF', fontSize: 14, fontWeight: '500', textAlign: 'right', marginBottom: 4 },
  titleUnread:{ color: '#F9FAFB', fontWeight: '700' },
  body:       { color: '#D1D5DB', fontSize: 13, textAlign: 'right', lineHeight: 18 },
  time:       { color: '#6B7280', fontSize: 11, textAlign: 'right', marginTop: 6 },
  dot:        { width: 8, height: 8, borderRadius: 4, backgroundColor: '#6366F1', marginTop: 4 },
  empty:      { color: '#6B7280', textAlign: 'center', marginTop: 40 },
});
