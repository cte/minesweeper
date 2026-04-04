import fs from "node:fs";

import type { ResearchEvent, ResearchPaths } from "./types.js";
import { appendJsonLine, readJsonLines } from "./utils.js";

export function overwriteEvents(paths: ResearchPaths): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.eventsPath, "", "utf8");
}

export function appendResearchEvent(paths: ResearchPaths, event: Omit<ResearchEvent, "timestamp">): ResearchEvent {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const fullEvent: ResearchEvent = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  appendJsonLine(paths.eventsPath, fullEvent);
  return fullEvent;
}

export function readResearchEvents(paths: ResearchPaths): ResearchEvent[] {
  return readJsonLines<ResearchEvent>(paths.eventsPath);
}
