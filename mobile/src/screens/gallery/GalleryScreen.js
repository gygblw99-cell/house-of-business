import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Image, RefreshControl, Modal,
} from 'react-native';
import api, { getCachedImgToken, withImgToken } from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const CATEGORIES = ['הכל', 'חשבוניות', 'משימות', 'מתכונים', 'אחר'];
const CATEGORY_MAP = { 'הכל': '', 'חשבוניות': 'invoice', 'משימות': 'task', 'מתכונים': 'recipe', 'אחר': 'other' };

export default function GalleryScreen({ navigation }) {
  const [items,    setItems]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [category, setCategory] = useState('הכל');
  const [selected, setSelected] = useState(null);
  const [imgToken, setImgToken] = useState(null);

  useEffect(() => {
    getCachedImgToken(api).then(setImgToken).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cat = CATEGORY_MAP[category];
      const data = await api.getGallery(cat ? { category: cat } : {});
      setItems(Array.isArray(data) ? data : (data.images || data.files || []));
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, [category]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = (id) => {
    Alert.alert('מחיקת תמונה', 'האם למחוק תמונה זו?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'מחק', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteGalleryItem(id);
            setItems(prev => prev.filter(i => i.id !== id));
            setSelected(null);
          } catch (err) { Alert.alert('שגיאה', err.message); }
        },
      },
    ]);
  };

  const NUM_COLS = 3;

  return (
    <View style={s.container}>
      <ScreenHeader
        title="גלריה"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      {/* פילטר קטגוריות */}
      <View style={s.categoryRow}>
        {CATEGORIES.map(cat => (
          <TouchableOpacity
            key={cat}
            style={[s.catBtn, category === cat && s.catBtnActive]}
            onPress={() => setCategory(cat)}
          >
            <Text style={[s.catText, category === cat && s.catTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => String(i.id)}
          numColumns={NUM_COLS}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 4 }}
          ListHeaderComponent={
            <Text style={s.count}>{items.length} תמונות</Text>
          }
          ListEmptyComponent={<Text style={s.empty}>אין תמונות בקטגוריה זו</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.thumb} onPress={() => setSelected(item)}>
              {item.url || item.image_url ? (
                <Image source={{ uri: item.url || item.image_url }} style={s.thumbImg} />
              ) : (
                <View style={s.thumbPlaceholder}>
                  <Text style={s.thumbIcon}>
                    {item.entity_type === 'invoice' ? '🧾' :
                     item.entity_type === 'task'    ? '✅' :
                     item.entity_type === 'recipe'  ? '🍽️' : '🖼️'}
                  </Text>
                </View>
              )}
              {item.entity_type && (
                <View style={s.thumbBadge}>
                  <Text style={s.thumbBadgeText}>{item.entity_type}</Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        />
      )}

      {/* Modal תצוגת תמונה */}
      <Modal visible={!!selected} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <TouchableOpacity style={s.modalClose} onPress={() => setSelected(null)}>
            <Text style={s.modalCloseText}>✕</Text>
          </TouchableOpacity>
          {selected && (selected.url || selected.image_url) ? (
            <Image
              source={{ uri: selected.url || selected.image_url }}
              style={s.fullImage}
              resizeMode="contain"
            />
          ) : (
            <View style={s.noImageWrap}>
              <Text style={s.noImageText}>אין תצוגה מקדימה</Text>
            </View>
          )}
          {selected && (
            <View style={s.modalMeta}>
              {selected.entity_type && <Text style={s.modalMetaText}>קטגוריה: {selected.entity_type}</Text>}
              {selected.created_at && (
                <Text style={s.modalMetaText}>
                  {new Date(selected.created_at).toLocaleDateString('he-IL')}
                </Text>
              )}
              <TouchableOpacity style={s.deleteBtn} onPress={() => handleDelete(selected.id)}>
                <Text style={s.deleteBtnText}>🗑️ מחק תמונה</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#0F0F1A' },
  back:             { color: '#6366F1', fontSize: 15 },
  categoryRow:      { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 10, gap: 6, flexWrap: 'wrap' },
  catBtn:           { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1E1E2E' },
  catBtnActive:     { backgroundColor: '#6366F1' },
  catText:          { color: '#9CA3AF', fontSize: 12, fontWeight: '600' },
  catTextActive:    { color: '#fff' },
  count:            { color: '#6B7280', fontSize: 12, textAlign: 'right', padding: 8 },
  empty:            { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  thumb:            { flex: 1/3, margin: 2, aspectRatio: 1, borderRadius: 8, overflow: 'hidden', backgroundColor: '#1E1E2E' },
  thumbImg:         { width: '100%', height: '100%' },
  thumbPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbIcon:        { fontSize: 32 },
  thumbBadge:       { position: 'absolute', bottom: 2, left: 2, backgroundColor: '#00000066', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  thumbBadgeText:   { color: '#fff', fontSize: 9 },
  modalOverlay:     { flex: 1, backgroundColor: '#000000EE', justifyContent: 'center', alignItems: 'center' },
  modalClose:       { position: 'absolute', top: 50, right: 20, zIndex: 10 },
  modalCloseText:   { color: '#fff', fontSize: 28, fontWeight: '700' },
  fullImage:        { width: '95%', height: '70%' },
  noImageWrap:      { width: '95%', height: '70%', alignItems: 'center', justifyContent: 'center' },
  noImageText:      { color: '#6B7280', fontSize: 16 },
  modalMeta:        { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center', gap: 8 },
  modalMetaText:    { color: '#9CA3AF', fontSize: 13 },
  deleteBtn:        { backgroundColor: '#EF444422', borderRadius: 12, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: '#EF4444' },
  deleteBtnText:    { color: '#EF4444', fontWeight: '700' },
});
