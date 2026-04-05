export type ResearchDecision = "baseline" | "keep" | "discard" | "crash" | "recorded";
export type ResearchStatus = "idle" | "initialized" | "editing" | "evaluating" | "stopped";

export interface ScoreSnapshot {
  candidate: string;
  primary: number;
  secondary: number | null;
  metadata: Record<string, unknown>;
  raw: unknown;
}

export interface ResultRecord {
  timestamp: string;
  branch: string;
  commit: string;
  dirty: boolean;
  decision: ResearchDecision;
  description: string;
  reason: string;
  candidate: string;
  eval: ScoreSnapshot | null;
  holdout: ScoreSnapshot | null;
}

export interface ResearchState {
  projectName: string;
  projectRoot: string;
  branchPrefix: string;
  currentBranch: string;
  editablePaths: string[];
  primaryLabel: string;
  secondaryLabel: string | null;
  primaryDirection: "maximize" | "minimize";
  secondaryDirection: "maximize" | "minimize" | null;
  status: ResearchStatus;
  currentIteration: number;
  maxIterations: number;
  message: string;
  updatedAt: string;
  promptPath: string;
  currentTranscriptPath: string;
  eventsPath: string;
  resultsJsonPath: string;
  resultsTsvPath: string;
}

export interface ResearchEvent {
  timestamp: string;
  type: string;
  iteration: number;
  message: string;
  data: unknown;
}

export interface DashboardProjectInfo {
  name: string;
  projectRoot: string;
  editablePaths: string[];
  primaryLabel: string;
  secondaryLabel: string | null;
}

export interface DashboardPayload {
  project: DashboardProjectInfo;
  state: ResearchState;
  results: ResultRecord[];
  best: ResultRecord | null;
  latest: ResultRecord | null;
  events: ResearchEvent[];
  transcriptTail: string;
}
