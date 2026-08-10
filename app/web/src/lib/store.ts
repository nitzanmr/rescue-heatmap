"use client";
// Local-first store. Today: localStorage (mock/no backend).
// Production: IndexedDB queue + POST to /api/reports when online.
import { Report } from "./schema";
import { mockReports } from "./mock";

const KEY = "rh:reports:v1";
const SEEDED = "rh:seeded:v1";

export function loadReports(): Report[] {
  if (typeof window === "undefined") return [];
  try {
    if (!localStorage.getItem(SEEDED)) {
      localStorage.setItem(KEY, JSON.stringify(mockReports()));
      localStorage.setItem(SEEDED, "1");
    }
    return JSON.parse(localStorage.getItem(KEY) || "[]") as Report[];
  } catch {
    return [];
  }
}

export function saveReports(reports: Report[]) {
  localStorage.setItem(KEY, JSON.stringify(reports));
  window.dispatchEvent(new Event("rh:reports-changed"));
}

export function addReport(r: Report) {
  const all = loadReports();
  all.unshift(r);
  saveReports(all);
}

export function updateReport(uuid: string, patch: Partial<Report>) {
  const all = loadReports().map((r) => (r.uuid === uuid ? { ...r, ...patch } : r));
  saveReports(all);
}

export function resetDemo() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(SEEDED);
  window.dispatchEvent(new Event("rh:reports-changed"));
}

// Simulated "flush the offline queue" — what the manual "Send now" button does.
export function flushQueue(): number {
  const all = loadReports();
  let n = 0;
  const next = all.map((r) => {
    if (r.sync_state === "queued") {
      n++;
      return { ...r, sync_state: "acked" as const, received_at_server: new Date().toISOString() };
    }
    return r;
  });
  saveReports(next);
  return n;
}
