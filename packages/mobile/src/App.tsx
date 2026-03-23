import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { GHOST_NORM } from '@devghost/shared';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>DevGhost</Text>
      <Text style={styles.subtitle}>
        Code output analytics — Ghost Norm: {GHOST_NORM}h/day
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
});
