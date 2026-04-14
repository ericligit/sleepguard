/**
 * HomeScreen — main screen with:
 *   • Start / Stop recording button
 *   • Live waveform + elapsed timer while recording
 *   • Flat list of past sessions
 */

import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useAudioRecording} from '../hooks/useAudioRecording';
import {WaveformView} from '../components/WaveformView';
import {SessionCard} from '../components/SessionCard';
import {getAllSessions} from '../services/database';
import type {RootStackParamList, SleepSession} from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
};

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

export const HomeScreen: React.FC<Props> = ({navigation}) => {
  const {
    isRecording,
    elapsedSeconds,
    currentAmplitude,
    amplitudeHistory,
    startRecording,
    stopRecording,
  } = useAudioRecording();

  const [sessions, setSessions] = useState<SleepSession[]>([]);
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAllSessions();
      setSessions(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions, isRecording]); // refresh list after recording stops

  const handleToggle = async () => {
    try {
      if (isRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      Alert.alert('Recording Error', msg);
    }
  };

  const handleSessionPress = (sessionId: string) =>
    navigation.navigate('SessionDetail', {sessionId});

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0D1B2A" />

      {/* ── Header ────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.title}>SleepGuard</Text>
        <Text style={styles.subtitle}>AI Sleep Apnea Monitor</Text>
      </View>

      {/* ── Live recording panel ──────────────────────────────────────── */}
      <View style={styles.recordingPanel}>
        {isRecording && (
          <>
            <Text style={styles.timer}>{formatElapsed(elapsedSeconds)}</Text>
            <WaveformView
              amplitudes={amplitudeHistory}
              width={320}
              height={72}
            />
            <View style={styles.ampRow}>
              <View
                style={[
                  styles.ampIndicator,
                  {
                    width: `${(currentAmplitude * 100).toFixed(0)}%` as unknown as number,
                    backgroundColor:
                      currentAmplitude > 0.85 ? '#EF5350' : '#4FC3F7',
                  },
                ]}
              />
            </View>
            <Text style={styles.recordingHint}>Recording — keep phone face-down near you</Text>
          </>
        )}

        <TouchableOpacity
          style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
          onPress={handleToggle}
          activeOpacity={0.8}>
          <Text style={styles.recordBtnText}>
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </Text>
        </TouchableOpacity>

        {!isRecording && (
          <Text style={styles.disclaimer}>
            For wellness screening only — not a medical device.
          </Text>
        )}
      </View>

      {/* ── Session history ───────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Past Sessions</Text>

      {loading ? (
        <ActivityIndicator color="#4FC3F7" style={{marginTop: 24}} />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={s => s.id}
          renderItem={({item}) => (
            <SessionCard
              session={item}
              onPress={() => handleSessionPress(item.id)}
            />
          )}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No sessions yet. Start recording tonight!</Text>
          }
          onRefresh={loadSessions}
          refreshing={loading}
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#0D1B2A'},
  header: {paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8},
  title: {color: '#FFFFFF', fontSize: 26, fontWeight: '700', letterSpacing: -0.5},
  subtitle: {color: '#4FC3F7', fontSize: 14, marginTop: 2},

  recordingPanel: {
    backgroundColor: '#122040',
    borderRadius: 16,
    margin: 16,
    padding: 20,
    alignItems: 'center',
    gap: 12,
  },
  timer: {
    color: '#FFFFFF',
    fontSize: 40,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    letterSpacing: 2,
  },
  ampRow: {
    width: '100%',
    height: 4,
    backgroundColor: '#1E3A5F',
    borderRadius: 2,
    overflow: 'hidden',
  },
  ampIndicator: {height: '100%', borderRadius: 2},
  recordingHint: {color: '#78909C', fontSize: 12},

  recordBtn: {
    backgroundColor: '#1565C0',
    borderRadius: 40,
    paddingVertical: 16,
    paddingHorizontal: 48,
    width: '100%',
    alignItems: 'center',
  },
  recordBtnActive: {backgroundColor: '#B71C1C'},
  recordBtnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '700'},

  disclaimer: {color: '#455A64', fontSize: 11, textAlign: 'center'},

  sectionTitle: {
    color: '#90A4AE',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginHorizontal: 20,
    marginBottom: 4,
  },
  list: {paddingHorizontal: 16, paddingBottom: 32},
  emptyText: {color: '#455A64', textAlign: 'center', marginTop: 24, fontSize: 14},
});
