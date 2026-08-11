// Per-incident configuration. In a real deployment this is the ONE file the team
// edits during activation (see docs/deployment-playbook.md).
export const incident = {
  id: "CO-2026-08-CHOCO",
  name: "Sismo Chocó, Colombia",
  country: "Colombia",
  city: "Quibdó",
  // Short, readable-over-the-radio host. Everything shared publicly points here.
  // Overridable at deploy time so a staging build never emits production links.
  publicBaseUrl: process.env.NEXT_PUBLIC_BASE_URL || "https://buscamos.co",
  countryCode: "CO",
  quakeAt: "2026-08-10T12:34:00Z",
  languages: ["es", "en"] as const,
  center: { lat: 5.6947, lng: -76.6611 }, // Quibdó
  zoom: 13,
  // Pre-loaded landmarks / shelters for offline location picking (no geocoder offline)
  landmarks: [
    "Coliseo Municipal",
    "Hospital San Francisco de Asís",
    "Parque Manuel Mosquera",
    "Colegio Carrasquilla",
    "Iglesia San Francisco",
    "Terminal de Transportes",
  ],
};

export const REFERENCE_PREFIX = incident.countryCode;
