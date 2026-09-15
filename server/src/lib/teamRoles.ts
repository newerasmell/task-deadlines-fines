import fs from "fs";
import path from "path";

// Two directories up from dist/lib (or src/lib in dev) to reach server/,
// same resolution pattern as uploadsRoot in uploads.ts.
const CONFIG_PATH = path.resolve(__dirname, "..", "..", "config", "team-roles.json");

export interface TeamRoleEntry {
  key: string;
  name: string;
  email: string;
  responsibilities: string;
}

export interface TeamRolesConfig {
  team: TeamRoleEntry[];
  default_deadline_working_days: number;
}

// Re-read from disk on every call rather than caching in memory — the whole
// point of a hand-edited config file (per the voice-to-tasks brief) is that
// editing it takes effect immediately, without a redeploy or process restart.
export function loadTeamRoles(): TeamRolesConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as TeamRolesConfig;
  if (!Array.isArray(parsed.team)) {
    throw new Error("team-roles.json: missing or invalid \"team\" array");
  }
  return parsed;
}

export function findRoleByKey(config: TeamRolesConfig, key: string | null | undefined): TeamRoleEntry | null {
  if (!key) return null;
  return config.team.find((t) => t.key === key) ?? null;
}
