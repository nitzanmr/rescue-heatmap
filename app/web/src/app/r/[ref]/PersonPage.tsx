"use client";
// The landing page of a shared card — now served by GET /v1/public/cases/:ref.
//
// Whoever receives a card lands here and gets three actions:
//   La vi · Yo también busco a alguien · Estoy bien
// Without this loop, every forward is a dead end and the sharing stops paying.
//
// Every action here writes a SIGHTING, never a status. An anonymous claim from a
// stranger on the internet is a claim: the panel reviews it. That is not caution
// for its own sake — "she is fine" from the wrong person stops a search.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, ApiError, PublicCase, rememberReporterToken, reporterTokenFor } from "@/lib/api";
import { cardFromPublicCase } from "@/lib/publicView";
import ShareSheet from "@/components/ShareSheet";
import StatusBadge from "@/components/StatusBadge";

export default function PersonPage({ reference }: { reference: string }) {
  const params = useSearchParams();
  const [data, setData] = useState<PublicCase | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"none" | "seen" | "safe">("none");

  // A family arriving from their private link carries ?t=<token>. Capture it and
  // strip it from the address bar: a token in a URL ends up in screenshots, in
  // chat previews and in browser history.
  useEffect(() => {
    const t = params.get("t");
    if (t) {
      rememberReporterToken(reference, t);
      window.history.replaceState({}, "", `/r/${reference}`);
    }
  }, [params, reference]);

  const load = useCallback(async () => {
    try {
      setData(await api.card(reference));
      setError(null);
    } catch (err) {
      const e = err as ApiError;
      if (e.isOffline) {
        setError("Sin conexión. Esta ficha se lee del servidor.");
        setData(null);
      } else if (e.status === 404) {
        setData(null);
      } else {
        setError(e.message);
        setData(null);
      }
    }
  }, [reference]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === undefined) {
    return <div className="wrap-narrow"><p className="muted small">Cargando…</p></div>;
  }

  if (!data) {
    // Deliberately identical message for "does not exist" and "consent withdrawn":
    // otherwise the page becomes an oracle that confirms a reference is real.
    return (
      <div className="wrap-narrow">
        <h1 style={{ fontSize: 22 }}>No encontramos este reporte</h1>
        <p className="muted small">
          El número de referencia <strong>{reference}</strong> no aparece en la búsqueda pública. Puede
          que el enlace esté mal copiado, que el reporte aún no se haya enviado desde el teléfono de quien
          lo hizo, o que la familia haya pedido no aparecer públicamente.
        </p>
        {error && <p className="small" style={{ color: "var(--warn)" }}>{error}</p>}
        <div className="row" style={{ marginTop: 18 }}>
          <Link className="btn primary" href="/reportar">Reportar a una persona</Link>
          <Link className="btn ghost" href="/buscar">Buscar por nombre</Link>
        </div>
      </div>
    );
  }

  const card = cardFromPublicCase(data);
  const found = data.status.startsWith("found");
  const isMine = Boolean(reporterTokenFor(reference));

  return (
    <div className="wrap-narrow">
      <div className="card">
        <div className="row" style={{ alignItems: "flex-start" }}>
          {card.photo && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={card.photo}
              alt={card.name}
              style={{
                width: 96,
                height: 96,
                objectFit: "cover",
                borderRadius: 12,
                filter: card.blurPhoto ? "blur(8px)" : undefined,
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 180 }}>
            <StatusBadge status={data.status as any} />
            <h1 style={{ fontSize: 26, margin: "10px 0 6px" }}>{card.name}</h1>
            <p className="small muted">
              {card.ageLine && `${card.ageLine} · `}Vist{card.gsuffix} por última vez: {card.area}
            </p>
            <p className="small muted" style={{ marginTop: 6 }}>
              Ref. {card.reference}
              {data.reports > 1 ? ` · ${data.reports} personas la reportaron` : ""}
            </p>
          </div>
        </div>
        {card.blurPhoto && (
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Es menor de edad: el rostro se difumina en la vista pública. Los equipos de rescate sí ven la
            foto original.
          </p>
        )}
      </div>

      {isMine && (
        <div className="card" style={{ marginTop: 14, borderColor: "rgba(240,198,116,.4)" }}>
          <p className="small" style={{ margin: 0 }}>
            Este es tu reporte. Puedes corregirlo, avisar que apareció o pedir que se borre desde{" "}
            <Link href={`/mi-reporte/${reference}`}>tu página privada</Link>.
          </p>
        </div>
      )}

      {found ? (
        <div className="card" style={{ marginTop: 16, borderColor: "rgba(63,185,80,.4)" }}>
          <h3 style={{ marginBottom: 6 }}>Esta persona ya apareció ✅</h3>
          <p className="small muted">
            No hace falta seguir compartiendo esta tarjeta. Gracias por ayudar.
          </p>
        </div>
      ) : (
        <>
          <div className="section-title">¿Cómo puedes ayudar?</div>
          <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <button className="btn primary block" onClick={() => setTab(tab === "seen" ? "none" : "seen")}>
              L{card.gsuffix} vi / tengo información
            </button>
            <Link className="btn block" href="/reportar">
              Yo también busco a alguien
            </Link>
            <button className="btn ghost block" onClick={() => setTab(tab === "safe" ? "none" : "safe")}>
              Soy yo / estoy bien
            </button>
          </div>

          {tab === "seen" && (
            <SightingForm
              gsuffix={card.gsuffix}
              reference={card.reference}
              kind="seen"
              onDone={() => {
                setTab("none");
                void load();
              }}
            />
          )}

          {tab === "safe" && (
            <SafeForm
              name={card.name}
              reference={card.reference}
              onDone={() => {
                setTab("none");
                void load();
              }}
            />
          )}
        </>
      )}

      <ShareSheet card={card} />

      <p className="small muted" style={{ marginTop: 18 }}>
        Esta página muestra solo lo que la familia autorizó a publicar. Nunca se muestran teléfonos, ni el
        piso o apartamento, ni la ubicación exacta.
      </p>
    </div>
  );
}

function SafeForm({ name, reference, onDone }: { name: string; reference: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="card" style={{ marginTop: 14, borderColor: "rgba(63,185,80,.4)" }}>
        <h3 style={{ marginBottom: 6 }}>Gracias — tu aviso quedó registrado</h3>
        <p className="small muted">
          Un equipo lo revisa antes de cambiar el estado. No cambiamos nada en silencio: si alguien se
          equivoca, un rescate no debe detenerse por eso.
        </p>
        <button className="btn ghost block" style={{ marginTop: 12 }} onClick={onDone}>Cerrar</button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 6 }}>¿Confirmas que {name} está bien?</h3>
      <p className="small muted">
        Se envía como un aviso al centro de coordinación. El estado cambia cuando un equipo lo revisa.
      </p>
      {err && <p className="small" style={{ color: "var(--warn)" }}>{err}</p>}
      <button
        className="btn primary block"
        style={{ marginTop: 12 }}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await api.sighting(reference, { kind: "safe", note: "Aviso desde la ficha pública compartida." });
            setSent(true);
          } catch (e) {
            setErr((e as ApiError).isOffline ? "Sin conexión. Intenta de nuevo cuando vuelva la señal." : (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Enviando…" : "Sí, está bien"}
      </button>
    </div>
  );
}

function SightingForm({
  reference,
  gsuffix,
  kind,
  onDone,
}: {
  reference: string;
  gsuffix: "a" | "o";
  kind: "seen";
  onDone: () => void;
}) {
  const [where, setWhere] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="card" style={{ marginTop: 14, borderColor: "rgba(63,185,80,.4)" }}>
        <h3 style={{ marginBottom: 6 }}>Gracias — tu aviso quedó registrado</h3>
        <p className="small muted">
          Un equipo lo revisa antes de cambiar el estado. No cambiamos nada en silencio.
        </p>
        <button className="btn ghost block" style={{ marginTop: 12 }} onClick={onDone}>
          Cerrar
        </button>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.sighting(reference, {
        kind,
        // The place goes in the note, not in coordinates we do not have. A made-up
        // pin is worse than a sentence a human can read.
        note: [where.trim(), note.trim()].filter(Boolean).join(" — ") || null,
        reported_at: when ? new Date(when).toISOString() : null,
        contact_phone: contact.trim() || null,
      });
      setSent(true);
    } catch (e) {
      const ae = e as ApiError;
      setErr(
        ae.isOffline
          ? "Sin conexión. Vuelve a intentarlo cuando tengas señal."
          : ae.status === 429
            ? "Demasiados avisos seguidos desde esta conexión. Espera un momento."
            : ae.message
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 8 }}>¿Dónde l{gsuffix} viste?</h3>
      <label className="field">
        <span className="lab">Lugar <span className="req">*</span></span>
        <span className="hint">Un albergue, un hospital, una calle. Aunque no sepas la dirección exacta.</span>
        <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Ej: albergue del Coliseo Municipal" />
      </label>
      <label className="field">
        <span className="lab">¿Cuándo?</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label className="field">
        <span className="lab">Algo más que ayude</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="field">
        <span className="lab">Tu teléfono (opcional)</span>
        <span className="hint">Solo para que un equipo pueda confirmarlo contigo. No se publica.</span>
        <input inputMode="tel" value={contact} onChange={(e) => setContact(e.target.value)} />
      </label>
      {err && <p className="small" style={{ color: "var(--warn)" }}>{err}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={onDone}>Cancelar</button>
        <button className="btn primary" style={{ flex: 1 }} disabled={busy || !where.trim()} onClick={() => void submit()}>
          {busy ? "Enviando…" : "Enviar aviso"}
        </button>
      </div>
    </div>
  );
}
