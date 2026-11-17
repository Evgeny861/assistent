import 'dotenv/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// Workspace scripts run from apps/api, while the documented .env lives at the repo root.
if (!process.env.DOTENV_CONFIG_PATH && !existsSync('.env')) {
  config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
}
