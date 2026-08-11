"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Report, reportWeight } from "@/lib/schema";
import { loadReports, resetDemo, flushQueue, updateReport } from "@/lib/store";
import { incident } from "@/lib/incident";
import StatusBadge from "@/components/StatusBadge";

const HeatMap = dynamic(() => import("@/components/HeatMap"), {
  ssr: false,
  loading: () => <div className="map" style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>Cargando mapa…</div>,
});

export default function Panel() {
  const [reports, setReports] = useState<Report[]>([]);
  const [mode, setMode] = useState<"heat" | "points">("heat");
  const [channel, setChannel] = useState<string>("all");
  const [sel, setSel] = useState<Report | null>(null);

  useEffect(() => {
    const read = () => setReports(loadReports());
    read();
    window.addEventListener("rh:reports-changed", read);
    return () => window.removeEventListener("rh:reports-changed", read);
  }, []);

  const filtered = useMemo(
    () => (channel === "all" ? reports : reports.filter((r) => r.channel === channel)),
    [reports, channel]
  );

  const stats = useMemo(() => {
    const total = reports.length;
    const missing = reports.filter((r) => r.status === "missing").length;
    const trapped = reports.filter((r) => r.status === "trapped_alive").length;
    const found = reports.filter((r) => r.status.startsWith("found")).length;
    const queued = reports.filter((r) => r.sync_state === "queued").length;
    const noGeo = reports.filter((r) => r.last_seen_lat == null).length;
    const clusters = new Set(reports.filter((r) => r.dedup_cluster_id).map((r) => r.dedup_cluster_id)).size;
    return { total, missing, trapped, found, queued, noGeo, clusters };
  }, [reports]);

  // Top hotspots: group by building / address, ranked by summed weight.
  const hotspots = useMemo(() => {
    const m = new Map<string, { key: string; n: number; w: number; trapped: number }>();
    filtered.forEach((r) => {
      const key = r.building_name || r.last_seen_address || "sin ubicación";
      const e = m.get(key) ?? { key, n: 0, w: 0, trapped: 0 };
      e.n++;
      e.w += reportWeight(r);
      if (r.status === "trapped_alive") e.trapped++;
      m.set(key, e);
    });
    return [...m.values()].sort((a, b) => b.w - a.w).slice(0, 6);
  }, [filtered]);

  const exportCsv = () => {
    const cols = ["reference_number", "full_name", "age_approx", "status", "status_source", "last_seen_address", "building_name", "floor", "apartment", "last_seen_lat", "last_seen_lng", "location_accuracy", "channel", "created_at_device", "reporter_count"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...filtered.map((r) => cols.map((c) => esc((r as any)[c])).join(","))].join("\n");
    download(new Blob([csv], { type: "text/csv" }), `${incident.id}-reports.csv`);
  };

  const exportKml = () => {
    const pm = filtered
      .filter((r) => r.last_seen_lat != null)
      .map(
        (r) =>
          `<Placemark><name>${escapeXml(r.full_name)}</name><description>${escapeXml(
            `${r.reference_number} | ${r.status} | ${r.last_seen_address ?? ""} | piso ${r.floor ?? "?"}`
          )}</description><Point><coordinates>${r.last_seen_lng},${r.last_seen_lat},0</coordinates></Point></Placemark>`
      )
      .join("");
    const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${incident.id}</name>${pm}</Document></kml>`;
    download(new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }), `${incident.id}.kml`);
  };

  return (
    <div className="wrap">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Panel de mando</h1>
          <p className="small muted" style={{ margin: 0 }}>
            {incident.name} · {incident.id}
          </p>
        </div>
        <span className="spacer" />
        <button className="btn ghost" onClick={exportCsv}>Exportar CSV</button>
        <button className="btn ghost" onClick={exportKml}>Exportar KML</button>
        <button className="btn ghost" onClick={() => { flushQueue(); }}>Sincronizar cola ({stats.queued})</button>
        <button className="btn ghost" onClick={() => { if (confirm("¿Reiniciar los datos de demostración?")) resetDemo(); }}>Reiniciar demo</button>
      </div>

      <div className="grid cols-4" style={{ marginTop: 20 }}>
        <Stat n={stats.total} l="Reportes" />
        <Stat n={stats.trapped} l="Atrapados con vida" accent="var(--accent-2)" />
        <Stat n={stats.missing} l="Se busca" accent="var(--warn)" />
        <Stat n={stats.found} l="Aparecieron" accent="var(--ok)" />
        <Stat n={stats.clusters} l="Posibles duplicados" />
        <Stat n={stats.noGeo} l="Sin ubicación" />
        <Stat n={stats.queued} l="En cola (offline)" />
        <Stat n={new Set(filtered.map((r) => r.channel)).size} l="Canales activos" />
      </div>

      <div className="row" style={{ margin: "24px 0 12px" }}>
        <div className="chips">
          <button className={`chip ${mode === "heat" ? "on" : ""}`} onClick={() => setMode("heat")}>Mapa de calor</button>
          <button className={`chip ${mode === "points" ? "on" : ""}`} onClick={() => setMode("points")}>Puntos</button>
        </div>
        <span className="spacer" />
        <div className="chips">
          {["all", "pwa", "whatsapp", "sms", "paper", "node", "field"].map((c) => (
            <button key={c} className={`chip ${channel === c ? "on" : ""}`} onClick={() => setChannel(c)}>
              {c === "all" ? "Todos los canales" : c}
            </button>
          ))}
        </div>
      </div>

      <HeatMap reports={filtered} mode={mode} onSelect={setSel} />
      <p className="small muted" style={{ marginTop: 8 }}>
        Intensidad = precisión de la ubicación × urgencia (atrapado con vida ×2,5) × corroboración (cuántas
        personas reportaron a la misma). Los reportes sin ubicación quedan fuera del mapa y se cuentan aparte.
      </p>

      <div className="section-title">Focos prioritarios</div>
      <div className="grid cols-3">
        {hotspots.map((h, i) => (
          <div className="card" key={h.key}>
            <div className="row">
              <h3 style={{ margin: 0 }}>#{i + 1} {h.key}</h3>
              <span className="spacer" />
              {h.trapped > 0 && <span className="badge trapped">{h.trapped} atrapado(s)</span>}
            </div>
            <p style={{ marginTop: 8 }}>
              {h.n} reporte(s) · peso {h.w.toFixed(1)}
            </p>
          </div>
        ))}
      </div>

      <div className="section-title">Reportes recientes</div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Ref.</th>
              <th>Persona</th>
              <th>Ubicación</th>
              <th>Precisión</th>
              <th>Canal</th>
              <th>Estado</th>
              <th>Fuente</th>
              <th>Peso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 25).map((r) => (
              <tr key={r.uuid} onClick={() => setSel(r)} style={{ cursor: "pointer" }}>
                <td className="muted">{r.reference_number}</td>
                <td>
                  {r.full_name}
                  {(r.reporter_count ?? 1) > 1 && <span className="muted small"> ×{r.reporter_count}</span>}
                  {r.medical_info && <div className="small" style={{ color: "var(--accent)" }}>⚕ {r.medical_info}</div>}
                </td>
                <td>
                  {r.last_seen_address}
                  {r.floor && <div className="small muted">piso {r.floor}{r.apartment ? ` apto ${r.apartment}` : ""}</div>}
                </td>
                <td className="muted">{r.location_accuracy}</td>
                <td className="muted">{r.channel}{r.sync_state === "queued" ? " ⏳" : ""}</td>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted small">{r.status_source}</td>
                <td className="muted">{reportWeight(r).toFixed(2)}</td>
                <td>
                  <button
                    className="chip"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateReport(r.uuid, { status: "found_safe", status_source: "verified_field", status_updated_at: new Date().toISOString() });
                    }}
                  >
                    Verificar hallazgo
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="modal-bg" onClick={() => setSel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3 style={{ margin: 0 }}>{sel.full_name}</h3>
              <span className="spacer" />
              <StatusBadge status={sel.status} />
            </div>
            <p className="small muted">{sel.reference_number} · {sel.channel}{sel.node_id ? ` · ${sel.node_id}` : ""}</p>
            <dl className="small" style={{ lineHeight: 1.7 }}>
              <Row k="Edad" v={sel.age_approx ? `~${sel.age_approx}` : "—"} />
              <Row k="Señas" v={sel.distinguishing_info ?? "—"} />
              <Row k="Médico" v={sel.medical_info ?? "—"} />
              <Row k="Última ubicación" v={`${sel.last_seen_address ?? "—"}${sel.floor ? `, piso ${sel.floor}` : ""}${sel.apartment ? `, apto ${sel.apartment}` : ""}`} />
              <Row k="Precisión" v={sel.location_accuracy ?? "—"} />
              <Row k="Reportado por" v={`${sel.reporter_name ?? "—"} (${sel.reporter_relation ?? "—"}) ${sel.reporter_phone ?? ""}`} />
              <Row k="Corroboración" v={`${sel.reporter_count ?? 1} reporte(s)`} />
              <Row k="Sincronización" v={sel.sync_state} />
            </dl>
            <button className="btn block" onClick={() => setSel(null)}>Cerrar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="muted" style={{ minWidth: 130 }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

function Stat({ n, l, accent }: { n: number; l: string; accent?: string }) {
  return (
    <div className="stat">
      <div className="n" style={accent ? { color: accent } : undefined}>{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));
}
