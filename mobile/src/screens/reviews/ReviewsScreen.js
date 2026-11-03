import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, Modal, TextInput, ScrollView,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

const PLATFORMS = ['Google', 'Wolt', 'Ten-Bis', 'Facebook', 'TripAdvisor', 'אחר'];

const SENTIMENT_COLORS = { חיובי: '#10B981', ניטרלי: '#F59E0B', שלילי: '#EF4444' };

export default function ReviewsScreen({ navigation }) {
  const [batches,   setBatches]   = useState([]);
  const [selected,  setSelected]  = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [showAdd,   setShowAdd]   = useState(false);
  const [platform,  setPlatform]  = useState('Google');
  const [text,      setText]      = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getReviews();
      setBatches(Array.isArray(data) ? data : (data.batches || []));
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAnalyze = async () => {
    if (!text.trim() || text.trim().length < 20) {
      Alert.alert('שגיאה', 'הדבק לפחות 20 תווים של ביקורות');
      return;
    }
    setAnalyzing(true);
    try {
      const res = await api.analyzeReviews({ platform, text });
      Alert.alert('✅ ניתוח הושלם', 'הביקורות נותחו בהצלחה');
      setShowAdd(false);
      setText('');
      load();
      if (res.analysis) setSelected({ ...res, platform, analysis: res.analysis });
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setAnalyzing(false); }
  };

  const handleDelete = (id) => {
    Alert.alert('מחיקה', 'האם למחוק ניתוח זה?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'מחק', style: 'destructive',
        onPress: async () => {
          try { await api.deleteReview(id); load(); }
          catch (err) { Alert.alert('שגיאה', err.message); }
        },
      },
    ]);
  };

  // View — detailed analysis of a batch
  if (selected) {
    const a = selected.analysis || {};
    const sentColor = SENTIMENT_COLORS[a.overallSentiment] || '#9CA3AF';
    return (
      <View style={s.container}>
        <ScreenHeader
          title={`${selected.platform || 'ביקורות'} — ניתוח`}
          left={<TouchableOpacity onPress={() => setSelected(null)}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        />
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
          {/* Overall */}
          <View style={[s.overallCard, { borderTopColor: sentColor }]}>
            <View style={s.overallRow}>
              <View style={[s.sentBadge, { backgroundColor: sentColor + '33' }]}>
                <Text style={[s.sentText, { color: sentColor }]}>{a.overallSentiment || '—'}</Text>
              </View>
              <Text style={s.ratingBig}>{a.averageRating?.toFixed(1) || '—'} ⭐</Text>
            </View>
            <Text style={s.totalReviews}>{a.totalReviews || 0} ביקורות • {selected.platform}</Text>
            {a.summary && <Text style={s.summary}>{a.summary}</Text>}
          </View>

          {/* Strengths */}
          {a.strengths?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>💪 חוזקות</Text>
              {a.strengths.map((str, i) => (
                <View key={i} style={s.bulletRow}>
                  <Text style={s.bulletDot}>✓</Text>
                  <Text style={s.bulletText}>{str}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Issues */}
          {a.issues?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>⚠️ בעיות</Text>
              {a.issues.map((issue, i) => (
                <View key={i} style={[s.issueCard, { borderLeftColor: issue.severity === 'גבוה' ? '#EF4444' : issue.severity === 'בינוני' ? '#F59E0B' : '#6B7280' }]}>
                  <View style={s.issueTop}>
                    <Text style={s.issueCount}>{issue.count}x</Text>
                    <Text style={s.issueTopic}>{issue.topic}</Text>
                  </View>
                  {issue.example && <Text style={s.issueExample}>"{issue.example}"</Text>}
                </View>
              ))}
            </View>
          )}

          {/* Action Items */}
          {a.actionItems?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>💡 פעולות מוצעות</Text>
              {a.actionItems.map((action, i) => (
                <View key={i} style={s.actionCard}>
                  <Text style={s.actionNum}>{i + 1}</Text>
                  <Text style={s.actionText}>{action}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Positive Highlights */}
          {a.positiveHighlights?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>🌟 הדגשות חיוביות</Text>
              {a.positiveHighlights.map((h, i) => (
                <View key={i} style={s.bulletRow}>
                  <Text style={s.bulletDot}>★</Text>
                  <Text style={[s.bulletText, { color: '#10B981' }]}>{h}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Preview */}
          {selected.preview && (
            <View style={s.previewCard}>
              <Text style={s.previewTitle}>טקסט הביקורות</Text>
              <Text style={s.previewText}>{selected.preview}...</Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <ScreenHeader
        title="ניתוח ביקורות AI"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
        right={<TouchableOpacity onPress={() => setShowAdd(true)}><Text style={s.addBtn}>+ נתח</Text></TouchableOpacity>}
      />

      {/* הסבר */}
      <View style={s.explainCard}>
        <Text style={s.explainTitle}>🤖 כיצד זה עובד</Text>
        <Text style={s.explainText}>העתק ביקורות מ-Google / Wolt / Ten-Bis והדבק כאן. ה-AI ינתח sentiment, בעיות חוזרות ויציע פעולות.</Text>
      </View>

      {loading ? (
        <ActivityIndicator color="#6366F1" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={batches}
          keyExtractor={b => String(b.id)}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          ListEmptyComponent={<Text style={s.empty}>אין ניתוחים עדיין. לחץ "+ נתח" להתחיל.</Text>}
          renderItem={({ item }) => {
            const a = item.analysis || {};
            const sentColor = SENTIMENT_COLORS[a.overallSentiment] || '#6B7280';
            return (
              <TouchableOpacity style={s.batchCard} onPress={() => setSelected(item)}>
                <View style={s.batchLeft}>
                  <Text style={s.batchPlatform}>{item.platform}</Text>
                  <Text style={s.batchDate}>{new Date(item.created_at).toLocaleDateString('he-IL')}</Text>
                  {item.preview && <Text style={s.batchPreview} numberOfLines={1}>{item.preview}</Text>}
                </View>
                <View style={s.batchRight}>
                  {a.averageRating && <Text style={s.batchRating}>{a.averageRating.toFixed(1)} ⭐</Text>}
                  {a.overallSentiment && (
                    <View style={[s.sentBadgeSmall, { backgroundColor: sentColor + '33' }]}>
                      <Text style={[s.sentTextSmall, { color: sentColor }]}>{a.overallSentiment}</Text>
                    </View>
                  )}
                  <TouchableOpacity onPress={() => handleDelete(item.id)}>
                    <Text style={s.delBtn}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Modal ניתוח חדש */}
      <Modal visible={showAdd} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>ניתוח ביקורות חדש</Text>
            <Text style={s.modalLabel}>פלטפורמה</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {PLATFORMS.map(p => (
                  <TouchableOpacity
                    key={p}
                    style={[s.platBtn, platform === p && s.platBtnActive]}
                    onPress={() => setPlatform(p)}
                  >
                    <Text style={[s.platText, platform === p && s.platTextActive]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            <Text style={s.modalLabel}>הדבק ביקורות</Text>
            <TextInput
              style={s.textArea}
              value={text}
              onChangeText={setText}
              placeholder="הדבק את ביקורות הלקוחות כאן... (לפחות 20 תווים)"
              placeholderTextColor="#6B7280"
              textAlign="right"
              multiline
              autoFocus
            />
            <Text style={s.charCount}>{text.length} תווים</Text>
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => { setShowAdd(false); setText(''); }}>
                <Text style={s.modalCancelText}>ביטול</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSave} onPress={handleAnalyze} disabled={analyzing || text.length < 20}>
                {analyzing ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.modalSaveText}>🤖 נתח עם AI</Text>}
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
  addBtn:           { color: '#6366F1', fontSize: 15, fontWeight: '700' },
  explainCard:      { marginHorizontal: 16, backgroundColor: '#1A1A2E', borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#374151' },
  explainTitle:     { color: '#6366F1', fontSize: 13, fontWeight: '700', textAlign: 'right', marginBottom: 4 },
  explainText:      { color: '#9CA3AF', fontSize: 12, textAlign: 'right', lineHeight: 18 },
  empty:            { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },
  batchCard:        { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 12, alignItems: 'center' },
  batchLeft:        { flex: 1 },
  batchPlatform:    { color: '#F9FAFB', fontSize: 15, fontWeight: '700', textAlign: 'right' },
  batchDate:        { color: '#6B7280', fontSize: 12, textAlign: 'right', marginTop: 2 },
  batchPreview:     { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 4 },
  batchRight:       { alignItems: 'flex-end', gap: 6 },
  batchRating:      { color: '#F9FAFB', fontSize: 16, fontWeight: '700' },
  sentBadgeSmall:   { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  sentTextSmall:    { fontSize: 11, fontWeight: '700' },
  delBtn:           { fontSize: 16 },
  overallCard:      { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 16, borderTopWidth: 4 },
  overallRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sentBadge:        { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  sentText:         { fontSize: 14, fontWeight: '700' },
  ratingBig:        { color: '#F9FAFB', fontSize: 24, fontWeight: '700' },
  totalReviews:     { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginBottom: 8 },
  summary:          { color: '#D1D5DB', fontSize: 14, textAlign: 'right', lineHeight: 20 },
  section:          { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14 },
  sectionTitle:     { color: '#F9FAFB', fontSize: 14, fontWeight: '700', textAlign: 'right', marginBottom: 10 },
  bulletRow:        { flexDirection: 'row', gap: 8, marginBottom: 6, alignItems: 'flex-start' },
  bulletDot:        { color: '#10B981', fontSize: 14, width: 20 },
  bulletText:       { color: '#D1D5DB', fontSize: 13, flex: 1, textAlign: 'right', lineHeight: 18 },
  issueCard:        { backgroundColor: '#0F0F1A', borderRadius: 10, padding: 12, marginBottom: 8, borderLeftWidth: 3 },
  issueTop:         { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  issueCount:       { color: '#9CA3AF', fontSize: 12 },
  issueTopic:       { color: '#F9FAFB', fontSize: 13, fontWeight: '700', textAlign: 'right' },
  issueExample:     { color: '#6B7280', fontSize: 12, textAlign: 'right', fontStyle: 'italic' },
  actionCard:       { flexDirection: 'row', gap: 10, marginBottom: 8, alignItems: 'flex-start' },
  actionNum:        { color: '#6366F1', fontSize: 16, fontWeight: '700', width: 24 },
  actionText:       { color: '#D1D5DB', fontSize: 13, flex: 1, textAlign: 'right', lineHeight: 18 },
  previewCard:      { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14 },
  previewTitle:     { color: '#6B7280', fontSize: 12, textAlign: 'right', marginBottom: 6 },
  previewText:      { color: '#9CA3AF', fontSize: 12, textAlign: 'right', lineHeight: 18 },
  modalOverlay:     { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  modal:            { backgroundColor: '#1E1E2E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '85%' },
  modalTitle:       { color: '#F9FAFB', fontSize: 18, fontWeight: '700', textAlign: 'right', marginBottom: 16 },
  modalLabel:       { color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginBottom: 8 },
  platBtn:          { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#374151' },
  platBtnActive:    { backgroundColor: '#6366F1' },
  platText:         { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  platTextActive:   { color: '#fff' },
  textArea:         { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 12, padding: 14, fontSize: 14, borderWidth: 1, borderColor: '#374151', height: 160, textAlignVertical: 'top', marginBottom: 4 },
  charCount:        { color: '#374151', fontSize: 11, textAlign: 'left', marginBottom: 14 },
  modalActions:     { flexDirection: 'row', gap: 10 },
  modalCancel:      { flex: 1, backgroundColor: '#374151', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelText:  { color: '#9CA3AF', fontWeight: '600' },
  modalSave:        { flex: 1, backgroundColor: '#6366F1', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalSaveText:    { color: '#fff', fontWeight: '700' },
});
