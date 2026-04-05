import { initTRPC } from "@trpc/server";

import { readResearchEvents } from "./events.js";
import { resolveResearchPaths } from "./runtime.js";
import { getAcceptedResultRecords, readResultRecords } from "./store.js";
import { readResearchState } from "./state.js";
import type { DashboardPayload, ResearchPaths, ResearchProject } from "./types.js";
import { tailText } from "./utils.js";

const t = initTRPC.create();

export function readDashboardPayload(project: ResearchProject, paths: ResearchPaths): DashboardPayload {
  const state = readResearchState(project, paths);
  const results = readResultRecords(paths);
  const accepted = getAcceptedResultRecords(results);

  return {
    project: {
      name: project.projectName,
      projectRoot: project.projectRoot,
      editablePaths: project.editablePaths,
      primaryLabel: project.metrics.primaryLabel,
      secondaryLabel: project.metrics.secondaryLabel,
    },
    state,
    results,
    best: accepted.at(-1) ?? null,
    latest: results.at(-1) ?? null,
    events: readResearchEvents(paths).slice(-100),
    transcriptTail: tailText(paths.currentTranscriptPath, 50_000),
  };
}

export function createDashboardRouter(project: ResearchProject) {
  const paths = resolveResearchPaths(project);

  return t.router({
    state: t.procedure.query(() => readDashboardPayload(project, paths)),
  });
}

export type DashboardAppRouter = ReturnType<typeof createDashboardRouter>;
