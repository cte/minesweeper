import { runResearchTrialCli } from "@autoresearch/runtime";

import { minesweeperResearch } from "./autoresearch.js";

void runResearchTrialCli(minesweeperResearch, process.argv.slice(2));
