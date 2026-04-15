/**
 * apneaAnalysis.ts — JS wrapper around the ApneaAnalysis native module.
 *
 * Calls the on-device TFLite inference pipeline and writes results into
 * the SQLite sessions table so SessionDetailScreen can display them.
 */

import {NativeModules} from 'react-native';
import {updateSessionAnalysis, insertEvents} from './database';

const {ApneaAnalysis} = NativeModules;

export interface ApneaEvent {
  type: 'apnea' | 'hypopnea' | 'snoring';
  startOffsetSec: number;
  durationSec: number;
  confidence: number;
}

export interface WindowClassification {
  t: number;
  cls: number;
  label: string;
}

export interface AnalysisResult {
  ahi: number;
  severity: 'none' | 'mild' | 'moderate' | 'severe';
  apneaCount: number;
  hypopneaCount: number;
  durationSeconds: number;
  longestApneaSec: number;
  events: ApneaEvent[];
  windowClassifications: WindowClassification[];
}

export interface AnalysisOptions {
  confidenceThreshold?: number;
}

/**
 * Analyse a WAV recording and persist results to SQLite.
 * Returns the full AnalysisResult so the UI can update immediately.
 */
export async function analyzeAndPersist(
  sessionId: string,
  filePath: string,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  if (!ApneaAnalysis) {
    throw new Error('ApneaAnalysis native module not available');
  }

  const result: AnalysisResult = await ApneaAnalysis.analyzeSession(
    filePath,
    options,
  );

  // Persist top-level stats into sessions row
  await updateSessionAnalysis(sessionId, {
    ahi: result.ahi,
    severity: result.severity,
    apneaCount: result.apneaCount,
    hypopneaCount: result.hypopneaCount,
    longestApneaSec: result.longestApneaSec,
  });

  // Persist individual events
  const dbEvents = result.events
    .filter(e => e.type === 'apnea' || e.type === 'hypopnea')
    .map(e => ({
      sessionId,
      type: e.type,
      startOffsetSec: e.startOffsetSec,
      durationSec: e.durationSec,
      confidence: e.confidence,
    }));

  if (dbEvents.length > 0) {
    await insertEvents(dbEvents);
  }

  return result;
}

export async function getModelInfo() {
  if (!ApneaAnalysis) {
    return null;
  }
  return ApneaAnalysis.getModelInfo();
}
