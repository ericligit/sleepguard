/**
 * healthConnect.ts — Android Health Connect integration for SpO2 data.
 *
 * Used in Phase 1 to fetch OxygenSaturation records that overlap with a
 * sleep session's time window. Results are stored alongside session metadata
 * so the detail screen can display real SpO2 stats even before the AI model runs.
 *
 * Requires react-native-health-connect and the READ_OXYGEN_SATURATION
 * permission declared in AndroidManifest.xml.
 */

import {
  initialize,
  requestPermission,
  readRecords,
  getSdkStatus,
  SdkAvailabilityStatus,
} from 'react-native-health-connect';
import type {SpO2Sample} from '../types';

/**
 * Returns true if Health Connect is installed and ready on this device.
 * (Health Connect is built-in on Android 14+; needs to be installed on 13 and below.)
 */
export async function isHealthConnectAvailable(): Promise<boolean> {
  try {
    const status = await getSdkStatus();
    return status === SdkAvailabilityStatus.SDK_AVAILABLE;
  } catch {
    return false;
  }
}

/**
 * Initialise Health Connect SDK and request required permissions.
 * Returns true if all permissions were granted.
 */
export async function requestHealthPermissions(): Promise<boolean> {
  const isAvailable = await isHealthConnectAvailable();
  if (!isAvailable) return false;

  await initialize();

  const granted = await requestPermission([
    {accessType: 'read', recordType: 'OxygenSaturation'},
  ]);

  return granted.some(p => p.recordType === 'OxygenSaturation');
}

/**
 * Reads SpO2 samples from Health Connect for a given time window.
 * @param startMs  Unix milliseconds — session start
 * @param endMs    Unix milliseconds — session end
 */
export async function fetchSpO2(
  startMs: number,
  endMs: number,
): Promise<SpO2Sample[]> {
  const available = await isHealthConnectAvailable();
  if (!available) return [];

  await initialize();

  try {
    const result = await readRecords('OxygenSaturation', {
      timeRangeFilter: {
        operator: 'between',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
      },
    });

    return (result.records ?? []).map((r: any) => ({
      timestamp: new Date(r.time).getTime(),
      value: r.percentage * 100,  // Health Connect stores 0–1; convert to percentage
    }));
  } catch (err) {
    console.warn('[HealthConnect] fetchSpO2 failed:', err);
    return [];
  }
}

/**
 * Derives simple statistics from an array of SpO2 samples.
 */
export function computeSpO2Stats(samples: SpO2Sample[]): {
  avg: number | null;
  min: number | null;
} {
  if (samples.length === 0) return {avg: null, min: null};
  const values = samples.map(s => s.value);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  return {avg, min};
}
