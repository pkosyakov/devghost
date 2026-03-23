import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import type { OrderSummary } from '@devghost/shared';

interface OrderListScreenProps {
  orders: OrderSummary[];
  onSelect: (id: string) => void;
}

export function OrderListScreen({ orders, onSelect }: OrderListScreenProps) {
  return (
    <FlatList
      data={orders}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <TouchableOpacity style={styles.card} onPress={() => onSelect(item.id)}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.status}>{item.status}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
  },
  status: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
});
