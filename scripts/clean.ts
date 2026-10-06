import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, loadDotEnv, loadPlatformConfig } from '@cp/platform';

/** `pnpm clean`: deletes local-mode data (the .data folder). Never touches GCP. */
loadDotEnv();
const dir = loadPlatformConfig().localDataDir;
if (!dir.startsWith(findRepoRoot())) {
  process.stderr.write(`refusing to delete ${dir}: LOCAL_DATA_DIR is outside the repo\n`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
process.stdout.write(`removed ${join(dir)}\n`);
