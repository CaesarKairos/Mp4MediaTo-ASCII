export interface OutputFrameTiming {
  index: number;
  timestampUs: number;
  durationUs: number;
  sourceTime: number;
}

export function outputTimeline(sourceDuration: number, exportFps: number): OutputFrameTiming[] {
  if (!(sourceDuration > 0) || !(exportFps > 0)) return [];
  const count = Math.max(1, Math.ceil(sourceDuration * exportFps));
  const endUs = Math.round(sourceDuration * 1_000_000);
  return Array.from({ length: count }, (_, index) => {
    const timestampUs = Math.round(index * 1_000_000 / exportFps);
    const nominalEnd = Math.round((index + 1) * 1_000_000 / exportFps);
    return {
      index,
      timestampUs,
      durationUs: Math.max(1, Math.min(endUs, nominalEnd) - timestampUs),
      sourceTime: Math.min(index / exportFps, Math.max(0, sourceDuration - 0.000001)),
    };
  });
}

export function blendPosition(time: number, sourceFps: number, lastIndex: number) {
  const position = Math.max(0, time * sourceFps);
  const a = Math.min(lastIndex, Math.floor(position));
  return { a, b: Math.min(lastIndex, a + 1), alpha: position - Math.floor(position) };
}
