"use client";
// The structure board — the screen a rescue team is dispatched from.
//
// The dedup queue asks "are these two records one person". This asks the other
// operational question, the one a target dossier is written by hand to answer:
// which building, how many people still unaccounted for inside it, and has
// anyone signed it clear.
//
// Two rules shape everything below:
//
//   1. "Clear" is never a button that simply works. It is refused while anyone
//      inside is unresolved, and the refusal NAMES them. A disabled control that
//      will not say why reads as broken — and here the meaning of the click is
//      "stop digging".
//   2. A coarse point is never dressed up as an address. A structure known only
//      to street level says so, in words, next to its head-count.
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api, ApiError, StructurePerson, StructureRow } from "@/lib/api";

const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  ssr: false,
  loading: () => <div className="small muted">Cargando mapa…</div>,
});

const SCAN_LABEL: Record<string, string> = {
  not_scanned: "Sin buscar",
  in_progress: "Búsqueda en curso",
  partial: "Búsqueda parcial",
  clear: "Despejada — firmada",
  unsafe: "Insegura",
  unreachable: "Inaccesible",
};

const RESOLUTION_LABEL: Record<string, string> = {
  unresolved: "Sin resolver",
  recovered_alive: "Rescatada con vida",
  recovered_deceased: "Fallecida",
  not_at_structure: "No estaba en esta estructura",
  withdrawn: "Retirada",
};

// Said in words, not as a colour. "Street level" is a 150–200 m circle: that is
// the difference between a door and a block, and a team deserves the number.
const PRECISION_LABEL: Record<string, string> = {
  building: "punto de edificio",
  street: "solo calle (±150–200 m)",
  area: "solo barrio (±800 m)",
  town: "solo ciudad (±5 km)",
};

export default function StructureBoard() {
  const [rows, setRows] = useState<StructureRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.structures();
      setRows(r.structures);
      setErr("");
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // A dispatch board goes stale the moment two people use it: one signs a
    // structure clear while the other is still reading the old count.
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const openTotal = rows.reduce((n, r) => n + Number(r.open_people), 0);
  const unpinned = rows.filter((r) => r.point_precision !== "building").length;

  return (
    <>
      <div className="section-title">Estructuras — a dónde se envía un equipo</div>
      <p className="small muted" style={{ marginTop: -8 }}>
        Un edificio con personas nombradas dentro. Ninguna estructura se marca despejada mientras
        quede alguien sin resolver: esa frase es la que hace que se deje de excavar, y la firma
        queda registrada con nombre y hora.
      </p>

      {err && <p className="small" style={{ color: "var(--warn)" }}>{err}</p>}

      {rows.length === 0 ? (
        <div className="card">
          <p className="small muted" style={{ margin: 0 }}>
            {loading ? "Cargando…" : "Todavía no hay estructuras cargadas."}
          </p>
        </div>
      ) : (
        <>
          <p className="small muted">
            {rows.length} estructura(s) · {openTotal} persona(s) sin resolver ·{" "}
            {unpinned > 0
              ? `${unpinned} sin punto de edificio — hay que fijar el pin antes de despachar`
              : "todas con punto de edificio"}
          </p>
          <div className="grid cols-2">
            {rows.map((s) => (
              <StructureCard
                key={s.id}
                s={s}
                open={openId === s.id}
                onToggle={() => setOpenId(openId === s.id ? null : s.id)}
                onChanged={() => void load()}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function StructureCard({
  s, open, onToggle, onChanged,
}: { s: StructureRow; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const [people, setPeople] = useState<StructurePerson[]>([]);
  const [blockers, setBlockers] = useState<{ name_raw: string | null; reference_number: string }[] | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      const d = await api.structure(s.id);
      setPeople(d.people);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  }, [s.id]);

  useEffect(() => { if (open) void loadDetail(); }, [open, loadDetail]);

  const scan = async (state: string) => {
    setBusy(true); setErr(""); setMsg(""); setBlockers(null);
    try {
      await api.setStructureScan(s.id, { scan_state: state });
      onChanged();
      if (open) await loadDetail();
    } catch (e) {
      const ae = e as ApiError;
      // The server answers a refused "clear" with the people who are blocking
      // it. Showing them is the whole point: the operator now knows exactly
      // what work stands between here and a signature.
      if (ae.code === "structure_has_open_cases" && Array.isArray(ae.details.blockers)) {
        setBlockers(ae.details.blockers as { name_raw: string | null; reference_number: string }[]);
      } else {
        setErr(ae.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const savePin = async () => {
    if (!point) return;
    setBusy(true); setErr("");
    try {
      // 'building' is what a person placing a pin on the map is asserting, and
      // the API offers nothing more precise: staff work is never a GPS fix.
      await api.setStructurePoint(s.id, { ...point, precision: "building", source: "operator_pin" });
      setPinning(false); setPoint(null);
      onChanged();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const project = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await api.projectStructurePoint(s.id, "punto de la estructura");
      setMsg(
        r.cases_located === 0
          ? "Nadie ganó ubicación: todas las personas de esta estructura ya tenían punto propio."
          : `${r.cases_located} persona(s) de esta estructura ya aparecen en el mapa.`
      );
      onChanged();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (caseId: string, resolution: StructurePerson["resolution"]) => {
    setBusy(true); setErr(""); setBlockers(null);
    try {
      await api.resolveStructureCase(s.id, caseId, { resolution });
      await loadDetail();
      onChanged();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const coarse = s.point_precision !== "building";

  return (
    <div className="card">
      <div className="row">
        <strong>{s.name}</strong>
        <span className="spacer" />
        <span className="small muted">{SCAN_LABEL[s.scan_state] ?? s.scan_state}</span>
      </div>
      {s.address_text && <p className="small" style={{ margin: "4px 0 0" }}>{s.address_text}</p>}
      <p className="small muted" style={{ margin: "4px 0 0" }}>
        {s.open_people} sin resolver de {s.people}
        {Number(s.open_minors) > 0 ? ` · ${s.open_minors} menor(es)` : ""}
        {Number(s.open_elderly) > 0 ? ` · ${s.open_elderly} de 65+` : ""}
        {Number(s.recovered_alive) > 0 ? ` · ${s.recovered_alive} con vida` : ""}
      </p>

      {/* Location honesty. A structure with no point, or a point that is really
          a neighbourhood, must never look like an address on a card. */}
      <p className="small" style={{ margin: "6px 0 0", color: coarse ? "var(--warn)" : "var(--muted)" }}>
        {s.point_precision
          ? `Ubicación: ${PRECISION_LABEL[s.point_precision] ?? s.point_precision}`
          : "Sin punto en el mapa"}
        {" — "}{s.location_action}
      </p>

      {s.scan_state === "clear" && s.scan_signed_by && (
        <p className="small" style={{ margin: "6px 0 0", color: "var(--ok, #2e7d32)" }}>
          Despejada por {s.scan_signed_by}
          {s.scan_signed_at ? ` · ${new Date(s.scan_signed_at).toLocaleString("es")}` : ""}
        </p>
      )}
      {s.authority_status !== "confirmed" && (
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          Sin verificar con las autoridades: no sabemos quién ya fue rescatado aquí.
        </p>
      )}

      <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
        <button className="btn ghost" onClick={onToggle}>
          {open ? "Ocultar personas" : `Ver personas (${s.people})`}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setPinning(!pinning)}>
          {s.lat == null ? "Fijar punto" : "Corregir punto"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void project()}>
          Pasar el punto a las personas
        </button>
      </div>

      <div className="chips" style={{ marginTop: 8 }}>
        {(["not_scanned", "in_progress", "partial", "unsafe", "unreachable", "clear"] as const).map((st) => (
          <button
            key={st}
            className={`chip ${s.scan_state === st ? "on" : ""}`}
            disabled={busy}
            onClick={() => void scan(st)}
          >
            {SCAN_LABEL[st]}
          </button>
        ))}
      </div>

      {/* Never a silent no. */}
      {blockers && (
        <div
          className="small"
          style={{
            marginTop: 10, padding: "8px 10px", borderRadius: 8,
            border: "1px solid var(--warn)", color: "var(--warn)", lineHeight: 1.5,
          }}
        >
          <strong>No se puede despejar todavía.</strong> Faltan {blockers.length} persona(s) por
          resolver en esta estructura:{" "}
          {blockers.slice(0, 6).map((b) => b.name_raw ?? b.reference_number).join(", ")}
          {blockers.length > 6 ? ` y ${blockers.length - 6} más` : ""}. Resuelva cada una
          (rescatada / fallecida / no estaba aquí) y vuelva a firmar.
        </div>
      )}
      {msg && <p className="small muted" style={{ marginTop: 8 }}>{msg}</p>}
      {err && <p className="small" style={{ color: "var(--warn)", marginTop: 8 }}>{err}</p>}

      {pinning && (
        <div style={{ marginTop: 10 }}>
          <LocationPicker
            lat={point?.lat ?? s.lat ?? undefined}
            lng={point?.lng ?? s.lng ?? undefined}
            onPick={(lat, lng) => setPoint({ lat, lng })}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={!point || busy} onClick={() => void savePin()}>
              {busy ? "Guardando…" : "Guardar punto de edificio"}
            </button>
            <button className="btn ghost" onClick={() => { setPinning(false); setPoint(null); }}>
              Cancelar
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 6 }}>
            Queda registrado quién puso este punto y cuándo. Un equipo conduce hasta aquí.
          </p>
        </div>
      )}

      {open && (
        <div style={{ marginTop: 12 }}>
          {people.length === 0 && <p className="small muted">Nadie vinculado todavía.</p>}
          {people.map((p) => (
            <div key={p.case_id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
              <div className="row">
                <span>
                  <strong>{p.name_raw ?? "Sin nombre"}</strong>{" "}
                  <span className="small muted">
                    {p.age_approx ? `~${p.age_approx} años · ` : ""}{p.reference_number}
                    {p.is_minor ? " · menor" : ""}
                    {p.has_point ? "" : " · sin punto"}
                  </span>
                </span>
                <span className="spacer" />
                <span className="small muted">{RESOLUTION_LABEL[p.resolution]}</span>
              </div>
              <div className="chips" style={{ marginTop: 6 }}>
                {(["unresolved", "recovered_alive", "recovered_deceased", "not_at_structure"] as const).map((r) => (
                  <button
                    key={r}
                    className={`chip ${p.resolution === r ? "on" : ""}`}
                    disabled={busy}
                    onClick={() => void resolve(p.case_id, r)}
                  >
                    {RESOLUTION_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="small muted" style={{ marginTop: 8 }}>
            Resolver aquí dice solo que ya no se busca a esa persona <em>en este edificio</em>. El
            estado de la persona (rescatada, fallecida) se cambia en su ficha, con su propia firma.
          </p>
        </div>
      )}
    </div>
  );
}
