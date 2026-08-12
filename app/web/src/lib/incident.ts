// Per-incident configuration. In a real deployment this is the ONE file the team
// edits during activation (see docs/deployment-playbook.md).
export const incident = {
  id: "CO-2026-08-PEREIRA",
  name: "Sismo Eje Cafetero, Colombia",
  country: "Colombia",
  city: "Pereira",
  // Short, readable-over-the-radio host. Everything shared publicly points here.
  //
  // Precedence (see publicUrlFor): an explicit NEXT_PUBLIC_BASE_URL wins, then
  // the origin the page is actually being served from, and only then this
  // fallback. A hardcoded host is the wrong default for a link that has to work
  // — whoever receives the card must land on the deployment that issued it.
  publicBaseUrlExplicit: process.env.NEXT_PUBLIC_BASE_URL || "",
  publicBaseUrl: process.env.NEXT_PUBLIC_BASE_URL || "https://buscamos.co",
  // Shown on every page while true. Set NEXT_PUBLIC_DEMO=0 only for a real activation.
  demo: process.env.NEXT_PUBLIC_DEMO !== "0",
  countryCode: "CO",
  quakeAt: "2026-08-10T12:34:00Z",
  languages: ["es", "en"] as const,
  // Pereira, Risaralda. The registry data is overwhelmingly Pereira and its
  // metro ring (Dosquebradas, La Virginia); Quibdó was the drill's setting and
  // is 200 km away.
  center: { lat: 4.8133, lng: -75.6961 }, // Pereira, Centro
  zoom: 13,
  // Everything the geocoder returns must land inside this box. A geocoder asked
  // for "Calle 24" will happily answer with a Calle 24 in Bogotá, 500 km away —
  // and a coordinate that far off does not read as an error on a map, it reads
  // as a second disaster site with people under it.
  //
  // The box covers the Pereira metro area: Pereira, Dosquebradas and La
  // Virginia. It deliberately does NOT cover Cali — Cali is ~200 km south, a
  // separate city with its own responders, and ~70 registry records point
  // there. Those records must NOT be silently placed on this map; they belong
  // to a second incident. Widening the box to swallow them would produce one
  // heat map spanning two departments, which reads as a single search area.
  bbox: { minLat: 4.74, minLng: -75.92, maxLat: 4.94, maxLng: -75.60 },
  // Pre-loaded landmarks for location picking. These carry COORDINATES on
  // purpose: offline there is no geocoder, and a landmark name without a point
  // is exactly the bug this list was supposed to prevent.
  //
  // Every coordinate below was resolved against Nominatim and is cached in
  // data/external/geocode-cache.json — none of them are typed by hand.
  landmarks: [
    { name: "Parque La Libertad", lat: 4.8149, lng: -75.6882 },
    { name: "Plaza de Bolívar (Centro)", lat: 4.8171, lng: -75.6959 },
    { name: "Hospital Universitario San Jorge", lat: 4.8181, lng: -75.6989 },
    { name: "Clínica Comfamiliar", lat: 4.8066, lng: -75.6808 },
    { name: "Clínica Los Rosales", lat: 4.8135, lng: -75.7002 },
    { name: "Universidad Tecnológica de Pereira", lat: 4.7943, lng: -75.6889 },
    { name: "Barrio Parque Industrial", lat: 4.8231, lng: -75.7311 },
    { name: "Aeropuerto Matecaña", lat: 4.8125, lng: -75.7403 },
  ],
};

export const REFERENCE_PREFIX = incident.countryCode;
