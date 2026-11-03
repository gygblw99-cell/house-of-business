import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, Alert,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function RecipesScreen({ navigation }) {
  const [recipes, setRecipes] = useState([]);
  const [search,  setSearch]  = useState('');
  const [tab,     setTab]     = useState('all'); // all | low | high
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getRecipes();
      setRecipes(data);
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = recipes.filter(r => {
    if (!r.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (tab === 'low')  return parseFloat(r.margin) < 30;
    if (tab === 'high') return parseFloat(r.margin) >= 60;
    return true;
  });

  const marginColor = (margin) => {
    const m = parseFloat(margin);
    if (m >= 60) return '#10B981';
    if (m >= 30) return '#F59E0B';
    return '#EF4444';
  };

  return (
    <View style={s.container}>
      <ScreenHeader
        title="מתכונים"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      <TextInput
        style={s.search}
        placeholder="חיפוש מתכון..."
        placeholderTextColor="#6B7280"
        value={search}
        onChangeText={setSearch}
        textAlign="right"
      />

      <View style={s.tabs}>
        {[
          { key: 'all',  label: 'הכל' },
          { key: 'low',  label: 'רווח נמוך' },
          { key: 'high', label: 'רווח גבוה' },
        ].map(t => (
          <TouchableOpacity
            key={t.key}
            style={[s.tab, tab === t.key && s.tabActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[s.tabText, tab === t.key && s.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={i => i.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#6366F1" />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.card}
            onPress={() => navigation.navigate('RecipeDetail', { recipeId: item.id })}
          >
            <View style={s.cardTop}>
              <Text style={s.name}>{item.name}</Text>
              <Text style={[s.margin, { color: marginColor(item.margin) }]}>{item.margin}%</Text>
            </View>
            <View style={s.cardBottom}>
              <Text style={s.price}>מחיר: ₪{parseFloat(item.selling_price).toFixed(2)}</Text>
              <Text style={s.cost}>עלות: ₪{parseFloat(item.cost).toFixed(2)}</Text>
              <Text style={s.profit}>רווח: ₪{parseFloat(item.profit).toFixed(2)}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={!loading && <Text style={s.empty}>אין מתכונים</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  back:            { color: '#6366F1', fontSize: 15 },
  search:          { margin: 16, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 15 },
  tabs:            { flexDirection: 'row', marginHorizontal: 16, gap: 8, marginBottom: 8 },
  tab:             { flex: 1, backgroundColor: '#1E1E2E', borderRadius: 10, padding: 10, alignItems: 'center' },
  tabActive:       { backgroundColor: '#6366F1' },
  tabText:         { color: '#9CA3AF', fontSize: 13 },
  tabTextActive:   { color: '#fff', fontWeight: '600' },
  card:            { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 10 },
  cardTop:         { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  name:            { color: '#F9FAFB', fontSize: 16, fontWeight: '600' },
  margin:          { fontSize: 16, fontWeight: '700' },
  cardBottom:      { flexDirection: 'row', justifyContent: 'space-between' },
  price:           { color: '#9CA3AF', fontSize: 12 },
  cost:            { color: '#9CA3AF', fontSize: 12 },
  profit:          { color: '#10B981', fontSize: 12, fontWeight: '600' },
  empty:           { color: '#6B7280', textAlign: 'center', marginTop: 40 },
});
