"use client";
import { useEffect, useMemo, useState } from "react";
import { Report } from "@/lib/schema";
import { loadReports, updateReport } from "@/lib/store";
import { normName } from "@/lib/dedup";

// PUBLIC view. Privacy rule from form-spec: shows name, approximate age, city/area.
// NEVER floor, apartment, reporter phone or an exact pin.
export default function Buscar() {
  const [reports, setReports] = useState<Report[]>([]);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "missing" | "found">("all");

  useEffect(() => {
    const read = () => setReports(loadReports());
    read();
    window.addEventListener("rh:reports-changed", read);
    return () => window.removeEventListener("rh:reports-changed", read);
  }, []);

  const list = useMemo(() => {
    const nq = normName(q);
    return reports.filter((r) => {
      if (only === "missing" && !["missing", "trapped_alive"].includes(r.status)) return false;
      if (only === "found" && !r.status.startsWith("found")) return false;
      if (!nq) return true;
      return normName(r.full_name).includes(nq) || normName(r.last_seen_address ?? "").includes(nq) || r.reference_number.toLowerCase().includes(q.toLowerCase());
    });
  }, [reports, q, only]);

  const markFound = (r: Report) => {
    if (r.status_source === "official") {
      alert("Este estado fue confirmado oficialmente y no puede cambiarse desde la vista pública.");
      return;
    }
    if (confirm(`¿Confirmas que ${r.full_name} apareció con vida?`)) {
      updateReport(r.uuid, { status: "found_safe", status_source: "citizen", status_updated_at: new Date().toISOString() });
    }
  };

  return (
    <div className="wrap">
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Buscar personas reportadas</h1>
      <p className="small muted">
        Vista pública. No se muestran teléfonos, pisos ni ubicaciones exactas. Las fotos de menores se
        difuminan automáticamente.
      </p>

      <div className="row" style={{ margin: "18px 0" }}>
        <input style={{ maxWidth: 380 }} placeholder="Nombre, barrio o número de referencia…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          {([["all", "Todos"], ["missing", "Se busca"], ["found", "Apareció"]] as const).map(([v, l]) => (
            <button key={v} className={`chip ${only === v ? "on" : ""}`} onClick={() => setOnly(v)}>{l}</button>
          ))}
        </div>
      </div>

      <p className="small muted">{list.length} resultado(s)</p>

      <div className="grid cols-3" style={{ marginTop: 12 }}>
        {list.slice(0, 60).map((r) => (
          <div className="card" key={r.uuid}>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div>
                <h3 style={{ marginBottom: 4 }}>{r.full_name}</h3>
                <p className="small">
                  {r.age_approx ? `~${r.age_approx} años · ` : ""}
                  {r.last_seen_address}
                </p>
              </div>
              <span className="spacer" />
              <StatusBadge status={r.status} />
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Ref. {r.reference_number}
              {(r.reporter_count ?? 1) > 1 ? ` · ${r.reporter_count} personas lo reportaron` : ""}
              {r.status_source === "verified_field" ? " · verificado en terreno" : ""}
            </p>
            {["missing", "trapped_alive"].includes(r.status) && (
              <button className="btn ghost block" style={{ marginTop: 12 }} onClick={() => markFound(r)}>
                Apareció — marcar como encontrada
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: Report["status"] }) {
  const map: Record<string, [string, string]> = {
    missing: ["missing", "Se busca"],
    trapped_alive: ["trapped", "Atrapado con vida"],
    found_safe: ["safe", "Apareció"],
    found_injured: ["injured", "Herido"],
    deceased: ["muted", "Fallecido"],
    withdrawn: ["muted", "Retirado"],
  };
  const [cls, label] = map[status] ?? ["muted", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}
