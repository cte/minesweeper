import fs from "node:fs";

import type { ResearchPaths, ResultRecord } from "./types.js";
import { appendJsonLine, readJsonLines, sanitizeTsv } from "./utils.js";

export const RESULTS_TSV_HEADER = [
  "timestamp",
  "branch",
  "commit",
  "dirty",
  "candidate",
  "eval_primary",
  "eval_secondary",
  "holdout_primary",
  "holdout_secondary",
  "decision",
  "description",
  "reason",
  "eval_metadata_json",
  "holdout_metadata_json",
].join("\t");

export function overwriteResultsStore(paths: ResearchPaths): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.resultsTsvPath, `${RESULTS_TSV_HEADER}\n`, "utf8");
  fs.writeFileSync(paths.resultsJsonPath, "", "utf8");
}

export function ensureResultsStore(paths: ResearchPaths): void {
  if (!fs.existsSync(paths.resultsTsvPath)) {
    fs.writeFileSync(paths.resultsTsvPath, `${RESULTS_TSV_HEADER}\n`, "utf8");
  }
  if (!fs.existsSync(paths.resultsJsonPath)) {
    fs.writeFileSync(paths.resultsJsonPath, "", "utf8");
  }
}

export function appendResultRecord(paths: ResearchPaths, record: ResultRecord): void {
  ensureResultsStore(paths);
  appendJsonLine(paths.resultsJsonPath, record);
  const row = [
    record.timestamp,
    record.branch,
    record.commit,
    record.dirty ? "yes" : "no",
    record.candidate,
    record.eval ? record.eval.primary.toFixed(6) : "",
    record.eval && record.eval.secondary !== null ? record.eval.secondary.toFixed(6) : "",
    record.holdout ? record.holdout.primary.toFixed(6) : "",
    record.holdout && record.holdout.secondary !== null ? record.holdout.secondary.toFixed(6) : "",
    record.decision,
    record.description,
    record.reason,
    JSON.stringify(record.eval?.metadata ?? {}),
    JSON.stringify(record.holdout?.metadata ?? {}),
  ].map((cell) => sanitizeTsv(cell));
  fs.appendFileSync(paths.resultsTsvPath, `${row.join("\t")}\n`, "utf8");
}

export function readResultRecords(paths: ResearchPaths): ResultRecord[] {
  return readJsonLines<ResultRecord>(paths.resultsJsonPath);
}

export function getAcceptedResultRecords(records: ResultRecord[]): ResultRecord[] {
  return records.filter((record) =>
    record.decision === "baseline" || record.decision === "keep" || record.decision === "recorded",
  );
}
