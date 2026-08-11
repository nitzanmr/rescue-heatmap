"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, PublicCase } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import { incident } from "@/lib/incident";

// PUBLIC view, served by GET /v1/public/search.
//
// There is no "show me everything" mode and there never will be: without a name
// this page is a downloadable list of vulnerable people, which is exactly what
// ADR-001 says we do not build. The API enforces the same rule (q is required,
// minimum 3 characters) — this is the second lock, not the only one.
export default function Buscar() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "missing" | "trapped_alive" | "found_safe">("all");
  const [results, setResults] = useState<PublicCase[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const run = useCallback(async (term: string, st: string) => {
    const mine = ++seq.current;
    if (term.trim().length < 3) {
      setResults(null);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.search(term.trim(), {
        status: st === "all" ? undefined : st,
        limit: 20,
      });
      if (mine !== seq.current) return; // a newer keystroke already won
      setResults(res.results);
      setHasMore(res.has_more);
    } catch (err) {
      if (mine !== seq.current) return;
      const e = err as ApiError;
      setResults([]);
      setError(
        e.isOffline
          ? "Sin conexión. La búsqueda necesita señal; reportar no."
          : e.status === 429
            ? "Demasiadas búsquedas seguidas. Espera unos segundos."
            : e.message
      );
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  // Debounced: every keystroke is a rate-limited request against a server that
  // is also taking reports. 400 ms costs the user nothing and the server a lot.
  useEffect(() => {
    const t = setTimeout(() => void run(q, status), 400);
    return () => clearTimeout(t);
  }, [q, status, run]);

  const tooShort = q.trim().length > 0 && q.trim().length < 3;

  return (
    <div className="wrap">
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Buscar personas reportadas</h1>
      <p className="small muted">
        Vista pública. No se muestran teléfonos, pisos ni ubicaciones exactas. Solo aparecen las personas
        cuyo reporte autorizó la publicación, y las fotos solo si se autorizó por separado. Las fotos de
        menores se difuminan automáticamente.
      </p>

      <div className="row" style={{ margin: "18px 0" }}>
        <input
          style={{ maxWidth: 380 }}
          placeholder="Escribe un nombre (mínimo 3 letras)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="chips">
          {(
            [
              ["all", "Todos"],
              ["missing", "Se busca"],
              ["trapped_alive", "Atrapados"],
              ["found_safe", "Aparecieron"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={`chip ${status === v ? "on" : ""}`} onClick={() => setStatus(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* The empty state is the normal state here, so it has to do real work:
          explain WHY there is no list, and offer the two things worth doing. */}
      {results === null && (
        <div className="card" style={{ marginTop: 8 }}>
          <h3 style={{ marginTop: 0 }}>Busca por nombre</h3>
          <p className="small muted">
            No publicamos la lista completa de personas desaparecidas. Escribe el nombre de quien buscas —
            aunque lo escribas distinto a como lo escribió la familia, el buscador tolera variaciones de
            ortografía y acentos.
          </p>
          {tooShort && <p className="small muted">Necesitamos al menos 3 letras.</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <Link className="btn primary" href="/reportar">Reportar a una persona</Link>
          </div>
        </div>
      )}

      {error && (
        <p className="small" style={{ color: "var(--warn)" }}>{error}</p>
      )}

      {results !== null && (
        <p className="small muted">
          {busy ? "Buscando…" : `${results.length}${hasMore ? "+" : ""} resultado(s) para “${q.trim()}”`}
        </p>
      )}

      <div className="grid cols-3" style={{ marginTop: 12 }}>
        {(results ?? []).map((r) => (
          <div className="card" key={r.reference_number}>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div>
                <h3 style={{ marginBottom: 4 }}>{r.name}</h3>
                <p className="small">
                  {r.age_approx ? `~${r.age_approx} años · ` : ""}
                  {/* The API returns a COARSE point (~1 km), never an address.
                      There is nothing finer to display even if we wanted to. */}
                  {r.area ? `${incident.city || incident.country} (zona aproximada)` : "Zona no informada"}
                </p>
              </div>
              <span className="spacer" />
              <StatusBadge status={r.status as any} />
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Ref. {r.reference_number}
              {r.reports > 1 ? ` · ${r.reports} personas la reportaron` : ""}
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <Link className="btn ghost" style={{ flex: 1 }} href={`/r/${r.reference_number}`}>
                Ver ficha y compartir
              </Link>
            </div>
          </div>
        ))}
      </div>

      {results !== null && results.length === 0 && !busy && !error && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="small muted" style={{ marginTop: 0 }}>
            No encontramos a nadie con ese nombre. Puede que todavía no lo hayan reportado, o que la
            familia haya pedido que no aparezca públicamente — en ese caso el reporte sí llegó a los
            equipos de rescate aunque no se vea aquí.
          </p>
          <Link className="btn primary" href="/reportar">Reportar a esta persona</Link>
        </div>
      )}
    </div>
  );
}
