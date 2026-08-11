"use client";
// The "share now" moment.
//
// The instant a family finishes a report is the instant they are most willing to
// broadcast it — and the moment we currently waste. Everything here is generated
// on the device, so it works with no signal: the card renders offline, the link
// only becomes useful once the report syncs.
import { useEffect, useState } from "react";
import { PublicCardData } from "@/lib/publicView";
import {
  CardFormat,
  canShareFiles,
  downloadFile,
  renderCardDataUrl,
  renderCardFile,
  shareText,
  whatsappShareUrl,
} from "@/lib/share";

export default function ShareSheet({
  card,
  compact = false,
  queued = false,
}: {
  card: PublicCardData;
  compact?: boolean;
  /** The report is still in the device outbox: the link does not resolve yet. */
  queued?: boolean;
}) {
  const [format, setFormat] = useState<CardFormat>("story");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    setPreview(null);
    renderCardDataUrl(card, format)
      .then((url) => alive && setPreview(url))
      .catch(() => alive && setMsg("No se pudo generar la imagen. Puedes compartir el enlace igual."));
    return () => {
      alive = false;
    };
  }, [card, format]);

  const withFile = async (fn: (f: File) => Promise<void> | void) => {
    setBusy(true);
    setMsg("");
    try {
      const file = await renderCardFile(card, format);
      await fn(file);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setMsg("No se pudo compartir la imagen. Prueba con “Descargar imagen”.");
    } finally {
      setBusy(false);
    }
  };

  // Native share sheet WITH the image attached: this is the path to WhatsApp
  // Status, Instagram Stories and Facebook Stories. Desktop browsers cannot do
  // it, so we always leave the download route visible.
  const shareNative = () =>
    withFile(async (file) => {
      if (!canShareFiles(file)) {
        downloadFile(file);
        setMsg("Imagen descargada. Ábrela y publícala en tu Estado de WhatsApp o en tu Historia de Instagram.");
        return;
      }
      await (navigator as Navigator).share({
        files: [file],
        title: card.name,
        text: shareText(card),
      });
    });

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(shareText(card));
      setMsg("Mensaje copiado. Pégalo donde quieras.");
    } catch {
      setMsg("No se pudo copiar. Selecciona el texto y cópialo a mano.");
    }
  };

  return (
    <div className="card" style={{ textAlign: "left", marginTop: compact ? 12 : 22 }}>
      <h3 style={{ fontSize: 17, marginBottom: 6 }}>Comparte ahora — así es como se encuentra a la gente</h3>
      <p className="small muted" style={{ marginBottom: 14 }}>
        La mayoría de las personas aparecen porque alguien las reconoció, no porque un sistema las
        encontró. Envía esta tarjeta a tus grupos y publícala en tu estado.
      </p>

      <div className="chips" style={{ marginBottom: 14 }}>
        {([["story", "Estado / Historia (vertical)"], ["link", "Chat y grupos (horizontal)"]] as const).map(([v, l]) => (
          <button key={v} className={`chip ${format === v ? "on" : ""}`} onClick={() => setFormat(v)}>
            {l}
          </button>
        ))}
      </div>

      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: 12,
          padding: 10,
          background: "var(--panel-2)",
          display: "flex",
          justifyContent: "center",
          minHeight: 120,
          alignItems: "center",
        }}
      >
        {preview ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={preview}
            alt={`Tarjeta para compartir de ${card.name}`}
            style={{ width: "100%", maxWidth: format === "story" ? 260 : 460, borderRadius: 8 }}
          />
        ) : (
          <span className="small muted">Generando la tarjeta…</span>
        )}
      </div>

      <div className="row" style={{ marginTop: 14, flexDirection: "column", alignItems: "stretch" }}>
        <button className="btn primary block" disabled={busy} onClick={shareNative}>
          {busy ? "Preparando…" : "Compartir imagen (Estado, Historia, WhatsApp)"}
        </button>
        <a className="btn block" href={whatsappShareUrl(card)} target="_blank" rel="noreferrer">
          Enviar por WhatsApp con enlace
        </a>
        <div className="row">
          <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => withFile(downloadFile)}>
            Descargar imagen
          </button>
          <button className="btn ghost" style={{ flex: 1 }} onClick={copyText}>
            Copiar mensaje
          </button>
        </div>
      </div>

      {msg && (
        <p className="small" style={{ color: "var(--accent)", marginTop: 12 }}>
          {msg}
        </p>
      )}

      <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
        La tarjeta muestra únicamente nombre, edad aproximada, zona general y número de referencia.
        {card.photo
          ? card.blurPhoto
            ? " Por ser menor de edad, el rostro sale difuminado."
            : " La foto aparece porque autorizaste su publicación."
          : " La foto no aparece: no se autorizó su publicación."}{" "}
        Nunca se incluye tu teléfono, ni el piso o apartamento, ni la ubicación exacta.
      </p>

      {queued && (
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Ojo: el reporte todavía no se ha enviado. Puedes compartir la imagen ya, pero el enlace solo
          funcionará cuando vuelva la señal.
        </p>
      )}
    </div>
  );
}
