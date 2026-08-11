"use client";
// The family's private page — GET/PATCH /v1/reporter/case with their token.
//
// No account, no password: an unguessable token that grants access to exactly
// one case. The whole point is that a frightened person at 4 a.m. can correct
// something they remembered without registering for anything.
//
// This page exists for a second reason too: consent withdrawal and erasure have
// to be reachable by the person who gave the data, not only by an operator.
// A right that requires emailing a stranger is not a right.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, reporterTokenFor } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";

export default function MyReport({ reference }: { reference: string }) {
  const [data, setData] = useState<any>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const hasToken = Boolean(reporterTokenFor(reference));

  const load = useCallback(async () => {
    if (!hasToken) {
      setData(null);
      return;
    }
    try {
      setData(await api.reporterCase(reference));
      setError(null);
    } catch (err) {
      const e = err as ApiError;
      setData(null);
      setError(e.isOffline ? "Sin conexión." : e.status === 401 ? "expired" : e.message);
    }
  }, [reference, hasToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setMsg("");
    try {
      await api.reporterUpdate(reference, body);
      setMsg(ok);
      await load();
    } catch (e) {
      setMsg((e as ApiError).isOffline ? "Sin conexión. Intenta más tarde." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!hasToken || error === "expired") {
    return (
      <div className="wrap-narrow">
        <h1 style={{ fontSize: 22 }}>Necesitamos tu enlace privado</h1>
        <p className="muted small">
          Esta página solo se abre desde el enlace privado que te dimos al enviar el reporte. No podemos
          volver a generarlo: guardamos únicamente una huella del enlace, nunca el enlace en sí, para que
          una filtración de la base de datos no entregue el acceso a todos los reportes.
        </p>
        <p className="muted small">
          Si lo perdiste, la ficha pública sigue funcionando y cualquiera puede avisar allí si ve a la
          persona. Para corregir datos, escribe al centro de coordinación con tu número de referencia{" "}
          <strong>{reference}</strong>.
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <Link className="btn primary" href={`/r/${reference}`}>Ver la ficha pública</Link>
        </div>
      </div>
    );
  }

  if (data === undefined) return <div className="wrap-narrow"><p className="muted small">Cargando…</p></div>;
  if (!data) {
    return (
      <div className="wrap-narrow">
        <h1 style={{ fontSize: 22 }}>No pudimos abrir tu reporte</h1>
        <p className="muted small">{error}</p>
      </div>
    );
  }

  const c = data.case;
  const sightings: any[] = data.sightings ?? [];

  return (
    <div className="wrap-narrow">
      <div className="row">
        <div>
          <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>{c.name_raw}</h1>
          <p className="small muted" style={{ margin: 0 }}>Ref. {c.reference_number}</p>
        </div>
        <span className="spacer" />
        <StatusBadge status={c.status} />
      </div>

      {data.merged_into && (
        <div className="card" style={{ marginTop: 14, borderColor: "rgba(240,198,116,.4)" }}>
          <p className="small" style={{ margin: 0 }}>
            Un equipo determinó que este reporte y otro se referían a la misma persona, y los unió. Toda la
            información sigue en el sistema.
          </p>
        </div>
      )}

      {/* Sightings first: this is what the family opens the page to see. */}
      <div className="section-title">Avisos recibidos ({sightings.length})</div>
      {sightings.length === 0 ? (
        <p className="small muted">Todavía nadie ha enviado información. Compartir la ficha ayuda.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Tipo</th><th>Información</th><th>Cuándo</th><th>Estado</th></tr>
            </thead>
            <tbody>
              {sightings.map((s, i) => (
                <tr key={i}>
                  <td>{s.kind}</td>
                  <td>{s.note ?? "—"}</td>
                  <td className="muted small">{new Date(s.created_at).toLocaleString("es")}</td>
                  <td className="muted small">{s.trust === "unverified" ? "sin verificar" : s.trust}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">Actualizar</div>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          Nada se sobrescribe: cada cambio queda registrado como una corrección, con la versión anterior.
        </p>
        <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <button className="btn primary block" disabled={busy} onClick={() => void patch({ status: "found_safe" }, "Gracias. Marcado como aparecido.")}>
            Apareció con vida
          </button>
          <button
            className="btn block"
            disabled={busy}
            onClick={() => void patch({ consent_public_listing: !c.public_listed }, "Preferencia actualizada.")}
          >
            {c.public_listed ? "Quitar de la búsqueda pública" : "Volver a mostrar en la búsqueda pública"}
          </button>
        </div>
        {!c.public_listed && (
          <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
            Ahora mismo no aparece públicamente. El reporte sigue llegando a los equipos de rescate.
          </p>
        )}
        {msg && <p className="small" style={{ color: "var(--accent)", marginTop: 12 }}>{msg}</p>}
      </div>

      <div className="section-title">Borrar mis datos</div>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          Se elimina toda la información que identifica a la persona y a quien reportó. Queda un registro
          sin datos personales de que el caso existió, porque los equipos ya pudieron haber actuado sobre
          él. Esto no se puede deshacer.
        </p>
        <button
          className="btn ghost block"
          disabled={busy}
          onClick={async () => {
            if (!confirm("¿Seguro? Se borrarán los datos personales de este reporte y no se puede deshacer.")) return;
            setBusy(true);
            try {
              await api.reporterErase(reference);
              setMsg("Datos borrados.");
              setData(null);
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Borrar los datos de este reporte
        </button>
      </div>
    </div>
  );
}
