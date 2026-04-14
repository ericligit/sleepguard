/**
 * WaveformView — live amplitude bar chart rendered with react-native-svg.
 *
 * Receives an array of normalised amplitude values (0–1) and renders them
 * as vertical bars. Newest sample is on the right; the view scrolls left
 * as new samples arrive.
 */

import React, {useMemo} from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Rect, Line} from 'react-native-svg';

interface Props {
  amplitudes: number[];    // normalised 0–1, newest last
  width?: number;
  height?: number;
  barColor?: string;
  backgroundColor?: string;
  /** Amplitude fraction above which the bar is highlighted (apnea threshold) */
  alertThreshold?: number;
  alertColor?: string;
}

export const WaveformView: React.FC<Props> = ({
  amplitudes,
  width = 320,
  height = 80,
  barColor = '#4FC3F7',
  backgroundColor = '#0D1B2A',
  alertThreshold = 0.85,
  alertColor = '#EF5350',
}) => {
  const bars = useMemo(() => {
    const count = amplitudes.length;
    if (count === 0) return [];
    const barWidth = Math.max(1, width / count);
    const gap = barWidth > 3 ? 1 : 0;
    return amplitudes.map((amp, i) => {
      const barH = Math.max(2, amp * height);
      return {
        x: i * barWidth + gap / 2,
        y: (height - barH) / 2,
        w: barWidth - gap,
        h: barH,
        alert: amp >= alertThreshold,
      };
    });
  }, [amplitudes, width, height, alertThreshold]);

  return (
    <View style={[styles.container, {width, height, backgroundColor}]}>
      <Svg width={width} height={height}>
        {/* Centre line */}
        <Line
          x1={0} y1={height / 2}
          x2={width} y2={height / 2}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={1}
        />
        {bars.map((b, i) => (
          <Rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={b.w > 3 ? 1 : 0}
            fill={b.alert ? alertColor : barColor}
            opacity={0.9}
          />
        ))}
      </Svg>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 8,
    overflow: 'hidden',
  },
});
