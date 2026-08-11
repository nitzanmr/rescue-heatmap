"use client";
// The offline queue. This is the file that decides whether "works without a
// signal" is a claim or a fact.
//
// Contract:
//   1. A submitted report is written to storage BEFORE any network call. A
//      report lost because the tab was closed mid-request is not recoverable,
//      and the person it describes is under rubble.
//   2. Every entry carries a device-generated uuid, sent as `uuid` on the wire.
//      The API keys idempotency on it, so a retry storm produces one case.
//      This is why the client must not invent a reference number: three
//      retries would print three different ones for the same person.
//   3. A transport failure retries forever. A 4xx does not — it would send the
//      same rejected bytes again. It is surfaced to the person instead.
//
// Storage is localStorage, not IndexedDB. A report is ~2 KB of text; the photo
// is the only large object and it is compressed on the device first. IndexedDB
// buys us capacity we do not need at the cost of asynchrony in the one code
// path that must survive a browser being killed.
import { ApiError, apiFetch, rememberReporterToken } from "./api";

const KEY = "rh:outbox:v2";
export const OUTBOX_EVENT = "rh:outbox-changed";

export type OutboxState = "pending" | "sending" | "sent" | "rejected";

export interface OutboxEntry {
  /** Device-generated. Also the server-side idempotency key. */
  uuid: string;
  created_at: string;
  state: OutboxState;
  attempts: number;
  last_error?: string | null;
  /** Exactly the JSON body of POST /v1/reports. */
  payload: Record<string, unknown>;
  /** Compressed data URL, uploaded separately after the report is accepted. */
  photo_data_url?: string | null;
  photo_uploaded?: boolean;
  // Filled in by the server on acceptance. Absent until then — on purpose.
  case_id?: string;
  reference_number?: string;
  reporter_token?: string;
  accepted_at?: string;
}

function read(): OutboxEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as OutboxEntry[];
  } catch {
    return [];
  }
}

function write(entries: OutboxEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(entries));
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

export function listOutbox(): OutboxEntry[] {
  return read();
}

export function getEntry(uuid: string): OutboxEntry | undefined {
  return read().find((e) => e.uuid === uuid);
}

function patch(uuid: string, p: Partial<OutboxEntry>) {
  write(read().map((e) => (e.uuid === uuid ? { ...e, ...p } : e)));
}

export function pendingCount(): number {
  return read().filter((e) => e.state === "pending" || e.state === "sending").length;
}

export function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Write first, send second. Returns the local id to follow the entry by. */
export function enqueueReport(payload: Record<string, unknown>, photoDataUrl?: string | null): string {
  const uuid = newUuid();
  const entry: OutboxEntry = {
    uuid,
    created_at: new Date().toISOString(),
    state: "pending",
    attempts: 0,
    payload: { ...payload, uuid, created_at_device: new Date().toISOString() },
    photo_data_url: photoDataUrl ?? null,
    photo_uploaded: false,
  };
  write([entry, ...read()]);
  return uuid;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// The photo is uploaded AFTER the report is accepted, never with it. Text is
// what the rescue teams need; a 200 KB image must not be able to hold it
// hostage on a degraded tower.
async function uploadPhoto(entry: OutboxEntry): Promise<void> {
  if (!entry.photo_data_url || !entry.case_id || !entry.reference_number) return;
  const fd = new FormData();
  fd.append("file", dataUrlToBlob(entry.photo_data_url), "photo.jpg");
  await apiFetch(`/v1/reports/${entry.case_id}/media`, {
    method: "POST",
    raw: fd,
    auth: `reporter:${entry.reference_number}`,
  });
  // Drop the bytes once they are on the server: keeping a face in localStorage
  // after it has been delivered is storage we have no reason to hold.
  patch(entry.uuid, { photo_uploaded: true, photo_data_url: null });
}

let flushing = false;

export interface FlushResult {
  sent: number;
  failed: number;
  offline: boolean;
}

export async function flushOutbox(): Promise<FlushResult> {
  if (flushing) return { sent: 0, failed: 0, offline: false };
  flushing = true;
  const result: FlushResult = { sent: 0, failed: 0, offline: false };
  try {
    for (const entry of read()) {
      // A report accepted earlier whose photo never made it still has work left.
      if (entry.state === "sent") {
        if (entry.photo_data_url && !entry.photo_uploaded) {
          try {
            await uploadPhoto(entry);
          } catch (err) {
            if (err instanceof ApiError && err.isOffline) result.offline = true;
          }
        }
        continue;
      }
      if (entry.state === "rejected") continue;

      patch(entry.uuid, { state: "sending", attempts: entry.attempts + 1 });
      try {
        const res = await apiFetch<{
          case_id: string;
          reference_number: string;
          reporter_token?: string;
          replay?: boolean;
        }>("/v1/reports", { body: entry.payload });

        if (res.reporter_token) rememberReporterToken(res.reference_number, res.reporter_token);
        patch(entry.uuid, {
          state: "sent",
          case_id: res.case_id,
          reference_number: res.reference_number,
          reporter_token: res.reporter_token,
          accepted_at: new Date().toISOString(),
          last_error: null,
        });
        result.sent++;

        const fresh = getEntry(entry.uuid);
        if (fresh?.photo_data_url) {
          try {
            await uploadPhoto(fresh);
          } catch {
            // The report is in. The photo retries on the next flush.
          }
        }
      } catch (err) {
        const e = err as ApiError;
        if (e instanceof ApiError && e.isOffline) {
          // Still ours to retry. Put it straight back, do not count it failed.
          patch(entry.uuid, { state: "pending", last_error: null });
          result.offline = true;
          break; // no point hammering a dead network with the rest of the queue
        }
        if (e instanceof ApiError && e.isPermanent) {
          patch(entry.uuid, { state: "rejected", last_error: `${e.code}: ${e.message}` });
          result.failed++;
        } else {
          patch(entry.uuid, { state: "pending", last_error: e.message });
          result.failed++;
        }
      }
    }
  } finally {
    flushing = false;
  }
  return result;
}

/** Start the background drain. Idempotent; safe to call from every page. */
export function startOutboxSync(): () => void {
  if (typeof window === "undefined") return () => {};
  const tick = () => {
    if (navigator.onLine && pendingCount() > 0) void flushOutbox();
  };
  window.addEventListener("online", tick);
  const timer = window.setInterval(tick, 20_000);
  tick();
  return () => {
    window.removeEventListener("online", tick);
    window.clearInterval(timer);
  };
}

export function discardEntry(uuid: string) {
  write(read().filter((e) => e.uuid !== uuid));
}
