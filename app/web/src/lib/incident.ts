// Per-incident configuration. In a real deployment this is the ONE file the team
// edits during activation (see docs/deployment-playbook.md).
export const incident = {
  id: "CO-2026-08-CHOCO",
  name: "Sismo Chocó, Colombia",
  country: "Colombia",
  city: "Quibdó",
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
  center: { lat: 5.6947, lng: -76.6611 }, // Quibdó
  zoom: 13,
  // Everything the geocoder returns must land inside this box. A geocoder asked
  // for "Calle 24" will happily answer with a Calle 24 in Bogotá, 500 km away —
  // and a coordinate that far off does not read as an error on a map, it reads
  // as a second disaster site with people under it.
  bbox: { minLat: 5.60, minLng: -76.74, maxLat: 5.79, maxLng: -76.58 },
  // Pre-loaded landmarks for location picking. These carry COORDINATES on
  // purpose: offline there is no geocoder, and a landmark name without a point
  // is exactly the bug this list was supposed to prevent.
  landmarks: [
    { name: "Coliseo Municipal", lat: 5.6926, lng: -76.6585 },
    { name: "Hospital San Francisco de Asís", lat: 5.6939, lng: -76.6552 },
    { name: "Parque Manuel Mosquera", lat: 5.6919, lng: -76.6616 },
    { name: "Colegio Carrasquilla", lat: 5.6892, lng: -76.6603 },
    { name: "Iglesia San Francisco", lat: 5.6913, lng: -76.6628 },
    { name: "Terminal de Transportes", lat: 5.6836, lng: -76.6470 },
  ],
};

export const REFERENCE_PREFIX = incident.countryCode;
