import { runResearchDashboardCli } from "@autoresearch/runtime";

import { minesweeperResearch } from "./autoresearch.js";

void runResearchDashboardCli(minesweeperResearch, process.argv.slice(2));
