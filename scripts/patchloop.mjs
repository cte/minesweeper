import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dashboardDir = path.resolve(projectRoot, "..", "patchloop", "packages", "dashboard");
const dashboardDistDir = path.join(dashboardDir, "dist");

if (!fs.existsSync(dashboardDir)) {
  console.error(`Missing Patchloop dashboard at ${dashboardDir}`);
  console.error("Expected sibling repo layout: ../patchloop");
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "patchloop", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PATCHLOOP_DASHBOARD_DIR: dashboardDir,
    PATCHLOOP_DASHBOARD_DIST_DIR: dashboardDistDir,
  },
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
