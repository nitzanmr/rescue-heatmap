// Demo data ONLY — fictional people, used to show what the dashboard looks like
// with traffic. Nothing here is a real report.
import { incident } from "./incident";
import { Report, Channel, Status, LocationAccuracy, newReferenceNumber, newUuid } from "./schema";

const names = [
  "María Ramírez Mosquera", "Maria Ramirez", "Jhon Alexander Palacios", "Yuliana Córdoba",
  "Luis Fernando Rentería", "Ana Milena Asprilla", "Carlos Andrés Moreno", "Deivis Perea",
  "Rosa Elvira Cuesta", "Andrés Felipe Valencia", "Katherine Murillo", "Jorge Iván Copete",
  "Sandra Patricia Lozano", "Miguel Ángel Hurtado", "Leidy Johana Chaverra", "Wilmer Serna",
  "Doña Blanca (la señora de la tienda)", "el hijo de Marta", "Elkin Bonilla", "Nubia Perea Rivas",
];
const streets = [
  "Cra 1 con Calle 24", "Barrio Niño Jesús", "Calle 26 #5-12", "Edificio Los Almendros",
  "Coliseo Municipal", "Barrio Yesquita", "Av. del Río, cerca al puente", "Colegio Carrasquilla",
  "Hospital San Francisco de Asís", "Barrio Kennedy, casa azul",
];
const relations = ["family", "neighbour", "friend", "witness", "other"] as const;
const channels: Channel[] = ["pwa", "pwa", "pwa", "whatsapp", "whatsapp", "sms", "paper", "node", "field"];
const accuracies: LocationAccuracy[] = ["exact", "building", "building", "block", "neighbourhood", "unknown"];

// Demo-only stand-in for a real photo: a procedural avatar, never a real face.
// It exists so the shareable card and the public list can be reviewed with and
// without an image — a card with a face and one without behave very differently.
function demoAvatar(name: string, seed: number): string {
  const hues = [12, 28, 42, 190, 210, 260, 330];
  const h = hues[seed % hues.length];
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${h},45%,42%)"/><stop offset="100%" stop-color="hsl(${h},50%,24%)"/>
    </linearGradient></defs>
    <rect width="400" height="400" fill="url(#g)"/>
    <circle cx="200" cy="158" r="66" fill="rgba(255,255,255,.28)"/>
    <path d="M76 400c0-72 56-118 124-118s124 46 124 118z" fill="rgba(255,255,255,.28)"/>
    <text x="200" y="372" font-family="sans-serif" font-size="34" font-weight="700"
      text-anchor="middle" fill="rgba(255,255,255,.75)">${initials || "?"}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function rnd<T>(a: readonly T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

export function mockReports(): Report[] {
  const out: Report[] = [];
  // three collapse clusters + scattered reports
  const clusters = [
    { lat: incident.center.lat + 0.004, lng: incident.center.lng - 0.003, n: 14, label: "Edificio Los Almendros" },
    { lat: incident.center.lat - 0.006, lng: incident.center.lng + 0.005, n: 10, label: "Barrio Yesquita" },
    { lat: incident.center.lat + 0.009, lng: incident.center.lng + 0.008, n: 7, label: "Colegio Carrasquilla" },
  ];
  const now = Date.now();

  const push = (lat: number, lng: number, building: string | null, i: number) => {
    const status: Status =
      Math.random() < 0.06 ? "trapped_alive" : Math.random() < 0.15 ? "found_safe" : Math.random() < 0.05 ? "found_injured" : "missing";
    const ch = rnd(channels);
    const name = rnd(names);
    const hasPhoto = Math.random() < 0.55;
    out.push({
      uuid: newUuid(),
      reference_number: newReferenceNumber(incident.countryCode),
      incident_id: incident.id,
      channel: ch,
      node_id: ch === "node" ? "NODE-02 (Coliseo)" : null,
      created_at_device: new Date(now - Math.random() * 1000 * 60 * 60 * 30).toISOString(),
      received_at_server: new Date(now - Math.random() * 1000 * 60 * 60 * 20).toISOString(),
      sync_state: Math.random() < 0.08 ? "queued" : "acked",
      full_name: name,
      photo_data_url: hasPhoto ? demoAvatar(name, i) : null,
      // Publication of the photo is opt-IN: most people grant it, some do not.
      consent_photo_public: hasPhoto ? Math.random() < 0.75 : false,
      consent_public_listing: Math.random() > 0.08,
      age_approx: Math.random() < 0.85 ? Math.floor(Math.random() * 78) + 2 : null,
      gender: rnd(["m", "f", "unknown"] as const),
      distinguishing_info: Math.random() < 0.4 ? rnd(["camisa blanca, sandalias", "cicatriz en el brazo", "usa bastón", "camiseta amarilla de la selección"]) : null,
      medical_info: Math.random() < 0.15 ? rnd(["diabético, necesita insulina", "hipertensa", "diálisis 3x semana"]) : null,
      national_id_last4: Math.random() < 0.35 ? String(Math.floor(Math.random() * 9000) + 1000) : null,
      last_seen_lat: lat,
      last_seen_lng: lng,
      location_accuracy: building ? rnd(["exact", "building"] as const) : rnd(accuracies),
      last_seen_address: building ?? rnd(streets),
      building_name: building,
      floor: building && Math.random() < 0.7 ? String(Math.floor(Math.random() * 6) + 1) : null,
      apartment: building && Math.random() < 0.5 ? String(Math.floor(Math.random() * 9) + 101) : null,
      last_contact_at: new Date(now - Math.random() * 1000 * 60 * 60 * 34).toISOString(),
      last_contact_precision: rnd(["exact", "same_day", "approximate", "unknown"] as const),
      reporter_name: rnd(["Luz Marina", "Hernán", "Yesenia", "Alberto", "Vecina del 3er piso"]),
      reporter_phone: "+57 3" + Math.floor(10000000 + Math.random() * 89999999),
      reporter_relation: rnd(relations),
      reporter_lang: "es",
      status,
      status_source: Math.random() < 0.12 ? "verified_field" : "citizen",
      status_updated_at: new Date(now - Math.random() * 1000 * 60 * 60 * 10).toISOString(),
      reporter_count: Math.random() < 0.25 ? Math.floor(Math.random() * 5) + 2 : 1,
      dedup_cluster_id: Math.random() < 0.18 ? "cluster-" + (i % 7) : null,
    });
  };

  let i = 0;
  clusters.forEach((c) => {
    for (let k = 0; k < c.n; k++) {
      push(c.lat + (Math.random() - 0.5) * 0.0012, c.lng + (Math.random() - 0.5) * 0.0012, c.label, i++);
    }
  });
  for (let k = 0; k < 28; k++) {
    push(
      incident.center.lat + (Math.random() - 0.5) * 0.05,
      incident.center.lng + (Math.random() - 0.5) * 0.05,
      null,
      i++
    );
  }
  return out.sort((a, b) => (a.created_at_device < b.created_at_device ? 1 : -1));
}
