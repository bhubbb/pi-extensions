/**
 * Minimal backend resolver for pi-llama-stats.
 *
 * Reads the same inputs as pi-llama but only extracts what the stats view needs
 * (baseUrl, apiKey, authHeader). Does not import from pi-llama — depends only
 * on the documented pi-llama.json file format.
 *
 * Priority: env vars → persisted config file → empty (no defaults).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved backend ready for fetching stats. */
export interface StatsBackend {
  /** Unique identifier (e.g. "llama-cpp", "llama-cpp-0"). */
  providerId: string;
  /** Full base URL as configured (may include trailing `/v1`). */
  baseUrl: string;
  /** Root URL with trailing `/v1` stripped — used for all endpoint fetches. */
  rootUrl: string;
  /** API key (resolved from env if needed). */
  apiKey: string;
  /** Whether to send an Authorization: Bearer header. */
  authHeader: boolean;
}

/** Shape of the persisted pi-llama.json file (read-only subset). */
interface PersistedConfig {
  backends?: Array<{
    baseUrl?: string;
    apiKey?: string;
    authHeader?: boolean;
    // Other fields are ignored — we only read what we need.
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-llama.json");
export const DEFAULT_API_KEY = "no-key";

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Strip trailing `/v1` and any trailing slashes. */
function stripV1(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Resolve an API key value, supporting env var interpolation.
 *
 * - `!...` prefix → literal value (escape env var lookup)
 * - name found in `process.env` → env var value
 * - otherwise → literal value
 */
export function resolveSingleKey(input?: string): string {
  if (!input) return DEFAULT_API_KEY;
  if (input.startsWith("!")) return input.slice(1);
  if (input in process.env) return process.env[input] || DEFAULT_API_KEY;
  return input;
}

/**
 * Build auth headers for a backend fetch.
 * Returns `{}` when no key is configured, or `{ Authorization: "Bearer <key>" }` when one is.
 */
export function authHeaders(backend: StatsBackend): Record<string, string> {
  if (backend.authHeader && backend.apiKey !== DEFAULT_API_KEY) {
    return { Authorization: "Bearer " + backend.apiKey };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve all llama.cpp backends for the stats view.
 *
 * Priority:
 *   1. If `LLAMA_BASE_URL` env var is set → single backend (providerId: "llama-cpp").
 *   2. Else read `~/.pi/agent/pi-llama.json` → multi-backend mode
 *      (providerIds: "llama-cpp-0", "llama-cpp-1", ...).
 *   3. Else return `[]` (no backends — caller should notify the user).
 *
 * Returns an empty array when no backends are found (never throws).
 */
export async function resolveStatsBackends(configPath: string = CONFIG_PATH): Promise<StatsBackend[]> {
  // Case 1: Legacy env var — single backend
  const envUrl = process.env.LLAMA_BASE_URL;
  if (envUrl) {
    const apiKey = resolveSingleKey(process.env.LLAMA_API_KEY);
    const rootUrl = stripV1(envUrl);
    return [
      {
        providerId: "llama-cpp",
        baseUrl: envUrl.replace(/\/+$/, ""),
        rootUrl,
        apiKey,
        authHeader: false, // Legacy env var mode never sends auth header by default
      },
    ];
  }

  // Case 2: Persisted config file — multi-backend mode
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw) as PersistedConfig;
      if (Array.isArray(config.backends) && config.backends.length > 0) {
        return config.backends
          .filter((b) => b.baseUrl) // Skip entries without a baseUrl
          .map((b, idx): StatsBackend => {
            const baseUrl = (b.baseUrl ?? "").replace(/\/+$/, "");
            return {
              providerId: `llama-cpp-${idx}`,
              baseUrl,
              rootUrl: stripV1(baseUrl),
              apiKey: resolveSingleKey(b.apiKey),
              authHeader: b.authHeader ?? false,
            };
          });
      }
    } catch {
      // Malformed file — treat as no config (caller will get empty array)
    }
  }

  // Case 3: No backends
  return [];
}
