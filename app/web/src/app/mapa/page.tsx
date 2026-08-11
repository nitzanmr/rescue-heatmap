"use client";
// /mapa — the public map.
//
// This page exists because of what Venezuela Reporta actually got traffic for:
// not "search for my missing relative", but "where do I go". A page that answers
// that is shared by people who have not lost anybody, and that is the only way
// the reporting form reaches the people who have.
//
// It reads two public endpoints and holds no token. There is no code path from
// here to /v1/panel/*.
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { api, ApiError, type AidSite, type HeatCell } from "@/lib/api";
import { incident } from "@/lib/incident";
import { KIND_STYLE } from "@/lib/aid-kinds";

const PublicMap = dynamic(() => import("@/components/PublicMap"), {
  ssr: false,
  loading: () => (
    <div className="map map-light" style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>
      Cargando mapa…
    </div>
  ),
});

// Public heat is never finer than 500 m — the server enforces a 250 m floor, and
// we stay well above it. A tight cell with few cases is an address.
const CELL_M = 500;

export default function MapaPage() {
  const [cells, setCells] = useState<HeatCell[]>([]);
  const [sites, setSites] = useState<AidSite[]>([]);
  const [showHeat, setShowHeat] = useState(true);
  const [showSites, setShowSites] = useState(true);
  // Schools and community centres are OFF by default: they are candidates, not
  // open shelters, and sending somebody to a locked gate costs more than the
  // extra tap costs us.
  const [showCandidates, setShowCandidates] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    const [heat, aid] = await Promise.allSettled([api.publicHeat(CELL_M), api.aidSites({ country: incident.countryCode })]);
    if (heat.status === "fulfilled") setCells(heat.value.cells);
    if (aid.status === "fulfilled") setSites(aid.value.sites);
    // Half a map is still useful: if the aid layer is up and the heat layer is
    // down, a person still learns where the nearest hospital is. Only a total
    // failure is reported as one.
    if (heat.status === "rejected" && aid.status === "rejected") {
      const e = heat.reason as ApiError;
      setErr(e?.isOffline ? "Sin conexión. El mapa se mostrará cuando vuelva la red." : "No se pudo cargar el mapa.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Shelters open and fill during an event. Five minutes matches the server's
    // cache header, so this costs nothing extra when nothing has changed.
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [load]);

  const visible = showCandidates ? sites : sites.filter((s) => s.kind !== "shelter_candidate");
  const counts = visible.reduce<Record<string, number>>((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});

  return (
    <div className="wrap">
      <h1 style={{ marginBottom: 6 }}>Mapa de la emergencia</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {incident.name}. Dónde pedir ayuda, y dónde se concentran los reportes.{" "}
        <Link href="/buscar">¿Busca a una persona?</Link> · <Link href="/reportar">Reportar a alguien</Link>
      </p>

      <div className="chips" style={{ margin: "14px 0" }}>
        <button className={`chip ${showSites ? "on" : ""}`} onClick={() => setShowSites((v) => !v)}>
          Sitios de ayuda ({visible.length})
        </button>
        <button className={`chip ${showHeat ? "on" : ""}`} onClick={() => setShowHeat((v) => !v)}>
          Zonas con reportes ({cells.length})
        </button>
        <button className={`chip ${showCandidates ? "on" : ""}`} onClick={() => setShowCandidates((v) => !v)}>
          Incluir posibles albergues
        </button>
      </div>

      {err && <p className="muted small">{err}</p>}
      {loading && !cells.length && !sites.length && <p className="muted small">Cargando…</p>}

      <PublicMap cells={cells} sites={visible} showHeat={showHeat} showSites={showSites} cellM={CELL_M} />

      <div className="chips" style={{ marginTop: 12 }}>
        {Object.entries(counts).map(([kind, n]) => (
          <span key={kind} className="chip" style={{ borderColor: (KIND_STYLE[kind] ?? KIND_STYLE.other).colour }}>
            <span
              style={{
                display: "inline-block",
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: (KIND_STYLE[kind] ?? KIND_STYLE.other).colour,
                marginRight: 6,
              }}
            />
            {(KIND_STYLE[kind] ?? KIND_STYLE.other).label} · {n}
          </span>
        ))}
      </div>

      <p className="muted small" style={{ marginTop: 18, maxWidth: 720, lineHeight: 1.6 }}>
        Las zonas de calor son agregados: cada celda representa {CELL_M} m y sólo aparece con dos o más casos. El mapa
        nunca muestra la ubicación de una persona. Los sitios marcados con borde punteado provienen de datos abiertos y{" "}
        <strong>no han sido verificados en terreno</strong>: confirme por teléfono antes de desplazarse.
      </p>
    </div>
  );
}
