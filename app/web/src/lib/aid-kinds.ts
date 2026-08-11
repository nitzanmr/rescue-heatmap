// Aid-site colours and Spanish labels.
//
// This lives in lib/, not inside PublicMap.tsx, for a reason that cost us a
// build: the legend on /mapa needs these values during server render, while the
// map component itself can only ever run in a browser (Leaflet touches `window`
// at import time). Keeping the table beside the map forced the page to import
// the map statically, which dragged Leaflet into the server bundle and broke
// prerender — even though the component itself was correctly loaded with
// `ssr: false`.
//
// Rule this encodes: data that both sides need is data, and data does not live
// inside a browser-only module.
export interface KindStyle {
  colour: string;
  label: string;
}

export const KIND_STYLE: Record<string, KindStyle> = {
  shelter: { colour: "#3fb950", label: "Albergue" },
  shelter_candidate: { colour: "#8b949e", label: "Posible albergue (sin confirmar)" },
  medical: { colour: "#ff5c5c", label: "Hospital / clínica" },
  pharmacy: { colour: "#d29922", label: "Farmacia" },
  responder: { colour: "#58a6ff", label: "Bomberos / policía" },
  supply: { colour: "#f0883e", label: "Punto de acopio" },
  water: { colour: "#39c5cf", label: "Agua" },
  morgue: { colour: "#6e7681", label: "Morgue" },
  info_point: { colour: "#a371f7", label: "Punto de información" },
  other: { colour: "#8b949e", label: "Otro" },
};

export function kindStyle(kind: string): KindStyle {
  return KIND_STYLE[kind] ?? KIND_STYLE.other;
}
