"use client";
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import { incident } from "@/lib/incident";
import { Report, reportWeight } from "@/lib/schema";

interface Props {
  reports: Report[];
  mode: "heat" | "points";
  onSelect?: (r: Report) => void;
}

export default function HeatMap({ reports, mode, onSelect }: Props) {
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
    const geo = reports.filter((r) => r.last_seen_lat != null && r.last_seen_lng != null);

    if (mode === "heat") {
      const pts = geo.map((r) => [r.last_seen_lat!, r.last_seen_lng!, reportWeight(r)] as [number, number, number]);
      // @ts-expect-error leaflet.heat has no bundled types
      layer.current = L.heatLayer(pts, {
        radius: 28,
        blur: 22,
        maxZoom: 17,
        gradient: { 0.2: "#2b6cb0", 0.45: "#f0c674", 0.7: "#f0883e", 1.0: "#ff3b3b" },
      }).addTo(m);
    } else {
      const group = L.layerGroup();
      geo.forEach((r) => {
        const color =
          r.status === "trapped_alive" ? "#ff3b3b" : r.status === "missing" ? "#f0c674" : "#3fb950";
        const marker = L.circleMarker([r.last_seen_lat!, r.last_seen_lng!], {
          radius: 5 + Math.min((r.reporter_count ?? 1) - 1, 4),
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.45,
        });
        marker.bindPopup(
          `<strong>${r.full_name}</strong><br/>${r.last_seen_address ?? ""}<br/>` +
            `<span style="opacity:.7">${r.reference_number} · ${r.status} · ${r.location_accuracy}</span>`
        );
        if (onSelect) marker.on("click", () => onSelect(r));
        group.addLayer(marker);
      });
      layer.current = group.addTo(m);
    }
  }, [reports, mode, onSelect]);

  return <div ref={el} className="map" />;
}
