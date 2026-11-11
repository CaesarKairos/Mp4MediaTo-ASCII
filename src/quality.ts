import type { Mode } from "./types";

export type QualityMode = "auto" | "performance" | "balanced" | "quality" | "custom";
export interface QualityCandidate { columns: number; mode: Mode; smoothing: number; score: number }
export interface BenchmarkResult extends QualityCandidate { meanMs: number; p95Ms: number; bytes: number }

export const QUALITY_WEIGHTS = { resolution: 0.5, algorithm: 0.25, temporal: 0.15, stability: 0.1 } as const;
export const QUALITY_CANDIDATES: QualityCandidate[] = [
  { columns: 60, mode: "high", smoothing: .7, score: .48 },
  { columns: 100, mode: "balanced", smoothing: .65, score: .58 },
  { columns: 140, mode: "balanced", smoothing: .6, score: .72 },
  { columns: 180, mode: "fast", smoothing: .45, score: .78 },
  { columns: 240, mode: "fast", smoothing: .3, score: .86 },
];

export function percentile(values: number[], ratio: number) {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function selectQuality(results: BenchmarkResult[], targetFps: number, memoryLimit: number) {
  const safeBudget = 1000 / targetFps * .75;
  const eligible = results.filter((r) => r.p95Ms <= safeBudget && r.bytes <= memoryLimit);
  return (eligible.length ? eligible : results).reduce((best, item) =>
    !best || item.score > best.score ? item : best, undefined as BenchmarkResult | undefined);
}

export class AdaptiveQuality {
  private samples: number[] = [];
  private goodWindows = 0;
  private cooldown = 0;
  constructor(public level: number, private readonly maxLevel: number) {}
  observe(elapsedMs: number, budgetMs: number) {
    this.samples.push(elapsedMs);
    if (this.samples.length < 90) return 0;
    const p95 = percentile(this.samples, .95); this.samples = [];
    if (this.cooldown) { this.cooldown--; return 0; }
    if (p95 > budgetMs * 1.15 && this.level > 0) { this.level--; this.goodWindows = 0; this.cooldown = 2; return -1; }
    if (p95 < budgetMs * .55) this.goodWindows++; else this.goodWindows = 0;
    if (this.goodWindows >= 3 && this.level < this.maxLevel) { this.level++; this.goodWindows = 0; this.cooldown = 2; return 1; }
    return 0;
  }
}
