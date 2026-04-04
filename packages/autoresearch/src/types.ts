export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MetricDirection = "maximize" | "minimize";
export type ResearchDecision = "baseline" | "keep" | "discard" | "crash" | "recorded";
export type ResearchStatus = "idle" | "initialized" | "editing" | "evaluating" | "stopped";

export interface ScoreSnapshot {
  candidate: string;
  primary: number;
  secondary: number | null;
  metadata: Record<string, JsonValue>;
  raw: JsonValue | null;
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

export interface ResearchPaths {
  stateDir: string;
  promptPath: string;
  contextPath: string;
  statePath: string;
  descriptionPath: string;
  currentTranscriptPath: string;
  transcriptsDir: string;
  iterationsDir: string;
  codexLastMessagePath: string;
  eventsPath: string;
  resultsJsonPath: string;
  resultsTsvPath: string;
}

export interface ResearchState {
  projectName: string;
  projectRoot: string;
  branchPrefix: string;
  currentBranch: string;
  editablePaths: string[];
  primaryLabel: string;
  secondaryLabel: string | null;
  primaryDirection: MetricDirection;
  secondaryDirection: MetricDirection | null;
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

export interface HookContext {
  project: ResearchProject;
  paths: ResearchPaths;
}

export interface ResearchHooks {
  runCheck: ((context: HookContext) => Promise<void> | void) | null;
  evaluateEval: (context: HookContext) => Promise<ScoreSnapshot> | ScoreSnapshot;
  evaluateHoldout: ((context: HookContext) => Promise<ScoreSnapshot> | ScoreSnapshot) | null;
}

export interface PromptContext {
  branch: string;
  iteration: number;
  editablePaths: string[];
  descriptionPath: string;
  promptPath: string;
  transcriptPath: string;
  bestResult: ResultRecord | null;
  recentResults: ResultRecord[];
}

export interface ResearchProjectInput {
  projectName: string;
  projectRoot: string;
  editablePaths: string[];
  branchPrefix?: string;
  stateDir?: string;
  resultsJsonPath?: string;
  resultsTsvPath?: string;
  eventsPath?: string;
  metrics: {
    primaryLabel: string;
    primaryDirection: MetricDirection;
    secondaryLabel?: string | null;
    secondaryDirection?: MetricDirection | null;
  };
  prompt: {
    objective: string;
    rules: string[];
    notes?: string[];
  };
  hooks: ResearchHooks;
  formatPrompt?: ((context: PromptContext, project: ResearchProject) => string) | null;
  compare?: ((candidate: ScoreSnapshot, reference: ResultRecord, project: ResearchProject) => { keep: boolean; reason: string }) | null;
}

export interface ResearchProject {
  projectName: string;
  projectRoot: string;
  editablePaths: string[];
  branchPrefix: string;
  stateDir: string;
  resultsJsonPath: string;
  resultsTsvPath: string;
  eventsPath: string;
  metrics: {
    primaryLabel: string;
    primaryDirection: MetricDirection;
    secondaryLabel: string | null;
    secondaryDirection: MetricDirection | null;
  };
  prompt: {
    objective: string;
    rules: string[];
    notes: string[];
  };
  hooks: ResearchHooks;
  formatPrompt: ((context: PromptContext, project: ResearchProject) => string) | null;
  compare: ((candidate: ScoreSnapshot, reference: ResultRecord, project: ResearchProject) => { keep: boolean; reason: string }) | null;
}
