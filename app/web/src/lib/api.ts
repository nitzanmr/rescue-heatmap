// The one place the browser talks to the server.
//
// Everything goes through here so that three things are decided once instead of
// in every component: where the API lives, how a token is attached, and what a
// failure looks like. A page that calls fetch() directly will eventually get one
// of those three wrong, and the one it gets wrong will be the token.
//
// Base URL: relative "/api" by default, rewritten to the API service by
// next.config.mjs. Relative on purpose — a same-origin request needs no CORS,
// no preflight and no second hostname to configure during an activation.
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** Nothing reached the server: the request is still worth retrying. */
  get isOffline() {
    return this.status === 0;
  }
  /** The server rejected the content itself. Retrying sends the same thing again. */
  get isPermanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

// ---------------------------------------------------------------------------
// Tokens.
//   reporter — the family's private link, arrives in the URL as ?t=…
//   operator — pasted once into the panel by a coordinator
// Both live in localStorage. A reporter token in localStorage is a deliberate
// trade: a family that loses it cannot be re-issued one, and asking a frightened
// person to keep a link in their head is worse than the storage risk.
// ---------------------------------------------------------------------------
const OPERATOR_KEY = "rh:operator-token:v1";
const REPORTER_KEY = "rh:reporter-tokens:v1";

export function setOperatorToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(OPERATOR_KEY, token);
  else localStorage.removeItem(OPERATOR_KEY);
}

export function operatorToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(OPERATOR_KEY);
}

type ReporterTokens = Record<string, string>; // reference_number -> token

function reporterTokens(): ReporterTokens {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(REPORTER_KEY) || "{}") as ReporterTokens;
  } catch {
    return {};
  }
}

export function rememberReporterToken(reference: string, token: string) {
  if (typeof window === "undefined") return;
  const all = reporterTokens();
  all[reference.toUpperCase()] = token;
  localStorage.setItem(REPORTER_KEY, JSON.stringify(all));
}

export function reporterTokenFor(reference: string): string | null {
  return reporterTokens()[reference.toUpperCase()] ?? null;
}

export function myReferences(): string[] {
  return Object.keys(reporterTokens());
}

// ---------------------------------------------------------------------------
// The request itself.
// ---------------------------------------------------------------------------
export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Bearer token. "operator" and "reporter:<ref>" resolve from storage. */
  auth?: string | null;
  signal?: AbortSignal;
  /** Raw body (FormData) passes through untouched. */
  raw?: BodyInit;
}

function resolveAuth(auth: string | null | undefined): string | null {
  if (!auth) return null;
  if (auth === "operator") return operatorToken();
  if (auth.startsWith("reporter:")) return reporterTokenFor(auth.slice(9));
  return auth;
}

export async function apiFetch<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = resolveAuth(opts.auth);
  if (token) headers.authorization = `Bearer ${token}`;

  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: opts.signal,
      // No cookies anywhere in this system: every identity is a bearer token,
      // which means no CSRF surface to reason about during an emergency.
      credentials: "omit",
      cache: "no-store",
    });
  } catch (err) {
    // Distinguish "the network is gone" from "the server said no". The offline
    // queue depends on this distinction: only the first one may be retried
    // forever.
    throw new ApiError(0, "offline", (err as Error).message || "sin conexión");
  }

  if (res.status === 204) return undefined as T;

  const ctype = res.headers.get("content-type") ?? "";
  const payload = ctype.includes("application/json") ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const code = (payload && typeof payload === "object" && (payload as any).error) || "http_error";
    const message =
      (payload && typeof payload === "object" && (payload as any).message) ||
      (typeof payload === "string" && payload) ||
      res.statusText;
    throw new ApiError(res.status, String(code), String(message));
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Typed surface. These mirror services/api/src/routes/* exactly; if a field is
// not listed here it is because the server does not return it.
// ---------------------------------------------------------------------------
export interface PublicCase {
  reference_number: string;
  name: string;
  age_approx: number | null;
  gender: "m" | "f" | "other" | "unknown" | null;
  status: string;
  reports: number;
  area: { lat: number; lng: number } | null;
  updated_at: string;
  photo_url?: string | null;
}

export interface HeatCell {
  lat: number;
  lng: number;
  weight: number;
  cases: number;
}

// An aid site is an institution, not a person: exact coordinates and a phone
// number here are intentional, and are the one place in the public API where
// that is true.
export type AidKind =
  | "shelter"
  | "shelter_candidate"
  | "medical"
  | "pharmacy"
  | "responder"
  | "supply"
  | "water"
  | "morgue"
  | "info_point"
  | "other";

export interface AidSite {
  id: string;
  kind: AidKind;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  phone: string | null;
  capacity: number | null;
  status: string;
  /** Somebody physically confirmed this site. Drawn differently on the map. */
  verified: boolean;
  source: string;
  updated_at: string;
}

// One row of the merge ledger. `fully_recorded` is false for merges performed
// before 0009: those can only be partially reversed, and the panel says so
// instead of promising a clean undo.
export interface MergeRecord {
  id: number;
  survivor_id: string;
  merged_id: string;
  candidate_id: number | null;
  actor: string;
  at: string;
  undone: boolean;
  undone_at: string | null;
  undone_by: string | null;
  moved_reports: number;
  fully_recorded: boolean;
  survivor_ref: string;
  survivor_name: string | null;
  merged_ref: string;
  merged_name: string | null;
}

export const api = {
  meta: () => apiFetch<{ version: string; incidents: { slug: string; name: string; ref_prefix: string }[] }>("/v1/meta"),

  ready: () => apiFetch<{ ok: boolean; db: string }>("/readyz"),

  // Public --------------------------------------------------------------
  search: (q: string, opts: { status?: string; limit?: number; incident?: string } = {}) => {
    const p = new URLSearchParams({ q });
    if (opts.status) p.set("status", opts.status);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.incident) p.set("incident", opts.incident);
    return apiFetch<{ results: PublicCase[]; has_more: boolean }>(`/v1/public/search?${p}`);
  },

  card: (ref: string) => apiFetch<PublicCase>(`/v1/public/cases/${encodeURIComponent(ref)}`),

  sighting: (
    ref: string,
    body: {
      kind: "seen" | "safe" | "hospital" | "shelter" | "deceased" | "correction";
      note?: string | null;
      lat?: number | null;
      lng?: number | null;
      reported_at?: string | null;
      contact_phone?: string | null;
    }
  ) => apiFetch<{ ok: true; sighting_id: string }>(`/v1/public/cases/${encodeURIComponent(ref)}/sightings`, { body }),

  publicHeat: (cell = 500) => apiFetch<{ cell_m: number; cells: HeatCell[] }>(`/v1/public/heat?cell=${cell}`),

  aidSites: (opts: { country?: string; kinds?: AidKind[]; incident?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.country) p.set("country", opts.country);
    if (opts.kinds?.length) p.set("kinds", opts.kinds.join(","));
    if (opts.incident) p.set("incident", opts.incident);
    const qs = p.toString();
    return apiFetch<{ attribution: string; sites: AidSite[] }>(`/v1/public/aid-sites${qs ? `?${qs}` : ""}`);
  },

  // Reporter (family private link) ---------------------------------------
  reporterCase: (ref: string) => apiFetch<any>("/v1/reporter/case", { auth: `reporter:${ref}` }),

  reporterUpdate: (ref: string, patch: Record<string, unknown>) =>
    apiFetch<{ ok: true; changed: number }>("/v1/reporter/case", {
      method: "PATCH",
      body: patch,
      auth: `reporter:${ref}`,
    }),

  reporterErase: (ref: string) =>
    apiFetch<{ ok: true }>("/v1/reporter/case/erase", { method: "POST", auth: `reporter:${ref}` }),

  // Panel (operator) ------------------------------------------------------
  dedupQueue: (limit = 50) =>
    apiFetch<{ pending: any[] }>(`/v1/panel/dedup?limit=${limit}`, { auth: "operator" }),

  decide: (candidateId: string, body: { decision: "merge" | "reject"; survivor_case_id?: string; note?: string }) =>
    apiFetch<{ ok: true; state: string; merge_id?: number | null; merged_case_id?: string }>(
      `/v1/panel/dedup/${candidateId}/decide`,
      { body, auth: "operator" }
    ),

  // The merge ledger and its undo. The panel card tells the operator a merge can
  // be taken back; until these were wired, that sentence was decoration.
  merges: (limit = 20, includeUndone = false) =>
    apiFetch<{ merges: MergeRecord[] }>(
      `/v1/panel/merges?limit=${limit}${includeUndone ? "&include_undone=1" : ""}`,
      { auth: "operator" }
    ),

  undoMerge: (mergeId: number) =>
    apiFetch<{ ok: true; restored_case_id: string }>(`/v1/panel/merges/${mergeId}/undo`, {
      method: "POST",
      auth: "operator",
    }),

  panelCase: (caseId: string) => apiFetch<any>(`/v1/panel/cases/${caseId}`, { auth: "operator" }),

  setStatus: (caseId: string, body: { status: string; status_source?: string; note?: string }) =>
    apiFetch<{ ok: true }>(`/v1/panel/cases/${caseId}/status`, { body, auth: "operator" }),

  panelHeat: (cell = 100) =>
    apiFetch<{ cell_m: number; cells: HeatCell[] }>(`/v1/panel/heat?cell=${cell}`, { auth: "operator" }),

  // The export is audited server-side ("who took a copy of the missing list"),
  // so it must carry the operator token — which rules out a plain <a href>.
  exportBlob: async (format: "csv" | "geojson" | "kml"): Promise<Blob> => {
    const token = operatorToken();
    const res = await fetch(`${API_BASE}/v1/panel/export?format=${format}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) throw new ApiError(res.status, "export_failed", res.statusText);
    return res.blob();
  },
};
