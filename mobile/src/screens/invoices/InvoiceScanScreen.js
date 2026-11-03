import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, ScrollView, Image,
} from 'react-native';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import api, { loadToken } from '../../services/api';
import { getApiUrl } from '../../config';
import ScreenHeader from '../../components/ScreenHeader';

export default function InvoiceScanScreen({ navigation }) {
  const [images,    setImages]    = useState([]);
  const [uploading, setUploading] = useState(false);
  const [merging,   setMerging]   = useState(false);
  const [result,    setResult]    = useState(null);

  const pickImage = (useCamera) => {
    const fn = useCamera ? launchCamera : launchImageLibrary;
    fn(
      { mediaType: 'photo', quality: 0.8, selectionLimit: 5 - images.length },
      (res) => {
        if (res.didCancel || res.errorCode) return;
        const newImgs = res.assets || [];
        setImages(prev => [...prev, ...newImgs]);
      }
    );
  };

  const handleConfirmMerge = async (tempFiles, merge) => {
    setMerging(true);
    try {
      const merged = await api.post('/invoices/upload/confirm-merge', { tempFiles, merge });
      setResult(merged);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally {
      setMerging(false);
    }
  };

  const handleUpload = async () => {
    if (!images.length) { Alert.alert('שגיאה', 'יש לצלם לפחות תמונה אחת'); return; }

    setUploading(true);
    try {
      const formData = new FormData();
      images.forEach((img, i) => {
        formData.append('images', {
          uri:  img.uri,
          type: img.type || 'image/jpeg',
          name: img.fileName || `invoice_${i}.jpg`,
        });
      });

      // Must go through the shared loadToken() (Keychain-first, AsyncStorage
      // fallback) — reading AsyncStorage directly breaks as soon as any other
      // screen has made an API call, since api.js migrates the token into
      // Keychain and deletes the AsyncStorage copy on first use.
      const [token, baseUrl] = await Promise.all([
        loadToken(),
        getApiUrl(),
      ]);

      const res = await fetch(`${baseUrl}/invoices/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `שגיאת שרת ${res.status}`);
      }

      if (data.status === 'multipage_confirm_required') {
        Alert.alert(
          'חשבונית מרובת עמודים',
          `זוהו ${data.pagesCount} עמודים. לאחד לחשבונית אחת?`,
          [
            {
              text: 'כל עמוד בנפרד',
              onPress: () => handleConfirmMerge(data.tempFiles, false),
            },
            {
              text: 'חשבונית אחת',
              onPress: () => handleConfirmMerge(data.tempFiles, true),
            },
          ]
        );
      } else {
        setResult(data);
      }
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally {
      setUploading(false);
    }
  };

  if (result) {
    // processInvoice may return { invoice: {...} } or flat object
    const inv = result?.invoice || result?.invoices?.[0] || result;
    return (
      <View style={s.container}>
        <ScreenHeader title="חשבונית זוהתה" />
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <View style={s.resultCard}>
            <Text style={s.resultTitle}>✅ חשבונית עובדה בהצלחה</Text>
            <Text style={s.resultLabel}>ספק: <Text style={s.resultVal}>{inv.supplier_name || 'לא מזוהה'}</Text></Text>
            <Text style={s.resultLabel}>סכום: <Text style={s.resultVal}>₪{parseFloat(inv.total_amount || 0).toFixed(2)}</Text></Text>
            <Text style={s.resultLabel}>תאריך: <Text style={s.resultVal}>{inv.invoice_date || '—'}</Text></Text>
            <Text style={s.resultLabel}>פריטים: <Text style={s.resultVal}>{inv.items?.length || 0}</Text></Text>
          </View>
          <TouchableOpacity style={s.doneBtn} onPress={() => navigation.goBack()}>
            <Text style={s.doneBtnText}>סיום</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <ScreenHeader
        title="סריקת חשבונית"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.previewGrid}>
          {images.map((img, i) => (
            <View key={i} style={s.imgWrap}>
              <Image source={{ uri: img.uri }} style={s.preview} />
              <TouchableOpacity
                style={s.removeImg}
                onPress={() => setImages(prev => prev.filter((_, j) => j !== i))}
              >
                <Text style={s.removeImgText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {images.length < 5 && (
          <View style={s.btnRow}>
            <TouchableOpacity style={s.addBtn} onPress={() => pickImage(true)}>
              <Text style={s.addBtnText}>📷 צלם</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.addBtn} onPress={() => pickImage(false)}>
              <Text style={s.addBtnText}>🖼️ גלריה</Text>
            </TouchableOpacity>
          </View>
        )}

        {images.length > 0 && (
          <TouchableOpacity
            style={[s.uploadBtn, (uploading || merging) && s.uploadDisabled]}
            onPress={handleUpload}
            disabled={uploading || merging}
          >
            {uploading || merging
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.uploadBtnText}>העלה ועבד ({images.length} תמונות)</Text>
            }
          </TouchableOpacity>
        )}

        <Text style={s.hint}>ניתן לצלם עד 5 תמונות לחשבונית מרובת עמודים</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0F0F1A' },
  back:           { color: '#6366F1', fontSize: 15 },
  previewGrid:    { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  imgWrap:        { position: 'relative' },
  preview:        { width: 100, height: 130, borderRadius: 8 },
  removeImg:      { position: 'absolute', top: -8, right: -8, backgroundColor: '#EF4444', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  removeImgText:  { color: '#fff', fontWeight: '700', fontSize: 12 },
  btnRow:         { flexDirection: 'row', gap: 12, marginBottom: 20 },
  addBtn:         { flex: 1, backgroundColor: '#1E1E2E', borderRadius: 12, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#374151', borderStyle: 'dashed' },
  addBtnText:     { color: '#F9FAFB', fontSize: 15 },
  uploadBtn:      { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 16 },
  uploadDisabled: { opacity: 0.6 },
  uploadBtnText:  { color: '#fff', fontWeight: '700', fontSize: 16 },
  hint:           { color: '#6B7280', fontSize: 12, textAlign: 'center' },
  resultCard:     { backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, marginBottom: 20 },
  resultTitle:    { color: '#10B981', fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  resultLabel:    { color: '#9CA3AF', fontSize: 15, marginBottom: 8, textAlign: 'right' },
  resultVal:      { color: '#F9FAFB', fontWeight: '600' },
  doneBtn:        { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center' },
  doneBtnText:    { color: '#fff', fontWeight: '700', fontSize: 16 },
});
