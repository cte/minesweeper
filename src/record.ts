import { runResearchRecordCli } from "@autoresearch/runtime";

import { minesweeperResearch } from "./autoresearch.js";

void runResearchRecordCli(minesweeperResearch, process.argv.slice(2));
