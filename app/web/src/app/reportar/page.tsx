"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { incident } from "@/lib/incident";
import { Report, LocationAccuracy, LocationSource } from "@/lib/schema";
import {
  ACCURACY_CEILING,
  geocode,
  searchLandmarks,
  withinIncident,
  type Place,
  type PlaceSource,
} from "@/lib/geo";
import { api, ApiError, PublicCase } from "@/lib/api";
import { enqueueReport, flushOutbox, getEntry, OUTBOX_EVENT, OutboxEntry, startOutboxSync } from "@/lib/outbox";
import ShareSheet from "@/components/ShareSheet";
import { toPublicCard } from "@/lib/publicView";

// Browser-only (Leaflet). Never import a binding from it statically — see
// services/api/test/ssr-safety.test.ts for the build this rule cost us once.
const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  ssr: false,
  loading: () => <div className="small muted">Cargando mapa…</div>,
});

const SOURCE_LABEL: Record<LocationSource, string> = {
  device_gps: "GPS del teléfono",
  map_pick: "marcado en el mapa",
  geocoded: "dirección encontrada y confirmada",
  landmark: "punto de referencia",
  none: "sin punto",
};

const DRAFT_KEY = "rh:draft:v1";

type Draft = Partial<Report>;

// Only the fields the API accepts (services/api/src/schema.ts). Anything else in
// the draft is device-side state and must not be posted: an unknown field would
// be silently dropped, which is worse than being rejected.
const WIRE_FIELDS = [
  "full_name", "age_approx", "gender", "distinguishing_info", "medical_info",
  "national_id_last4", "is_minor",
  "last_seen_lat", "last_seen_lng", "location_accuracy", "location_source", "last_seen_address",
  "building_name", "floor", "apartment",
  "last_contact_at", "last_contact_precision",
  "reporter_name", "reporter_phone", "reporter_relation", "reporter_lang",
  "consent_public_listing", "consent_photo_public", "status",
] as const;

function toWire(draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { channel: "pwa" };
  for (const f of WIRE_FIELDS) {
    const v = (draft as Record<string, unknown>)[f];
    if (v !== undefined && v !== "") out[f] = v;
  }
  out.full_name = String(draft.full_name ?? "").trim();
  out.reporter_lang = draft.reporter_lang ?? "es";
  out.status = draft.status ?? "missing";
  // Consent rules win over whatever the draft happens to hold:
  // listing = opt-out (on unless withdrawn), photo = opt-in (off unless granted).
  out.consent_public_listing = draft.consent_public_listing !== false;
  out.consent_photo_public = Boolean(draft.photo_data_url) && draft.consent_photo_public === true;
  // Location invariant, enforced again here because the draft survives across
  // sessions and a stale accuracy could outlive the point it described:
  // no coordinate => no precision claim, and the source says so explicitly.
  const hasPoint = draft.last_seen_lat != null && draft.last_seen_lng != null;
  out.location_source = hasPoint ? draft.location_source ?? "map_pick" : "none";
  if (!hasPoint) {
    delete out.last_seen_lat;
    delete out.last_seen_lng;
    out.location_accuracy = "unknown";
  }
  return out;
}

export default function Reportar() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [online, setOnline] = useState(true);
  const [simulateOffline, setSimulateOffline] = useState(false);
  const [dupes, setDupes] = useState<PublicCase[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [doneId, setDoneId] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) setDraft(JSON.parse(saved));
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const stop = startOutboxSync();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      stop();
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

  // Written to the device first, sent second. If the browser dies between the
  // two, the report is still here on the next open.
  const commit = () => {
    const id = enqueueReport(toWire(draft), draft.photo_data_url ?? null);
    localStorage.removeItem(DRAFT_KEY);
    setDupes(null);
    setDoneId(id);
    if (effectiveOnline) void flushOutbox();
  };

  // Pre-submit duplicate check against what is already PUBLIC — not against a
  // private copy of other people's reports, which this device must never hold.
  // Offline it is skipped entirely: the server correlates every case anyway, so
  // the only thing lost is the chance to ask this family the question now.
  const submit = async () => {
    const name = draft.full_name?.trim() ?? "";
    if (effectiveOnline && name.length >= 3) {
      setChecking(true);
      try {
        const { results } = await api.search(name, { limit: 5 });
        const hits = results.filter((r) => !r.status.startsWith("found"));
        if (hits.length) {
          setDupes(hits);
          return;
        }
      } catch {
        // A failed check must never block a report. Correlation happens server-side.
      } finally {
        setChecking(false);
      }
    }
    commit();
  };

  if (doneId) return <Confirmation localId={doneId} />;

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
            <button className="btn primary" onClick={() => void submit()} disabled={!canSubmit || checking}>
              {checking ? "Revisando…" : "Enviar reporte"}
            </button>
          )}
        </div>

        <p className="small muted" style={{ marginTop: 18 }}>
          Tu borrador se guarda en este teléfono automáticamente. Si se apaga, no pierdes lo escrito.
        </p>
      </div>

      {dupes && (
        <DedupModal hits={dupes} onContinue={commit} onCancel={() => setDupes(null)} />
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
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  // Why a tapped-but-blocked chip must ANSWER instead of ignoring: a disabled
  // button on a phone is indistinguishable from a broken one. The first field
  // tester tapped "Punto exacto", nothing happened, and reported the feature
  // dead — while the real state was "you have no point on the map yet". The
  // rule stands (accuracy is capped by where the point came from); the silence
  // was the bug.
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  // Removing a point is an EVENT the person must see, not a side effect.
  // Editing the address after picking a geocoder result silently discarded the
  // coordinate (correctly — a point resolved from the old text must not stick
  // to the new text), but nothing said so: the tester confirmed a search
  // result, refined the address, and submitted a report that was no longer on
  // the map — while remembering, truthfully, that he HAD picked a point.
  // Kept as its own state because geoError is cleared on every keystroke,
  // which would erase this notice one character after it appeared.
  const [pointLost, setPointLost] = useState(false);

  const address = draft.last_seen_address ?? "";
  const mapped = draft.last_seen_lat != null && draft.last_seen_lng != null;
  const source = (draft.location_source ?? "none") as LocationSource;

  // Editing the address invalidates the point: a coordinate resolved from a
  // previous address silently attached to a new one is worse than no point.
  const setAddress = (v: string) => {
    setResults(null);
    setGeoError(null);
    if (mapped && source !== "device_gps" && source !== "map_pick") {
      setPointLost(true);
      set({ last_seen_address: v, last_seen_lat: null, last_seen_lng: null, location_source: "none", location_accuracy: "unknown" });
    } else {
      set({ last_seen_address: v });
    }
  };

  const applyPlace = (p: Place) => {
    setResults(null);
    setPointLost(false);
    set({
      last_seen_lat: p.lat,
      last_seen_lng: p.lng,
      location_source: p.source,
      last_seen_address: draft.last_seen_address?.trim() ? draft.last_seen_address : p.label,
      // A point may never claim more precision than its origin allows.
      location_accuracy: ACCURACY_CEILING[p.source],
    });
  };

  const search = async () => {
    setGeoError(null);
    const local = searchLandmarks(address);
    setBusy(true);
    try {
      const remote = await geocode(address);
      setResults([...local, ...remote]);
      if (!local.length && !remote.length) setGeoError("No encontramos ese lugar en la zona del evento.");
    } catch (e) {
      // Offline or blocked. The landmark list still works, and the report is
      // still accepted — we only refuse to pretend it has a location.
      setResults(local);
      setGeoError(
        local.length
          ? "Sin conexión: solo se muestran lugares guardados en el teléfono."
          : "No se pudo buscar la dirección ahora. Puedes enviar el reporte igual — quedará como texto, sin punto en el mapa."
      );
      void e;
    } finally {
      setBusy(false);
    }
  };

  const useGps = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        if (!withinIncident(p.coords.latitude, p.coords.longitude)) {
          setGeoError("Tu ubicación actual está fuera de la zona del evento. Marca el lugar en el mapa.");
          setShowMap(true);
          return;
        }
        applyPlace({ label: "Mi ubicación actual", lat: p.coords.latitude, lng: p.coords.longitude, source: "device_gps" });
      },
      () => setGeoError("No se pudo obtener la ubicación del dispositivo.")
    );
  };

  // Accuracy is a claim about a coordinate. Without one, the only honest value
  // is "unknown", so the finer options are shown disabled rather than hidden —
  // the family should see why they cannot say "punto exacto" yet.
  const ceiling = mapped ? ACCURACY_CEILING[source as PlaceSource] ?? "block" : null;
  const RANK: Record<string, number> = { exact: 3, building: 2, block: 1, neighbourhood: 0, unknown: 0 };
  const accuracies: [LocationAccuracy, string][] = [
    ["exact", "Punto exacto"],
    ["building", "El edificio"],
    ["block", "La cuadra"],
    ["neighbourhood", "El barrio"],
    ["unknown", "No sé"],
  ];

  return (
    <div>
      <div className="section-title" style={{ marginTop: 8 }}>Paso 2 · ¿Dónde se le vio por última vez?</div>
      <label className="field">
        <span className="lab">Dirección o punto de referencia <span className="req">*</span></span>
        <span className="hint">Si no hay dirección, sirve igual: &quot;el colegio al lado de la iglesia&quot;.</span>
        <input
          list="landmarks"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Ej: Cra 1 con Calle 24, casa azul"
        />
        <datalist id="landmarks">
          {incident.landmarks.map((l) => (
            <option key={l.name} value={l.name} />
          ))}
        </datalist>
      </label>

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={() => void search()} disabled={busy || address.trim().length < 3}>
          {busy ? "Buscando…" : "Buscar en el mapa"}
        </button>
        <button className="btn ghost" onClick={useGps}>Usar mi ubicación actual</button>
        <button className="btn ghost" onClick={() => setShowMap((v) => !v)}>
          {showMap ? "Ocultar mapa" : "Marcar en el mapa"}
        </button>
      </div>

      {results && results.length > 0 && (
        <div className="card" style={{ padding: 8, marginBottom: 12 }}>
          <div className="small muted" style={{ padding: "4px 6px" }}>
            Toca el lugar correcto. Ninguno se elige solo.
          </div>
          {results.map((p, i) => (
            <button
              key={`${p.source}:${i}`}
              className="btn ghost"
              style={{ display: "block", width: "100%", textAlign: "left", marginTop: 4 }}
              onClick={() => applyPlace(p)}
            >
              {p.label}
              {p.detail && <span className="small muted" style={{ display: "block" }}>{p.detail}</span>}
            </button>
          ))}
        </div>
      )}

      {geoError && (
        <p className="small" style={{ color: "#d29922", marginTop: 0 }}>{geoError}</p>
      )}

      {/* The honest state banner. This is the whole point of the fix: a report
          with an address and no coordinate must SAY that it is not on the map. */}
      <div className="card" style={{ padding: 10, marginBottom: 12 }}>
        {mapped ? (
          <span className="small">
            ✅ Ubicación en el mapa: {draft.last_seen_lat?.toFixed(5)}, {draft.last_seen_lng?.toFixed(5)}
            <span className="muted"> · {SOURCE_LABEL[source]}</span>
          </span>
        ) : (
          <span className="small">
            ⚠️ <strong>
              {pointLost
                ? "Al cambiar la dirección se quitó el punto del mapa."
                : "La dirección se guardará como texto, todavía sin punto en el mapa."}
            </strong>
            <span className="muted" style={{ display: "block", marginTop: 4 }}>
              {pointLost
                ? "El punto anterior venía de la dirección anterior y no puede quedarse pegado a la nueva. Vuelve a «Buscar en el mapa», usa el GPS o marca el punto."
                : "El reporte se envía igual y un equipo lo revisará, pero no aparecerá en el mapa de calor hasta que alguien lo ubique."}
            </span>
          </span>
        )}
      </div>

      {showMap && (
        <div style={{ marginBottom: 12 }}>
          <LocationPicker
            lat={draft.last_seen_lat}
            lng={draft.last_seen_lng}
            onPick={(lat, lng) => applyPlace({ label: address || "Punto marcado", lat, lng, source: "map_pick" })}
          />
        </div>
      )}

      <div className="field">
        <span className="lab">¿Qué tan exacto es ese lugar?</span>
        <span className="hint">
          {mapped
            ? "Esto define el peso del punto en el mapa de calor. Decir 'no sé' es válido y útil."
            : "Se activa cuando el lugar tenga un punto en el mapa."}
        </span>
        <div className="chips">
          {accuracies.map(([v, l]) => {
            const blocked = !mapped ? v !== "unknown" : RANK[v] > RANK[ceiling ?? "unknown"];
            return (
              <button
                key={v}
                className={`chip ${draft.location_accuracy === v ? "on" : ""} ${blocked ? "blocked" : ""}`}
                aria-disabled={blocked}
                onClick={() => {
                  if (!blocked) {
                    setBlockedMsg(null);
                    set({ location_accuracy: v });
                    return;
                  }
                  // Not `disabled`: a dead tap explains nothing. Say WHY, in
                  // terms of the action that unblocks it.
                  setBlockedMsg(
                    !mapped
                      ? "Primero pon el lugar en el mapa: usa «Buscar en el mapa», «Usar mi ubicación actual» o «Marcar en el mapa». La dirección escrita todavía no tiene punto."
                      : "El punto actual viene de una búsqueda, así que no puede afirmar más precisión que eso. Para «Punto exacto», usa el GPS o arrastra el punto en el mapa hasta el lugar."
                  );
                }}
              >
                {l}
              </button>
            );
          })}
        </div>
        {blockedMsg && (
          <p className="small" style={{ color: "#d29922", marginTop: 6 }}>{blockedMsg}</p>
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

// Note what this modal does NOT do: it never merges, and it never replaces the
// family's report with the existing one. Both buttons submit. Saying "it is the
// same person" only attaches a signal to the existing case for an operator to
// read — a stranger's opinion is not a merge decision.
function DedupModal({ hits, onContinue, onCancel }: { hits: PublicCase[]; onContinue: () => void; onCancel: () => void }) {
  const top = hits[0];
  const [busy, setBusy] = useState(false);

  const samePerson = async () => {
    setBusy(true);
    try {
      await api.sighting(top.reference_number, {
        kind: "correction",
        note: "Otra persona reporta a la misma persona. Enviado desde el formulario, pendiente de revisión.",
      });
    } catch {
      // Best effort. The report itself must go out regardless.
    } finally {
      setBusy(false);
      onContinue();
    }
  };

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>¿Es la misma persona?</h3>
        <p className="small muted">
          Ya hay {hits.length === 1 ? "un reporte" : `${hits.length} reportes`} con un nombre parecido:
        </p>
        <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {hits.slice(0, 3).map((h) => (
            <li key={h.reference_number} style={{ marginBottom: 4 }}>
              <strong>{h.name}</strong>
              {h.age_approx ? ` · ~${h.age_approx} años` : ""} · Ref. {h.reference_number}
              {h.reports > 1 ? ` · ${h.reports} personas la reportaron` : ""}
            </li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 18, flexDirection: "column", alignItems: "stretch" }}>
          <button className="btn primary block" disabled={busy} onClick={() => void samePerson()}>
            {busy ? "Enviando…" : "Sí — sumar mi información"}
          </button>
          <button className="btn block" onClick={onContinue}>No — es otra persona</button>
          <button className="btn ghost block" onClick={onCancel}>Volver a revisar</button>
        </div>
        <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
          En los dos casos tu reporte se envía. Nunca lo descartamos ni lo unimos con otro en silencio:
          un equipo revisa antes de unir dos reportes.
        </p>
      </div>
    </div>
  );
}

// The confirmation follows the outbox entry instead of pretending. The reference
// number is issued by the SERVER, so while the report is still queued there is
// no reference to show — and inventing one would print a different number on
// every retry for the same person.
function Confirmation({ localId }: { localId: string }) {
  const [entry, setEntry] = useState<OutboxEntry | undefined>(() => getEntry(localId));
  const [flushMsg, setFlushMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = () => setEntry(getEntry(localId));
    read();
    window.addEventListener(OUTBOX_EVENT, read);
    return () => window.removeEventListener(OUTBOX_EVENT, read);
  }, [localId]);

  const sendNow = async () => {
    setBusy(true);
    const r = await flushOutbox();
    setBusy(false);
    setFlushMsg(
      r.offline
        ? "Todavía no hay conexión. Tu reporte sigue guardado en este teléfono y se enviará solo."
        : r.sent > 0
          ? "Enviado."
          : "No se pudo enviar todavía. Se reintentará automáticamente."
    );
  };

  if (!entry) {
    return (
      <div className="wrap-narrow" style={{ paddingTop: 50 }}>
        <p className="muted small">No encontramos este reporte en este teléfono.</p>
        <a className="btn primary" href="/reportar">Reportar de nuevo</a>
      </div>
    );
  }

  const p = entry.payload as Partial<Report>;

  if (entry.state === "rejected") {
    return (
      <div className="wrap-narrow" style={{ textAlign: "center", paddingTop: 50 }}>
        <div style={{ fontSize: 44 }}>⚠️</div>
        <h1 style={{ fontSize: 22 }}>El servidor no aceptó este reporte</h1>
        <p className="muted small">
          Tu información sigue guardada en este teléfono. Detalle técnico: {entry.last_error}
        </p>
        <a className="btn primary block" style={{ marginTop: 18 }} href="/reportar">Intentar de nuevo</a>
      </div>
    );
  }

  if (entry.state !== "sent") {
    return (
      <div className="wrap-narrow" style={{ textAlign: "center", paddingTop: 50 }}>
        <div style={{ fontSize: 44 }}>📥</div>
        <h1 style={{ fontSize: 22 }}>Guardado en este teléfono</h1>
        <p className="muted small">
          Todavía <strong>no</strong> se ha enviado al centro de coordinación. Se enviará solo en cuanto
          vuelva la señal, aunque cierres esta página.
        </p>
        <div className="card" style={{ marginTop: 22 }}>
          <p className="small muted" style={{ marginBottom: 0 }}>
            El número de referencia lo asigna el centro de coordinación cuando recibe el reporte. Por eso
            todavía no aparece aquí: si te diéramos uno ahora, podría no coincidir con el real.
          </p>
        </div>
        <button className="btn primary block" style={{ marginTop: 18 }} disabled={busy} onClick={() => void sendNow()}>
          {busy ? "Enviando…" : "Enviar ahora"}
        </button>
        {flushMsg && <p className="small muted">{flushMsg}</p>}
        <div className="row" style={{ marginTop: 22, justifyContent: "center" }}>
          <a className="btn ghost" href="/reportar">Reportar a otra persona</a>
          <a className="btn ghost" href="/buscar">Buscar por nombre</a>
        </div>
      </div>
    );
  }

  // Accepted. Everything below is real: the reference came from the server.
  const report: Report = {
    ...(p as Report),
    uuid: entry.uuid,
    reference_number: entry.reference_number!,
    incident_id: incident.id,
    channel: "pwa",
    created_at_device: entry.created_at,
    received_at_server: entry.accepted_at ?? null,
    sync_state: "acked",
    status: (p.status as Report["status"]) ?? "missing",
    status_source: "citizen",
    status_updated_at: entry.accepted_at ?? entry.created_at,
    reporter_count: 1,
  };

  return <Accepted report={report} entry={entry} />;
}

function Accepted({ report, entry }: { report: Report; entry: OutboxEntry }) {
  const reporterUrl = entry.reporter_token
    ? `/r/${report.reference_number}?t=${entry.reporter_token}`
    : null;
  // Derived from the same payload the server judged, by the same rule
  // (normaliseLocation: no coordinate ⇒ unmapped). Said HERE because this is
  // the last screen the family sees: a report accepted without a point is on
  // the rescuers' queue but NOT on any map, and believing otherwise is the
  // silent failure this form keeps having to un-teach.
  const unmapped = report.last_seen_lat == null || report.last_seen_lng == null;
  return (
    <div className="wrap-narrow" style={{ textAlign: "center", paddingTop: 50 }}>
      <div style={{ fontSize: 44 }}>✅</div>
      <h1 style={{ fontSize: 22 }}>Recibido en el centro de coordinación</h1>
      <p className="muted small">Tu reporte ya está en el sistema.</p>

      {unmapped && (
        <div className="card" style={{ marginTop: 14, borderColor: "rgba(210,153,34,.5)", textAlign: "left" }}>
          <p className="small" style={{ marginTop: 0 }}>
            ⚠️ <strong>Este reporte todavía no tiene punto en el mapa.</strong>
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            La dirección se guardó como texto y un equipo la ubicará a mano, pero hasta entonces no
            aparece en el mapa de calor. Si puedes marcar el lugar, abre tu reporte con el enlace
            privado y añade el punto.
          </p>
        </div>
      )}

      <div className="card" style={{ marginTop: 22 }}>
        <p className="small muted">Tu número de referencia</p>
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: ".06em" }}>{report.reference_number}</div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Anótalo. Con este número cualquiera puede ver la ficha pública de esta persona y avisar si la ve.
        </p>
      </div>

      {/* The private link. It is shown ONCE and cannot be re-issued: the server
          stores only a hash of the token, by design. Saying so plainly here is
          the difference between a family keeping it and losing it. */}
      {reporterUrl && (
        <div className="card" style={{ marginTop: 14, borderColor: "rgba(240,198,116,.4)" }}>
          <p className="small" style={{ marginTop: 0 }}>
            <strong>Guarda este enlace privado</strong>
          </p>
          <p className="small muted">
            Solo con él puedes corregir el reporte, avisar que apareció o pedir que se borre. Se muestra
            una sola vez y no podemos volver a generarlo.
          </p>
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn primary" style={{ flex: 1 }} href={reporterUrl}>Abrir mi reporte</a>
            <button
              className="btn ghost"
              style={{ flex: 1 }}
              onClick={() => {
                const url = `${window.location.origin}${reporterUrl}`;
                void navigator.clipboard?.writeText(url);
              }}
            >
              Copiar enlace
            </button>
          </div>
        </div>
      )}

      {/* The share moment. It comes BEFORE the secondary links on purpose: this is
          the single point where a family is most willing to broadcast, and the
          card is what actually spreads (see docs/adoption-playbook.md). */}
      {report.consent_public_listing !== false ? (
        <ShareSheet card={toPublicCard(report)} />
      ) : (
        <p className="small muted" style={{ marginTop: 20 }}>
          Pediste que este reporte no aparezca públicamente, así que no generamos una tarjeta para
          compartir. El reporte sí llega a los equipos de rescate.
        </p>
      )}

      <div className="row" style={{ marginTop: 22, justifyContent: "center" }}>
        <a className="btn ghost" href="/reportar">Reportar a otra persona</a>
        <a className="btn ghost" href="/buscar">Buscar por nombre</a>
      </div>
    </div>
  );
}
