"use client";
import { useEffect, useMemo, useState } from "react";
import { incident, REFERENCE_PREFIX } from "@/lib/incident";
import { Report, newReferenceNumber, newUuid, LocationAccuracy } from "@/lib/schema";
import { addReport, loadReports, flushQueue } from "@/lib/store";
import { findDuplicates, DedupHit } from "@/lib/dedup";

const DRAFT_KEY = "rh:draft:v1";

type Draft = Partial<Report>;

export default function Reportar() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [online, setOnline] = useState(true);
  const [simulateOffline, setSimulateOffline] = useState(false);
  const [dupes, setDupes] = useState<DedupHit[] | null>(null);
  const [done, setDone] = useState<Report | null>(null);
  const [flushMsg, setFlushMsg] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) setDraft(JSON.parse(saved));
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Draft persisted on EVERY change — survives a tab crash or a dead battery.
  const set = (patch: Draft) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      return next;
    });
  };

  const effectiveOnline = online && !simulateOffline;
  const canSubmit = Boolean(draft.full_name?.trim() && (draft.last_seen_address?.trim() || draft.last_seen_lat));

  const commit = (extra: Partial<Report> = {}) => {
    const now = new Date().toISOString();
    const report: Report = {
      uuid: newUuid(),
      reference_number: newReferenceNumber(REFERENCE_PREFIX),
      incident_id: incident.id,
      channel: "pwa",
      created_at_device: now,
      received_at_server: effectiveOnline ? now : null,
      sync_state: effectiveOnline ? "acked" : "queued",
      status: (draft.status as Report["status"]) ?? "missing",
      status_source: "citizen",
      status_updated_at: now,
      reporter_lang: "es",
      reporter_count: 1,
      full_name: draft.full_name!.trim(),
      ...draft,
      // Consent is resolved AFTER the draft spread so the rules always win:
      // listing = opt-out (on unless withdrawn), photo = opt-in (off unless explicitly granted).
      consent_public_listing: draft.consent_public_listing !== false,
      consent_photo_public: Boolean(draft.photo_data_url) && draft.consent_photo_public === true,
      consent_recorded_at: now,
      ...extra,
    } as Report;
    addReport(report);
    localStorage.removeItem(DRAFT_KEY);
    setDupes(null);
    setDone(report);
  };

  const submit = () => {
    const hits = findDuplicates(draft, loadReports());
    if (hits.length) {
      setDupes(hits);
      return;
    }
    commit();
  };

  if (done) return <Confirmation report={done} onFlush={() => setFlushMsg(`${flushQueue()} reporte(s) enviado(s).`)} flushMsg={flushMsg} />;

  return (
    <>
      <div className={`netbar ${effectiveOnline ? "on" : "off"}`}>
        {effectiveOnline ? "● Con conexión — tu reporte se enviará de inmediato" : "● Sin conexión — se guardará en este teléfono y se enviará después"}
        <span className="spacer" />
        <button className="chip" onClick={() => setSimulateOffline((v) => !v)}>
          {simulateOffline ? "Simular conexión" : "Simular sin señal"}
        </button>
      </div>

      <div className="wrap-narrow">
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Reportar una persona desaparecida</h1>
        <p className="small muted">
          {incident.name}. Toma menos de 2 minutos. Solo el nombre y el lugar son obligatorios — si no
          sabes el resto, envíalo igual.
        </p>

        <div className="steps">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`s ${i <= step ? "done" : ""}`} />
          ))}
        </div>

        {step === 0 && <StepPerson draft={draft} set={set} />}
        {step === 1 && <StepPlace draft={draft} set={set} />}
        {step === 2 && <StepTime draft={draft} set={set} />}
        {step === 3 && <StepReporter draft={draft} set={set} />}

        <div className="row" style={{ marginTop: 24 }}>
          {step > 0 && (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              Atrás
            </button>
          )}
          <span className="spacer" />
          {step < 3 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)} disabled={step === 0 && !draft.full_name}>
              Continuar
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={!canSubmit}>
              Enviar reporte
            </button>
          )}
        </div>

        <p className="small muted" style={{ marginTop: 18 }}>
          Tu borrador se guarda en este teléfono automáticamente. Si se apaga, no pierdes lo escrito.
        </p>
      </div>

      {dupes && (
        <DedupModal
          hits={dupes}
          onSame={() => commit({ dedup_reviewed: true, dedup_cluster_id: dupes[0].report.dedup_cluster_id ?? dupes[0].report.uuid })}
          onDifferent={() => commit({ dedup_reviewed: true })}
          onCancel={() => setDupes(null)}
        />
      )}
    </>
  );
}

function StepPerson({ draft, set }: { draft: Draft; set: (p: Draft) => void }) {
  return (
    <div>
      <div className="section-title" style={{ marginTop: 8 }}>Paso 1 · ¿A quién buscas?</div>
      <label className="field">
        <span className="lab">Nombre de la persona <span className="req">*</span></span>
        <span className="hint">Como la conozcas. Apodos y nombres parciales sirven: &quot;el hijo de María&quot;.</span>
        <input value={draft.full_name ?? ""} onChange={(e) => set({ full_name: e.target.value })} placeholder="Ej: María Ramírez Mosquera" />
      </label>
      <label className="field">
        <span className="lab">Edad aproximada</span>
        <input type="number" inputMode="numeric" value={draft.age_approx ?? ""} onChange={(e) => set({ age_approx: e.target.value ? Number(e.target.value) : null })} placeholder="Ej: 34" />
      </label>
      <div className="field">
        <span className="lab">Sexo</span>
        <div className="chips">
          {([["f", "Mujer"], ["m", "Hombre"], ["other", "Otro"], ["unknown", "No sé"]] as const).map(([v, l]) => (
            <button key={v} className={`chip ${draft.gender === v ? "on" : ""}`} onClick={() => set({ gender: v })}>{l}</button>
          ))}
        </div>
      </div>
      <PhotoField draft={draft} set={set} />
      <label className="field">
        <span className="lab">Señas particulares</span>
        <span className="hint">Ropa que llevaba, estatura, cicatrices, si usa bastón o silla de ruedas.</span>
        <textarea rows={2} value={draft.distinguishing_info ?? ""} onChange={(e) => set({ distinguishing_info: e.target.value })} />
      </label>
      <label className="field">
        <span className="lab">Información médica urgente</span>
        <span className="hint">Diabetes, diálisis, medicamentos. Esto cambia la prioridad del rescate.</span>
        <input value={draft.medical_info ?? ""} onChange={(e) => set({ medical_info: e.target.value })} placeholder="Ej: diabética, necesita insulina" />
      </label>
      <label className="field">
        <span className="lab">Últimos 4 dígitos del documento</span>
        <span className="hint">Opcional. Solo se usa para no duplicar la misma persona. Nunca pedimos el documento completo.</span>
        <input inputMode="numeric" maxLength={4} value={draft.national_id_last4 ?? ""} onChange={(e) => set({ national_id_last4: e.target.value })} placeholder="1234" />
      </label>
    </div>
  );
}

// Optional photo. Compressed on the device before it ever touches the network:
// a 4 MB camera JPEG would never sync over a degraded cell tower.
async function compressImage(file: File, maxSide = 800, quality = 0.7): Promise<string> {
  const dataUrl: string = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("decode"));
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

function PhotoField({ draft, set }: { draft: Draft; set: (p: Draft) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const isMinor = typeof draft.age_approx === "number" && draft.age_approx < 18;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setErr("");
    setBusy(true);
    try {
      set({ photo_data_url: await compressImage(file) });
    } catch {
      setErr("No se pudo procesar la imagen. Puedes enviar el reporte sin foto.");
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = () => set({ photo_data_url: null, consent_photo_public: false });


  return (
    <div className="field">
      <span className="lab">Foto <span className="muted" style={{ fontWeight: 400 }}>(opcional)</span></span>
      <span className="hint">
        Una foto multiplica las posibilidades de que alguien la reconozca. Se reduce en este teléfono antes
        de enviarse y se envía después del texto, cuando haya señal.
      </span>
      {draft.photo_data_url ? (
        <div className="row" style={{ alignItems: "center", marginTop: 6 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={draft.photo_data_url}
            alt="Foto de la persona"
            style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 10 }}
          />
          <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label className="btn ghost" style={{ cursor: "pointer", textAlign: "center" }}>
              Cambiar foto
              <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
            </label>
            <button className="btn ghost" onClick={removePhoto}>
              Quitar foto
            </button>
          </div>
        </div>
      ) : (
        <label className="btn ghost" style={{ cursor: "pointer", display: "inline-block", marginTop: 6 }}>
          {busy ? "Procesando…" : "Agregar una foto"}
          <input type="file" accept="image/*" capture="environment" onChange={onFile} style={{ display: "none" }} />
        </label>
      )}
      {err && <span className="small" style={{ color: "var(--danger, #c1121f)" }}>{err}</span>}

      {/* SEPARATE consent. Attaching a photo is not the same decision as publishing it.
          Opt-IN: unchecked by default. The photo still reaches the rescue teams either way. */}
      {draft.photo_data_url && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <label className="row" style={{ alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={Boolean(draft.consent_photo_public)}
              onChange={(e) => set({ consent_photo_public: e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>Autorizo que la foto se muestre en la búsqueda pública.</strong>
              <span className="small muted" style={{ display: "block", marginTop: 4 }}>
                Ayuda a que alguien la reconozca en la calle o en un albergue. Si no marcas esta casilla,
                la foto se envía igual a los equipos de rescate, pero no aparece en la página pública.
              </span>
            </span>
          </label>
          {isMinor && (
            <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
              Es menor de edad: aunque autorices la publicación, el rostro se difumina automáticamente en
              la vista pública.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StepPlace({ draft, set }: { draft: Draft; set: (p: Draft) => void }) {
  const accuracies: [LocationAccuracy, string][] = [
    ["exact", "Punto exacto"],
    ["building", "El edificio"],
    ["block", "La cuadra"],
    ["neighbourhood", "El barrio"],
    ["unknown", "No sé"],
  ];
  const useGps = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => set({ last_seen_lat: p.coords.latitude, last_seen_lng: p.coords.longitude, location_accuracy: "exact" }),
      () => alert("No se pudo obtener la ubicación del dispositivo.")
    );
  };
  return (
    <div>
      <div className="section-title" style={{ marginTop: 8 }}>Paso 2 · ¿Dónde se le vio por última vez?</div>
      <label className="field">
        <span className="lab">Dirección o punto de referencia <span className="req">*</span></span>
        <span className="hint">Si no hay dirección, sirve igual: &quot;el colegio al lado de la iglesia&quot;.</span>
        <input list="landmarks" value={draft.last_seen_address ?? ""} onChange={(e) => set({ last_seen_address: e.target.value })} placeholder="Ej: Cra 1 con Calle 24, casa azul" />
        <datalist id="landmarks">
          {incident.landmarks.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </label>
      <div className="field">
        <span className="lab">¿Qué tan exacto es ese lugar?</span>
        <span className="hint">Esto define el peso del punto en el mapa de calor. Decir &quot;no sé&quot; es válido y útil.</span>
        <div className="chips">
          {accuracies.map(([v, l]) => (
            <button key={v} className={`chip ${draft.location_accuracy === v ? "on" : ""}`} onClick={() => set({ location_accuracy: v })}>{l}</button>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn ghost" onClick={useGps}>Usar mi ubicación actual</button>
        {draft.last_seen_lat != null && (
          <span className="small muted">
            {draft.last_seen_lat.toFixed(5)}, {draft.last_seen_lng?.toFixed(5)}
          </span>
        )}
      </div>
      <label className="field">
        <span className="lab">Edificio</span>
        <input value={draft.building_name ?? ""} onChange={(e) => set({ building_name: e.target.value })} />
      </label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span className="lab">Piso</span>
          <input value={draft.floor ?? ""} onChange={(e) => set({ floor: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span className="lab">Apartamento</span>
          <input value={draft.apartment ?? ""} onChange={(e) => set({ apartment: e.target.value })} />
        </label>
      </div>
      <p className="small muted">
        El piso y el apartamento no se muestran públicamente. Solo los ven los equipos de rescate.
      </p>
      <div className="field" style={{ marginTop: 18 }}>
        <span className="lab">¿Sabes si está atrapada con vida?</span>
        <span className="hint">Si se escuchan voces o golpes bajo los escombros, esto tiene prioridad máxima.</span>
        <div className="chips">
          <button className={`chip ${draft.status === "trapped_alive" ? "on" : ""}`} onClick={() => set({ status: "trapped_alive" })}>Sí, se le escucha</button>
          <button className={`chip ${draft.status !== "trapped_alive" ? "on" : ""}`} onClick={() => set({ status: "missing" })}>No lo sé</button>
        </div>
      </div>
    </div>
  );
}

function StepTime({ draft, set }: { draft: Draft; set: (p: Draft) => void }) {
  return (
    <div>
      <div className="section-title" style={{ marginTop: 8 }}>Paso 3 · ¿Cuándo fue la última vez?</div>
      <div className="field">
        <span className="lab">Momento aproximado</span>
        <div className="chips">
          {([["exact", "Sé la hora"], ["same_day", "Ese mismo día"], ["approximate", "Antes del sismo"], ["unknown", "No lo sé"]] as const).map(([v, l]) => (
            <button key={v} className={`chip ${draft.last_contact_precision === v ? "on" : ""}`} onClick={() => set({ last_contact_precision: v })}>{l}</button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="lab">Fecha y hora (si la sabes)</span>
        <input type="datetime-local" value={draft.last_contact_at?.slice(0, 16) ?? ""} onChange={(e) => set({ last_contact_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
      </label>
    </div>
  );
}

function StepReporter({ draft, set }: { draft: Draft; set: (p: Draft) => void }) {
  return (
    <div>
      <div className="section-title" style={{ marginTop: 8 }}>Paso 4 · ¿Quién reporta?</div>
      <label className="field">
        <span className="lab">Tu nombre</span>
        <input value={draft.reporter_name ?? ""} onChange={(e) => set({ reporter_name: e.target.value })} />
      </label>
      <label className="field">
        <span className="lab">Tu teléfono o WhatsApp</span>
        <span className="hint">Para avisarte si aparece. No se muestra públicamente ni se comparte con terceros.</span>
        <input inputMode="tel" value={draft.reporter_phone ?? ""} onChange={(e) => set({ reporter_phone: e.target.value })} placeholder="+57 300 000 0000" />
      </label>
      <div className="field">
        <span className="lab">¿Qué relación tienes?</span>
        <div className="chips">
          {([["family", "Familiar"], ["neighbour", "Vecino/a"], ["friend", "Amigo/a"], ["colleague", "Compañero/a"], ["witness", "Testigo"], ["other", "Otro"]] as const).map(([v, l]) => (
            <button key={v} className={`chip ${draft.reporter_relation === v ? "on" : ""}`} onClick={() => set({ reporter_relation: v })}>{l}</button>
          ))}
        </div>
      </div>

      {/* Consent #1: public listing. Opt-OUT (default on) — it is the engine of adoption,
          but withdrawing it must cost one tap. Withheld reports still feed the heat map. */}
      <div className="card" style={{ marginTop: 8, padding: 12 }}>
        <label className="row" style={{ alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={draft.consent_public_listing !== false}
            onChange={(e) => set({ consent_public_listing: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Autorizo que aparezca en la búsqueda pública.</strong>
            <span className="small muted" style={{ display: "block", marginTop: 4 }}>
              Se muestra solo el nombre, la edad aproximada, el barrio y el estado. Nunca tu teléfono, ni
              el piso o apartamento, ni la ubicación exacta. Si no marcas esta casilla, el reporte llega
              igual a los equipos de rescate, pero no aparece en la página pública.
            </span>
          </span>
        </label>
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Puedes revertir esta decisión en cualquier momento con tu número de referencia.
        </p>
      </div>
    </div>
  );
}

function DedupModal({ hits, onSame, onDifferent, onCancel }: { hits: DedupHit[]; onSame: () => void; onDifferent: () => void; onCancel: () => void }) {
  const top = hits[0];
  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>¿Es la misma persona?</h3>
        <p className="small muted">
          Alguien ya reportó a <strong style={{ color: "var(--text)" }}>{top.report.full_name}</strong> en{" "}
          {top.report.last_seen_address}. Coincide por: {top.reasons.join(", ")}.
        </p>
        <div className="row" style={{ marginTop: 18, flexDirection: "column", alignItems: "stretch" }}>
          <button className="btn primary block" onClick={onSame}>Sí — sumar mi información</button>
          <button className="btn block" onClick={onDifferent}>No — es otra persona</button>
          <button className="btn ghost block" onClick={onCancel}>Volver a revisar</button>
        </div>
        <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
          Nunca rechazamos ni fusionamos un reporte en silencio. Tú decides.
        </p>
      </div>
    </div>
  );
}

function Confirmation({ report, onFlush, flushMsg }: { report: Report; onFlush: () => void; flushMsg: string }) {
  const queued = report.sync_state === "queued";
  return (
    <div className="wrap-narrow" style={{ textAlign: "center", paddingTop: 50 }}>
      <div style={{ fontSize: 44 }}>{queued ? "📥" : "✅"}</div>
      <h1 style={{ fontSize: 22 }}>{queued ? "Guardado en este teléfono" : "Recibido en el centro de coordinación"}</h1>
      <p className="muted small">
        {queued
          ? "Todavía NO se ha enviado. Se enviará solo cuando vuelva la señal, o puedes intentarlo ahora."
          : "Tu reporte ya está en el sistema."}
      </p>
      <div className="card" style={{ marginTop: 22 }}>
        <p className="small muted">Tu número de referencia</p>
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: ".06em" }}>{report.reference_number}</div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Anótalo. Con este número puedes actualizar el reporte o avisar si la persona aparece — incluso desde
          otro teléfono.
        </p>
      </div>
      {queued && (
        <button className="btn primary block" style={{ marginTop: 18 }} onClick={onFlush}>
          Enviar ahora
        </button>
      )}
      {flushMsg && <p className="small" style={{ color: "var(--ok)" }}>{flushMsg}</p>}
      <div className="row" style={{ marginTop: 22, justifyContent: "center" }}>
        <a className="btn ghost" href="/reportar">Reportar a otra persona</a>
        <a className="btn ghost" href="/buscar">Ver la lista</a>
      </div>
    </div>
  );
}
