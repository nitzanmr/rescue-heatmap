"use client";
// The command panel, served by /v1/panel/* with an operator token.
//
// The screen that matters here is the DEDUP QUEUE. Everything else — the map,
// the export — exists in some form in every incident tool. The queue is the
// thing this system was built for, and it is the thing a human must not be
// allowed to skip: a merge is never automatic, and the operator is shown the
// score AND the signals behind it so they can audit the machine rather than
// trust it.
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, ApiError, HeatCell, MergeRecord, operatorToken, setOperatorToken } from "@/lib/api";
import { incident } from "@/lib/incident";
import StatusBadge from "@/components/StatusBadge";

const HeatMap = dynamic(() => import("@/components/HeatMap"), {
  ssr: false,
  loading: () => (
    <div className="map" style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>
      Cargando mapa…
    </div>
  ),
});

export default function Panel() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(Boolean(operatorToken()));
  }, []);

  if (authed === null) return <div className="wrap"><p className="muted small">…</p></div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <PanelBody onSignOut={() => { setOperatorToken(null); setAuthed(false); }} />;
}

// There is no password login endpoint in the API, and inventing one in the
// browser would be the worst possible place to invent authentication. An
// operator token is minted server-side (`make operator-token`) and pasted here.
function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr("");
    setOperatorToken(token.trim());
    try {
      await api.dedupQueue(1); // the token is only real if the API accepts it
      onDone();
    } catch (e) {
      setOperatorToken(null);
      const ae = e as ApiError;
      setErr(ae.status === 401 ? "Ese token no es válido o expiró." : ae.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap-narrow">
      <h1 style={{ fontSize: 24 }}>Panel de mando</h1>
      <p className="small muted">
        Acceso restringido a personal de coordinación. El token se genera en el servidor
        (<code>make operator-token</code>) y se pega aquí una sola vez.
      </p>
      <label className="field">
        <span className="lab">Token de operador</span>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="…" type="password" />
      </label>
      {err && <p className="small" style={{ color: "var(--warn)" }}>{err}</p>}
      <button className="btn primary block" disabled={busy || !token.trim()} onClick={() => void submit()}>
        {busy ? "Verificando…" : "Entrar"}
      </button>
    </div>
  );
}

function PanelBody({ onSignOut }: { onSignOut: () => void }) {
  const [pending, setPending] = useState<any[]>([]);
  const [merges, setMerges] = useState<MergeRecord[]>([]);
  const [cells, setCells] = useState<HeatCell[]>([]);
  const [cellM, setCellM] = useState(100);
  const [mode, setMode] = useState<"heat" | "points">("heat");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [q, h, m] = await Promise.all([
        api.dedupQueue(50),
        api.panelHeat(cellM),
        api.merges(20),
      ]);
      setPending(q.pending);
      setMerges(m.merges);
      setCells(h.cells);
      setCellM(h.cell_m);
      setError(null);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.status === 401) {
        onSignOut();
        return;
      }
      setError(ae.isOffline ? "Sin conexión con el servidor." : ae.message);
    } finally {
      setLoading(false);
    }
  }, [cellM, onSignOut]);

  useEffect(() => {
    void load();
    // The queue changes while the operator looks at it: the worker keeps
    // correlating. 15 s is short enough to feel live and long enough not to
    // fight the intake for database connections during a surge.
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const download = async (format: "csv" | "geojson" | "kml") => {
    try {
      const blob = await api.exportBlob(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${incident.id}.${format === "geojson" ? "geojson" : format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const totalCases = cells.reduce((n, c) => n + c.cases, 0);

  return (
    <div className="wrap">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Panel de mando</h1>
          <p className="small muted" style={{ margin: 0 }}>{incident.name}</p>
        </div>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => void download("csv")}>Exportar CSV</button>
        <button className="btn ghost" onClick={() => void download("geojson")}>GeoJSON</button>
        <button className="btn ghost" onClick={() => void download("kml")}>KML</button>
        <button className="btn ghost" onClick={() => void load()}>{loading ? "…" : "Actualizar"}</button>
        <button className="btn ghost" onClick={onSignOut}>Salir</button>
      </div>

      {error && <p className="small" style={{ color: "var(--warn)" }}>{error}</p>}

      <div className="grid cols-4" style={{ marginTop: 20 }}>
        <Stat n={pending.length} l="Duplicados por revisar" accent="var(--accent-2)" />
        <Stat n={totalCases} l="Casos con ubicación" />
        <Stat n={cells.length} l="Celdas activas" />
        <Stat n={cellM} l="Tamaño de celda (m)" />
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="section-title">Posibles duplicados — decisión humana</div>
      <p className="small muted" style={{ marginTop: -8 }}>
        El motor propone; nadie une nada solo. Una unión equivocada hace que un equipo deje de buscar a
        alguien que sigue bajo los escombros — por eso cada par se revisa y toda decisión queda auditada.
      </p>

      {pending.length === 0 ? (
        <div className="card">
          <p className="small muted" style={{ margin: 0 }}>
            {loading ? "Cargando…" : "No hay pares pendientes de revisión."}
          </p>
        </div>
      ) : (
        <div className="grid cols-2">
          {pending.map((p) => (
            <DedupPair key={p.id} pair={p} onDecided={() => void load()} />
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      <MergeLedger merges={merges} onChanged={() => void load()} />

      {/* ---------------------------------------------------------------- */}
      <div className="section-title">Mapa operativo</div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="chips">
          <button className={`chip ${mode === "heat" ? "on" : ""}`} onClick={() => setMode("heat")}>Mapa de calor</button>
          <button className={`chip ${mode === "points" ? "on" : ""}`} onClick={() => setMode("points")}>Celdas</button>
        </div>
        <span className="spacer" />
        <div className="chips">
          {[50, 100, 250, 500].map((m) => (
            <button key={m} className={`chip ${cellM === m ? "on" : ""}`} onClick={() => setCellM(m)}>
              {m} m
            </button>
          ))}
        </div>
      </div>

      <HeatMap cells={cells} mode={mode} cellM={cellM} />
      <p className="small muted" style={{ marginTop: 8 }}>
        El servidor agrupa los casos en celdas de {cellM} m antes de enviarlos: este navegador nunca recibe
        la ubicación de una persona concreta. La intensidad combina precisión de la ubicación, urgencia
        (atrapado con vida pesa más) y corroboración. Los casos sin ubicación no aparecen en el mapa.
      </p>
    </div>
  );
}

// One candidate pair. Everything the operator needs to disagree with the machine
// is on the card: both records, the score, and each signal that produced it.
function DedupPair({ pair, onDecided }: { pair: any; onDecided: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const decide = async (decision: "merge" | "reject", survivor?: string) => {
    setBusy(decision);
    setErr("");
    try {
      await api.decide(String(pair.id), { decision, survivor_case_id: survivor });
      onDecided();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  const signals: Record<string, unknown> = pair.signals ?? {};

  return (
    <div className="card">
      <div className="row">
        <strong>Puntuación {Number(pair.score).toFixed(2)}</strong>
        <span className="spacer" />
        <span className="small muted">{new Date(pair.created_at).toLocaleString("es")}</span>
      </div>

      <div className="grid cols-2" style={{ marginTop: 10 }}>
        <Side ref_={pair.a_ref} name={pair.a_name} age={pair.a_age} reports={pair.a_reports} status={pair.a_status} />
        <Side ref_={pair.b_ref} name={pair.b_name} age={pair.b_age} reports={pair.b_reports} status={pair.b_status} />
      </div>

      <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
        {Object.entries(signals).length === 0
          ? "Sin detalle de señales."
          : Object.entries(signals).map(([k, v]) => (
              <span key={k} style={{ marginRight: 10 }}>
                {k}: <strong style={{ color: "var(--text)" }}>{typeof v === "number" ? v.toFixed(2) : String(v)}</strong>
              </span>
            ))}
      </div>

      {err && <p className="small" style={{ color: "var(--warn)" }}>{err}</p>}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn ghost" style={{ flex: 1 }} disabled={!!busy} onClick={() => void decide("reject")}>
          Son personas distintas
        </button>
        <button className="btn" style={{ flex: 1 }} disabled={!!busy} onClick={() => void decide("merge", pair.a_case)}>
          Unir → {pair.a_ref}
        </button>
        <button className="btn" style={{ flex: 1 }} disabled={!!busy} onClick={() => void decide("merge", pair.b_case)}>
          Unir → {pair.b_ref}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
        Unir es reversible: los reportes, avistamientos, fotos y el enlace privado de la familia se
        reasignan al caso que queda, y quedan registrados para poder devolverlos. Si se equivoca,
        use «Deshacer» en «Uniones recientes», más abajo.
      </p>
    </div>
  );
}

// The merge ledger. This section exists because the card above promises the
// operator that a merge can be taken back, and a promise with no button is a
// lie told at the worst possible moment. Undoing returns the pair to the queue:
// "I was wrong" is not the same statement as "these are different people".
function MergeLedger({ merges, onChanged }: { merges: MergeRecord[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const undo = async (m: MergeRecord) => {
    setBusy(m.id);
    setErr("");
    try {
      await api.undoMerge(m.id);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="section-title">Uniones recientes</div>
      {merges.length === 0 ? (
        <div className="card">
          <p className="small muted" style={{ margin: 0 }}>Todavía no se ha unido ningún caso.</p>
        </div>
      ) : (
        <div className="card">
          {err && <p className="small" style={{ color: "var(--warn)" }}>{err}</p>}
          {merges.map((m) => (
            <div
              key={m.id}
              className="row"
              style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", gap: 10 }}
            >
              <div style={{ minWidth: 0 }}>
                <div>
                  <strong>{m.merged_name ?? m.merged_ref}</strong>{" "}
                  <span className="muted">→</span>{" "}
                  <strong>{m.survivor_name ?? m.survivor_ref}</strong>
                </div>
                <p className="small muted" style={{ margin: "4px 0 0" }}>
                  {new Date(m.at).toLocaleString("es")} · {m.actor} · {m.moved_reports} reporte(s)
                  {" "}· Ref. {m.merged_ref} → {m.survivor_ref}
                </p>
                {!m.fully_recorded && (
                  <p className="small" style={{ margin: "4px 0 0", color: "var(--warn)" }}>
                    Unión anterior al registro completo: al deshacer se devuelven los reportes, pero
                    no se puede garantizar la devolución de fotos, avistamientos ni del enlace
                    privado. Revise el caso después.
                  </p>
                )}
              </div>
              <span className="spacer" />
              <button className="btn ghost" disabled={busy === m.id} onClick={() => void undo(m)}>
                {busy === m.id ? "Deshaciendo…" : "Deshacer"}
              </button>
            </div>
          ))}
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            Deshacer devuelve el par a la cola de revisión, no lo descarta. Toda unión y toda
            reversión quedan en la auditoría.
          </p>
        </div>
      )}
    </>
  );
}

function Side({ ref_, name, age, reports, status }: { ref_: string; name: string; age: number | null; reports: number; status: string }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10 }}>
      <div className="row">
        <strong>{name}</strong>
        <span className="spacer" />
        <StatusBadge status={status as any} />
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        {age ? `~${age} años · ` : ""}Ref. {ref_}
        {reports > 1 ? ` · ${reports} reportes` : ""}
      </p>
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
