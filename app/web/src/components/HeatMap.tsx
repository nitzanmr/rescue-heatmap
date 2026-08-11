"use client";
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import { incident } from "@/lib/incident";
import type { HeatCell } from "@/lib/api";

interface Props {
  /** Aggregated cells from the server. The browser never receives case points. */
  cells: HeatCell[];
  mode: "heat" | "points";
  /** Cell size in metres, for the legend and the marker radius. */
  cellM?: number;
}

// The map renders AGGREGATES, not people.
//
// This is not a display choice, it is the privacy boundary: heat_cells() does the
// grouping in SQL and the API never returns an individual location to a browser.
// A front-end that received points and blurred them client-side would have
// already lost — the exact coordinates would be in the network tab.
export default function HeatMap({ cells, mode, cellM = 100 }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.Layer | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true }).setView(
      [incident.center.lat, incident.center.lng],
      incident.zoom
    );
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 19,
    }).addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (layer.current) {
      m.removeLayer(layer.current);
      layer.current = null;
    }
    if (!cells.length) return;

    // Normalise against the strongest cell. Without this, one building with many
    // reports saturates the gradient and every other street reads as empty.
    const max = Math.max(...cells.map((c) => c.weight)) || 1;

    if (mode === "heat") {
      const pts = cells.map((c) => [c.lat, c.lng, c.weight / max] as [number, number, number]);
      // @ts-expect-error leaflet.heat has no bundled types
      layer.current = L.heatLayer(pts, {
        radius: 28,
        blur: 22,
        maxZoom: 17,
        gradient: { 0.2: "#2b6cb0", 0.45: "#f0c674", 0.7: "#f0883e", 1.0: "#ff3b3b" },
      }).addTo(m);
    } else {
      const group = L.layerGroup();
      cells.forEach((c) => {
        const intensity = c.weight / max;
        const colour = intensity > 0.66 ? "#ff3b3b" : intensity > 0.33 ? "#f0c674" : "#2b6cb0";
        const marker = L.circleMarker([c.lat, c.lng], {
          radius: 5 + Math.min(c.cases, 8),
          color: colour,
          weight: 2,
          fillColor: colour,
          fillOpacity: 0.35,
        });
        marker.bindPopup(
          `<strong>${c.cases} caso(s)</strong><br/>peso ${c.weight.toFixed(2)}<br/>` +
            `<span style="opacity:.7">celda de ${cellM} m — no es una dirección</span>`
        );
        group.addLayer(marker);
      });
      layer.current = group.addTo(m);
    }
  }, [cells, mode, cellM]);

  return <div ref={el} className="map" />;
}
