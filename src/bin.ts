// Localise les outils externes : d'abord .venv/bin (installé par setup.sh), sinon le PATH.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function bin(name: "yt-dlp"): string {
  const local = path.join(ROOT, ".venv", "bin", name);
  return existsSync(local) ? local : name;
}
