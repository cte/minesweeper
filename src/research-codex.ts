import { runCodexEditorCli } from "@autoresearch/runtime";

import { minesweeperResearch } from "./autoresearch.js";

void runCodexEditorCli(minesweeperResearch, process.argv.slice(2));
