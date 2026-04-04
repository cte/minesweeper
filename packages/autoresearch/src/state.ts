import fs from "node:fs";

import type { ResearchPaths, ResearchProject, ResearchState } from "./types.js";
import { readJsonFile, writeJsonFile } from "./utils.js";

export function buildDefaultState(project: ResearchProject, paths: ResearchPaths): ResearchState {
  return {
    projectName: project.projectName,
    projectRoot: project.projectRoot,
    branchPrefix: project.branchPrefix,
    currentBranch: "",
    editablePaths: project.editablePaths,
    primaryLabel: project.metrics.primaryLabel,
    secondaryLabel: project.metrics.secondaryLabel,
    primaryDirection: project.metrics.primaryDirection,
    secondaryDirection: project.metrics.secondaryDirection,
    status: "idle",
    currentIteration: 0,
    maxIterations: 0,
    message: "idle",
    updatedAt: new Date().toISOString(),
    promptPath: paths.promptPath,
    currentTranscriptPath: paths.currentTranscriptPath,
    eventsPath: paths.eventsPath,
    resultsJsonPath: paths.resultsJsonPath,
    resultsTsvPath: paths.resultsTsvPath,
  };
}

export function readResearchState(project: ResearchProject, paths: ResearchPaths): ResearchState {
  return readJsonFile<ResearchState>(paths.statePath) ?? buildDefaultState(project, paths);
}

export function writeResearchState(paths: ResearchPaths, state: ResearchState): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writeJsonFile(paths.statePath, state);
}
