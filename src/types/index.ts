// ─── Session ─────────────────────────────────────────────────────────────────

export type ApneaSeverity = 'normal' | 'mild' | 'moderate' | 'severe';

export interface SleepSession {
  id: string;
  startedAt: number;       // Unix ms
  endedAt: number | null;
  durationSeconds: number;
  filePath: string;
  fileSizeBytes: number;
  ahi: number | null;      // calculated post-processing
  severity: ApneaSeverity | null;
  apneaCount: number;
  hypopneaCount: number;
  longestApneaSec: number;
  spo2Min: number | null;  // from Health Connect, if available
  spo2Avg: number | null;
  notes: string;
}

// ─── Audio events ─────────────────────────────────────────────────────────────

export type AudioEventType =
  | 'snoring'
  | 'cessation'      // snoring stops — potential apnea start
  | 'gasping'
  | 'recovery'
  | 'ambient';

export interface AudioEvent {
  id: string;
  sessionId: string;
  type: AudioEventType;
  startOffsetSec: number;  // seconds from session start
  durationSec: number;
  confidence: number;      // 0–1
}

// ─── Recording state ──────────────────────────────────────────────────────────

export interface RecordingState {
  isRecording: boolean;
  sessionId: string | null;
  outputPath: string | null;
  elapsedSeconds: number;
  currentAmplitude: number;   // normalised 0–1
  amplitudeHistory: number[]; // last N normalised samples for waveform
}

// ─── Health Connect ──────────────────────────────────────────────────────────

export interface SpO2Sample {
  timestamp: number;   // Unix ms
  value: number;       // percentage 0–100
}

// ─── Navigation ──────────────────────────────────────────────────────────────

export type RootStackParamList = {
  Home: undefined;
  SessionDetail: { sessionId: string };
  Settings: undefined;
};
