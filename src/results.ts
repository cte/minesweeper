import fs from "node:fs";

export interface ResultsRow {
  timestamp: string;
  branch: string;
  commit: string;
  dirty: string;
  solver: string;
  evalWinRate: string;
  evalProgress: string;
  evalAvgSteps: string;
  holdoutWinRate: string;
  holdoutProgress: string;
  holdoutAvgSteps: string;
  decision: string;
  description: string;
}

const RESULT_KEYS = [
  "timestamp",
  "branch",
  "commit",
  "dirty",
  "solver",
  "evalWinRate",
  "evalProgress",
  "evalAvgSteps",
  "holdoutWinRate",
  "holdoutProgress",
  "holdoutAvgSteps",
  "decision",
  "description",
] as const satisfies ReadonlyArray<keyof ResultsRow>;

export const RESULTS_HEADER = [
  "timestamp",
  "branch",
  "commit",
  "dirty",
  "solver",
  "eval_win_rate",
  "eval_progress",
  "eval_avg_steps",
  "holdout_win_rate",
  "holdout_progress",
  "holdout_avg_steps",
  "decision",
  "description",
].join("\t");

function sanitizeTsv(value: string): string {
  return value.replaceAll("\t", " ").replaceAll(/\r?\n/g, " ").trim();
}

export function ensureResultsFile(outputPath: string): void {
  if (fs.existsSync(outputPath)) {
    return;
  }
  fs.writeFileSync(outputPath, `${RESULTS_HEADER}\n`, "utf8");
}

export function overwriteResultsFile(outputPath: string): void {
  fs.writeFileSync(outputPath, `${RESULTS_HEADER}\n`, "utf8");
}

export function appendResultRow(outputPath: string, row: ResultsRow): void {
  const cells = RESULT_KEYS.map((key) => sanitizeTsv(row[key]));
  fs.appendFileSync(outputPath, `${cells.join("\t")}\n`, "utf8");
}

export function readResultsRows(outputPath: string): ResultsRow[] {
  if (!fs.existsSync(outputPath)) {
    return [];
  }
  const source = fs.readFileSync(outputPath, "utf8").trim();
  if (source.length === 0) {
    return [];
  }
  const [headerLine, ...dataLines] = source.split(/\r?\n/);
  if (headerLine !== RESULTS_HEADER) {
    throw new Error(`Unexpected results header in ${outputPath}`);
  }
  const rows: ResultsRow[] = [];
  for (const line of dataLines) {
    if (line.trim().length === 0) {
      continue;
    }
    const cells = line.split("\t");
    if (cells.length !== RESULT_KEYS.length) {
      throw new Error(`Malformed results row with ${cells.length} cells: ${line}`);
    }
    rows.push({
      timestamp: cells[0] ?? "",
      branch: cells[1] ?? "",
      commit: cells[2] ?? "",
      dirty: cells[3] ?? "",
      solver: cells[4] ?? "",
      evalWinRate: cells[5] ?? "",
      evalProgress: cells[6] ?? "",
      evalAvgSteps: cells[7] ?? "",
      holdoutWinRate: cells[8] ?? "",
      holdoutProgress: cells[9] ?? "",
      holdoutAvgSteps: cells[10] ?? "",
      decision: cells[11] ?? "",
      description: cells[12] ?? "",
    });
  }
  return rows;
}

export function getAcceptedResultsRows(rows: ResultsRow[]): ResultsRow[] {
  return rows.filter((row) => row.decision === "baseline" || row.decision === "keep" || row.decision === "recorded");
}
