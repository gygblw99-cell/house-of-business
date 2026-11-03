import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

export default function RecipeDetailScreen({ navigation, route }) {
  const { recipeId } = route.params;
  const [recipe, setRecipe] = useState(null);

  useEffect(() => {
    api.getRecipe(recipeId)
      .then(setRecipe)
      .catch(err => Alert.alert('שגיאה', err.message));
  }, [recipeId]);

  if (!recipe) return null;

  const sellingPrice = parseFloat(recipe.selling_price) || 0;
  const margin = sellingPrice > 0 ? parseFloat(recipe.profit) / sellingPrice * 100 : 0;
  const marginColor = margin >= 60 ? '#10B981' : margin >= 30 ? '#F59E0B' : '#EF4444';

  return (
    <View style={s.container}>
      <ScreenHeader
        title={recipe.name}
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.summaryCard}>
          <View style={s.summaryItem}>
            <Text style={s.summaryVal}>₪{parseFloat(recipe.selling_price).toFixed(2)}</Text>
            <Text style={s.summaryLabel}>מחיר מכירה</Text>
          </View>
          <View style={s.summaryItem}>
            <Text style={s.summaryVal}>₪{parseFloat(recipe.cost || 0).toFixed(2)}</Text>
            <Text style={s.summaryLabel}>עלות חומרים</Text>
          </View>
          <View style={s.summaryItem}>
            <Text style={[s.summaryVal, { color: marginColor }]}>{margin.toFixed(1)}%</Text>
            <Text style={s.summaryLabel}>מרווח</Text>
          </View>
        </View>

        <View style={s.profitBar}>
          <Text style={s.profitLabel}>רווח למנה: <Text style={[s.profitVal, { color: marginColor }]}>₪{parseFloat(recipe.profit || 0).toFixed(2)}</Text></Text>
          <View style={s.barOuter}>
            <View style={[s.barInner, { width: `${Math.min(margin, 100)}%`, backgroundColor: marginColor }]} />
          </View>
        </View>

        {recipe.ingredients?.length > 0 && (
          <>
            <Text style={s.sectionTitle}>מרכיבים</Text>
            {recipe.ingredients.map((ing, i) => (
              <View key={i} style={s.ingredientRow}>
                <Text style={s.ingCost}>₪{parseFloat(ing.line_cost || 0).toFixed(2)}</Text>
                <View style={s.ingMid}>
                  <Text style={s.ingName}>{ing.item_name}</Text>
                  <Text style={s.ingQty}>{ing.qty} {ing.unit || ''}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:     { flex: 1, backgroundColor: '#0F0F1A' },
  back:          { color: '#6366F1', fontSize: 15 },
  summaryCard:   { flexDirection: 'row', backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, marginBottom: 16 },
  summaryItem:   { flex: 1, alignItems: 'center' },
  summaryVal:    { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  summaryLabel:  { color: '#6B7280', fontSize: 11, marginTop: 4 },
  profitBar:     { backgroundColor: '#1E1E2E', borderRadius: 14, padding: 16, marginBottom: 20 },
  profitLabel:   { color: '#9CA3AF', fontSize: 14, textAlign: 'right', marginBottom: 10 },
  profitVal:     { fontWeight: '700' },
  barOuter:      { height: 8, backgroundColor: '#374151', borderRadius: 4, overflow: 'hidden' },
  barInner:      { height: '100%', borderRadius: 4 },
  sectionTitle:  { color: '#9CA3AF', fontSize: 13, fontWeight: '600', marginBottom: 12, textAlign: 'right' },
  ingredientRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 10, padding: 12, marginBottom: 8 },
  ingMid:        { flex: 1, marginRight: 12 },
  ingName:       { color: '#F9FAFB', fontSize: 14, textAlign: 'right' },
  ingQty:        { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 2 },
  ingCost:       { color: '#6366F1', fontSize: 14, fontWeight: '600', minWidth: 60, textAlign: 'center' },
});
