import fs from "node:fs";

import type { JsonValue } from "./types.js";

export function sanitizeTsv(value: string): string {
  return value.replaceAll("\t", " ").replaceAll(/\r?\n/g, " ").trim();
}

export function slugifyLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "metric";
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function optionalEnv(name: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : "";
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonLine(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const source = fs.readFileSync(filePath, "utf8").trim();
  if (source.length === 0) {
    return [];
  }
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function tailText(filePath: string, maxBytes: number): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const stats = fs.statSync(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

export function resolveDotPath(value: JsonValue, dotPath: string): JsonValue {
  const parts = dotPath.split(".").filter((part) => part.length > 0);
  let current: JsonValue = value;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Path ${dotPath} could not be resolved at array index ${part}`);
      }
      current = current[index] ?? null;
      continue;
    }
    if (current === null || typeof current !== "object") {
      throw new Error(`Path ${dotPath} could not be resolved at segment ${part}`);
    }
    const next = (current as Record<string, JsonValue>)[part];
    if (next === undefined) {
      throw new Error(`Path ${dotPath} could not be resolved at segment ${part}`);
    }
    current = next;
  }
  return current;
}

export function asNumber(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric ${label}, received ${JSON.stringify(value)}`);
  }
  return value;
}

export function asString(value: JsonValue, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string ${label}, received ${JSON.stringify(value)}`);
  }
  return value;
}
