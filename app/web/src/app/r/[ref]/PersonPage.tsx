"use client";
// The landing page of a shared card.
//
// Whoever receives a card lands here and gets three actions:
//   La vi · Yo también busco a alguien · Estoy bien
// Without this loop, every forward is a dead end and the sharing stops paying.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Report, newUuid } from "@/lib/schema";
import { findByReference, addSighting, sightingsFor, updateReport } from "@/lib/store";
import { canListPublicly, toPublicCard } from "@/lib/publicView";
import ShareSheet from "@/components/ShareSheet";
import StatusBadge from "@/components/StatusBadge";

export default function PersonPage({ reference }: { reference: string }) {
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  const [tab, setTab] = useState<"none" | "seen" | "safe">("none");
  const [sightingCount, setSightingCount] = useState(0);

  useEffect(() => {
    const read = () => {
      setReport(findByReference(reference) ?? null);
      setSightingCount(sightingsFor(reference).length);
    };
    read();
    window.addEventListener("rh:reports-changed", read);
    return () => window.removeEventListener("rh:reports-changed", read);
  }, [reference]);

  const card = useMemo(() => (report ? toPublicCard(report) : null), [report]);

  if (report === undefined) {
    return <div className="wrap-narrow"><p className="muted small">Cargando…</p></div>;
  }

  if (!report || !canListPublicly(report)) {
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
        <div className="row" style={{ marginTop: 18 }}>
          <Link className="btn primary" href="/reportar">Reportar a una persona</Link>
          <Link className="btn ghost" href="/buscar">Buscar por nombre</Link>
        </div>
      </div>
    );
  }

  const found = report.status.startsWith("found");

  return (
    <div className="wrap-narrow">
      <div className="card">
        <div className="row" style={{ alignItems: "flex-start" }}>
          {card!.photo && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={card!.photo}
              alt={card!.name}
              style={{
                width: 96,
                height: 96,
                objectFit: "cover",
                borderRadius: 12,
                filter: card!.blurPhoto ? "blur(8px)" : undefined,
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 180 }}>
            <StatusBadge status={report.status} />
            <h1 style={{ fontSize: 26, margin: "10px 0 6px" }}>{card!.name}</h1>
            <p className="small muted">
              {card!.ageLine && `${card!.ageLine} · `}Vist{card!.gsuffix} por última vez: {card!.area}
            </p>
            <p className="small muted" style={{ marginTop: 6 }}>
              Ref. {card!.reference}
              {(report.reporter_count ?? 1) > 1 ? ` · ${report.reporter_count} personas la reportaron` : ""}
              {sightingCount > 0 ? ` · ${sightingCount} aviso(s) recibidos` : ""}
            </p>
          </div>
        </div>
        {card!.blurPhoto && (
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Es menor de edad: el rostro se difumina en la vista pública. Los equipos de rescate sí ven la
            foto original.
          </p>
        )}
      </div>

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
              L{card!.gsuffix} vi / tengo información
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
              gsuffix={card!.gsuffix}
              reference={card!.reference}
              onDone={() => setTab("none")}
            />
          )}

          {tab === "safe" && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3 style={{ marginBottom: 6 }}>¿Confirmas que {card!.name} está bien?</h3>
              <p className="small muted">
                Esto cambia el estado a “apareció” y avisa a quien la reportó. Un equipo de rescate puede
                confirmarlo después en terreno.
              </p>
              <button
                className="btn primary block"
                style={{ marginTop: 12 }}
                onClick={() => {
                  updateReport(report.uuid, {
                    status: "found_safe",
                    status_source: "citizen",
                    status_updated_at: new Date().toISOString(),
                  });
                  setTab("none");
                }}
              >
                Sí, está bien
              </button>
            </div>
          )}
        </>
      )}

      <ShareSheet report={report} />

      <p className="small muted" style={{ marginTop: 18 }}>
        Esta página muestra solo lo que la familia autorizó a publicar. Nunca se muestran teléfonos, ni el
        piso o apartamento, ni la ubicación exacta.
      </p>
    </div>
  );
}

function SightingForm({ reference, gsuffix, onDone }: { reference: string; gsuffix: "a" | "o"; onDone: () => void }) {
  const [where, setWhere] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
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
        <span className="hint">Solo por si el equipo necesita preguntarte algo. No se muestra públicamente.</span>
        <input inputMode="tel" value={contact} onChange={(e) => setContact(e.target.value)} />
      </label>
      <button
        className="btn primary block"
        disabled={!where.trim()}
        onClick={() => {
          addSighting({
            uuid: newUuid(),
            reference_number: reference,
            seen_where: where.trim(),
            seen_when: when ? new Date(when).toISOString() : null,
            note: note.trim() || null,
            contact: contact.trim() || null,
            created_at: new Date().toISOString(),
            source: "public_card",
          });
          setSent(true);
        }}
      >
        Enviar aviso
      </button>
    </div>
  );
}
