import fs from "node:fs";
import path from "node:path";

import type { GameConfig } from "./types.js";

interface BenchmarkSuite {
  label: string;
  width: number;
  height: number;
  mines: number;
  seedPrefix: string;
  start: number;
  count: number;
}

interface BenchmarkManifest {
  name: string;
  description?: string;
  suites: BenchmarkSuite[];
}

export interface BenchmarkCase extends GameConfig {
  id: string;
  suite: string;
}

export interface Benchmark {
  name: string;
  description?: string;
  cases: BenchmarkCase[];
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function parseManifest(raw: unknown): BenchmarkManifest {
  assertObject(raw, "Benchmark file must contain a JSON object");
  if (!Array.isArray(raw.suites) || raw.suites.length === 0) {
    throw new Error("Benchmark must define at least one suite");
  }
  const suites: BenchmarkSuite[] = raw.suites.map((suiteRaw, index) => {
    assertObject(suiteRaw, `suite[${index}] must be an object`);
    return {
      label: readString(suiteRaw.label, `suite[${index}].label`),
      width: readPositiveInteger(suiteRaw.width, `suite[${index}].width`),
      height: readPositiveInteger(suiteRaw.height, `suite[${index}].height`),
      mines: readPositiveInteger(suiteRaw.mines, `suite[${index}].mines`),
      seedPrefix: readString(suiteRaw.seedPrefix, `suite[${index}].seedPrefix`),
      start: readPositiveInteger(suiteRaw.start, `suite[${index}].start`),
      count: readPositiveInteger(suiteRaw.count, `suite[${index}].count`),
    };
  });
  const manifest: BenchmarkManifest = {
    name: readString(raw.name, "name"),
    suites,
  };
  if (typeof raw.description === "string") {
    manifest.description = raw.description;
  }
  return manifest;
}

export function loadBenchmark(filePath: string): Benchmark {
  const resolvedPath = path.resolve(filePath);
  const source = fs.readFileSync(resolvedPath, "utf8");
  const manifest = parseManifest(JSON.parse(source) as unknown);
  const cases: BenchmarkCase[] = [];

  for (const suite of manifest.suites) {
    for (let offset = 0; offset < suite.count; offset += 1) {
      const seedNumber = suite.start + offset;
      const seed = `${suite.seedPrefix}-${String(seedNumber).padStart(3, "0")}`;
      cases.push({
        id: `${suite.label}-${String(seedNumber).padStart(3, "0")}`,
        suite: suite.label,
        width: suite.width,
        height: suite.height,
        mines: suite.mines,
        seed,
      });
    }
  }

  const benchmark: Benchmark = {
    name: manifest.name,
    cases,
  };
  if (manifest.description !== undefined) {
    benchmark.description = manifest.description;
  }
  return benchmark;
}
