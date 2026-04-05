import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vpBin = path.join(packageDir, "node_modules", ".bin", "vp");
const args = process.argv.slice(2);

const result = spawnSync(vpBin, args, {
  cwd: packageDir,
  env: {
    ...process.env,
    OLDPWD: packageDir,
    PWD: packageDir,
  },
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
