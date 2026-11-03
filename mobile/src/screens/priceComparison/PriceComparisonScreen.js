import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, TextInput, Linking,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function PriceComparisonScreen({ navigation }) {
  const [query,       setQuery]       = useState('');
  const [results,     setResults]     = useState(null);
  const [history,     setHistory]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [histLoading, setHistLoading] = useState(true);

  const loadHistory = useCallback(() => {
    api.getPriceHistory()
      .then(data => setHistory(Array.isArray(data) ? data : (data.history || [])))
      .catch(() => {})
      .finally(() => setHistLoading(false));
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResults(null);
    try {
      const res = await api.comparePrices(query.trim());
      setResults(res);
      loadHistory();
    } catch (err) { Alert.alert('שגיאה', err.message); }
    finally { setLoading(false); }
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('he-IL') : '';

  return (
    <View style={s.container}>
      <ScreenHeader
        title="השוואת מחירים"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />

      {/* חיפוש */}
      <View style={s.searchRow}>
        <TouchableOpacity style={s.searchBtn} onPress={handleSearch} disabled={loading || !query.trim()}>
          <Text style={s.searchBtnText}>חפש</Text>
        </TouchableOpacity>
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="למשל: שמן זית ליטר..."
          placeholderTextColor="#6B7280"
          textAlign="right"
          returnKeyType="search"
          onSubmitEditing={handleSearch}
          autoFocus
        />
      </View>

      {loading && (
        <View style={s.loadingWrap}>
          <ActivityIndicator color="#6366F1" size="large" />
          <Text style={s.loadingText}>סורק 9 מקורות ברשת...</Text>
          <Text style={[s.loadingText, { fontSize: 12 }]}>גוגל שופינג · ספקים ישראליים · שווקים · סופרמרקטים</Text>
        </View>
      )}

      {results && !loading && (
        <FlatList
          data={[1]}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          renderItem={() => (
            <>
              {/* המחיר הזול ביותר */}
              {results.cheapestPrice ? (
                <View style={s.cheapCard}>
                  <Text style={s.cheapLabel}>✅ המחיר הזול ביותר שנמצא</Text>
                  <Text style={s.cheapPrice}>{results.cheapestPrice.price}</Text>
                  <Text style={s.cheapSource}>{results.cheapestPrice.source}</Text>
                  {results.cheapestPrice.note ? (
                    <Text style={s.cheapNote}>{results.cheapestPrice.note}</Text>
                  ) : null}
                  {results.priceRange?.min ? (
                    <Text style={s.cheapRange}>
                      טווח מחירים: {results.priceRange.min} – {results.priceRange.max} {results.priceRange.unit || ''}
                    </Text>
                  ) : null}
                  {results.cheapestPrice.link ? (
                    <TouchableOpacity onPress={() => Linking.openURL(results.cheapestPrice.link)}>
                      <Text style={s.cheapLink}>פתח באתר ↗</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : (
                <View style={s.aiCard}>
                  <Text style={[s.aiText, { color: '#FCD34D' }]}>⚠️ {results.summary || 'לא נמצאו מחירים ברורים'}</Text>
                </View>
              )}

              {/* סיכום AI */}
              {results.summary && results.cheapestPrice ? (
                <View style={s.aiCard}>
                  <Text style={s.aiTitle}>🤖 תובנת AI</Text>
                  <Text style={s.aiText}>{results.summary}</Text>
                </View>
              ) : null}

              {/* תובנות שוק למסעדה */}
              {results.marketInsight && Object.values(results.marketInsight).some(Boolean) ? (
                <View style={s.insightCard}>
                  <Text style={s.insightTitle}>📊 תובנות שוק למסעדה</Text>
                  {results.marketInsight.typicalRestaurantCost ? (
                    <View style={s.insightRow}>
                      <Text style={s.insightVal}>{results.marketInsight.typicalRestaurantCost}</Text>
                      <Text style={s.insightKey}>עלות טיפוסית למסעדה</Text>
                    </View>
                  ) : null}
                  {results.marketInsight.portionCost ? (
                    <View style={s.insightRow}>
                      <Text style={[s.insightVal, { color: '#34D399' }]}>{results.marketInsight.portionCost}</Text>
                      <Text style={s.insightKey}>עלות ממוצעת למנה</Text>
                    </View>
                  ) : null}
                  {results.marketInsight.bestBuyingStrategy ? (
                    <Text style={s.insightStrategy}>{results.marketInsight.bestBuyingStrategy}</Text>
                  ) : null}
                  {results.marketInsight.seasonalNote ? (
                    <Text style={s.insightSeasonal}>⭐ {results.marketInsight.seasonalNote}</Text>
                  ) : null}
                </View>
              ) : null}

              {/* ספקים שנמצאו */}
              {results.suppliers?.length > 0 ? (
                <>
                  <Text style={s.sectionTitle}>ספקים שנמצאו ({results.suppliers.length})</Text>
                  {results.suppliers.map((sup, i) => (
                    <View key={i} style={s.resultCard}>
                      <View style={s.resultTop}>
                        <Text style={s.resultName}>{sup.name}</Text>
                        {sup.price ? <Text style={s.resultPrice}>{sup.price}</Text> : null}
                      </View>
                      {sup.type ? <Text style={s.resultType}>{sup.type}</Text> : null}
                      {sup.source ? <Text style={s.resultSource}>מקור: {sup.source}</Text> : null}
                      {sup.minOrder ? <Text style={s.resultMin}>מינימום: {sup.minOrder}</Text> : null}
                      {sup.link ? (
                        <TouchableOpacity onPress={() => Linking.openURL(sup.link)}>
                          <Text style={s.resultLink}>כנס לאתר ↗</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ))}
                </>
              ) : null}

              {/* ספקי מזון ישראליים ידועים */}
              {results.knownIsraeliSuppliers?.length > 0 ? (
                <>
                  <Text style={s.sectionTitle}>ספקי מזון סיטונאיים בישראל</Text>
                  {results.knownIsraeliSuppliers.map((sup, i) => (
                    <TouchableOpacity key={i} style={[s.knownCard, sup.recommended && s.knownCardRec]}
                      onPress={() => Linking.openURL(`https://${sup.domain}`)}>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.knownName, sup.recommended && { color: '#34D399' }]}>
                          {sup.recommended ? '★ ' : ''}{sup.name}
                        </Text>
                        <Text style={s.knownType}>{sup.type}</Text>
                      </View>
                      <Text style={s.knownLink}>↗</Text>
                    </TouchableOpacity>
                  ))}
                </>
              ) : null}
            </>
          )}
        />
      )}

      {!results && !loading && (
        <>
          <Text style={s.sectionTitle}>חיפושים קודמים</Text>
          {histLoading ? (
            <ActivityIndicator color="#6366F1" style={{ marginTop: 20 }} />
          ) : history.length === 0 ? (
            <Text style={s.empty}>חפש מוצר להשוואת מחירים ברשת</Text>
          ) : (
            <FlatList
              data={history}
              keyExtractor={(h, i) => String(h.id || i)}
              contentContainerStyle={{ padding: 16, gap: 8 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.histCard} onPress={() => setQuery(item.search_query || '')}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.histQuery}>{item.search_query}</Text>
                    {item.result_data?.cheapestPrice?.price ? (
                      <Text style={s.histPrice}>
                        {item.result_data.cheapestPrice.price} · {item.result_data.cheapestPrice.source}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={s.histDate}>{fmtDate(item.created_at)}</Text>
                </TouchableOpacity>
              )}
            />
          )}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:     { flex: 1, backgroundColor: '#0F0F1A' },
  back:          { color: '#6366F1', fontSize: 15 },
  searchRow:     { flexDirection: 'row', margin: 16, gap: 10 },
  searchInput:   { flex: 1, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 12, fontSize: 14 },
  searchBtn:     { backgroundColor: '#6366F1', borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  searchBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  loadingWrap:   { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText:   { color: '#9CA3AF', fontSize: 14, textAlign: 'center' },
  sectionTitle:  { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginHorizontal: 16, marginTop: 8, marginBottom: 4, textAlign: 'right' },
  empty:         { color: '#6B7280', textAlign: 'center', marginTop: 40, fontSize: 15 },

  cheapCard:   { backgroundColor: '#0B2515', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#065F46' },
  cheapLabel:  { color: '#34D399', fontSize: 12, fontWeight: '700', textAlign: 'right', marginBottom: 6 },
  cheapPrice:  { color: '#10B981', fontSize: 28, fontWeight: '900', textAlign: 'right' },
  cheapSource: { color: '#D1D5DB', fontSize: 13, textAlign: 'right', marginTop: 2 },
  cheapNote:   { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 4 },
  cheapRange:  { color: '#6B7280', fontSize: 11, textAlign: 'right', marginTop: 4 },
  cheapLink:   { color: '#60A5FA', fontSize: 13, textAlign: 'right', marginTop: 8, textDecorationLine: 'underline' },

  aiCard:  { backgroundColor: '#1A1A2E', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#6366F1' },
  aiTitle: { color: '#6366F1', fontSize: 13, fontWeight: '700', textAlign: 'right', marginBottom: 6 },
  aiText:  { color: '#D1D5DB', fontSize: 13, textAlign: 'right', lineHeight: 20 },

  insightCard:     { backgroundColor: '#0C1E2E', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#1E40AF' },
  insightTitle:    { color: '#38BDF8', fontSize: 13, fontWeight: '700', textAlign: 'right', marginBottom: 10 },
  insightRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  insightKey:      { color: '#9CA3AF', fontSize: 12 },
  insightVal:      { color: '#38BDF8', fontSize: 15, fontWeight: '700' },
  insightStrategy: { color: '#E8E8E4', fontSize: 12, textAlign: 'right', lineHeight: 18, marginTop: 4 },
  insightSeasonal: { color: '#FCD34D', fontSize: 12, textAlign: 'right', marginTop: 4 },

  resultCard:   { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 14, gap: 4 },
  resultTop:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  resultName:   { color: '#F9FAFB', fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'right' },
  resultPrice:  { color: '#C9A227', fontSize: 18, fontWeight: '700' },
  resultType:   { color: '#6366F1', fontSize: 11, textAlign: 'right' },
  resultSource: { color: '#6B7280', fontSize: 11, textAlign: 'right' },
  resultMin:    { color: '#9CA3AF', fontSize: 11, textAlign: 'right' },
  resultLink:   { color: '#60A5FA', fontSize: 12, textAlign: 'right', textDecorationLine: 'underline' },

  knownCard:    { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#2D2D3E' },
  knownCardRec: { borderColor: '#065F46', backgroundColor: '#0B2515' },
  knownName:    { color: '#F9FAFB', fontSize: 13, fontWeight: '600', textAlign: 'right' },
  knownType:    { color: '#6B7280', fontSize: 11, textAlign: 'right' },
  knownLink:    { color: '#C9A227', fontSize: 18 },

  histCard:     { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, alignItems: 'flex-start' },
  histQuery:    { color: '#F9FAFB', fontSize: 14, textAlign: 'right' },
  histPrice:    { color: '#10B981', fontSize: 12, textAlign: 'right', marginTop: 3 },
  histDate:     { color: '#6B7280', fontSize: 12 },
});
