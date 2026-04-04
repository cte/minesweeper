import { runResearchInitCli } from "@autoresearch/runtime";

import { minesweeperResearch } from "./autoresearch.js";

void runResearchInitCli(minesweeperResearch, process.argv.slice(2));
