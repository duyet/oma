/**
 * Side-effect import: load `.env` before the rest of main-node reads
 * process.env. Keep this as the first import in src/index.ts.
 */
import { loadLocalEnv } from "./load-local-env";

loadLocalEnv();
