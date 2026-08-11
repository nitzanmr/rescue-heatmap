"use client";
// The PUBLIC map. Deliberately a different component from HeatMap.tsx (the
// command panel's map), not a prop on it.
//
// The reason is the privacy boundary, and it is worth being blunt about: if one
// component renders both audiences, then the only thing standing between an
// exact case location and the open internet is a boolean prop, and a boolean
// prop is one careless refactor away from being wrong. Two components fed by two
// endpoints cannot leak into each other.
//
// What this map answers, in order:
//   1. "Where do I go" — shelters, hospitals, pharmacies, responders.
//   2. "Where is the event concentrated" — coarse (>=500 m) aggregated heat.
// Never "where is this specific person": that is /buscar, by name, one at a time.
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet.heat";
import { incident } from "@/lib/incident";
import type { AidSite, HeatCell } from "@/lib/api";
import { clusterPoints } from "@/lib/cluster";
import { KIND_STYLE } from "@/lib/aid-kinds";
import { shouldFailover, tileChain, type TileProvider } from "@/lib/tiles";

interface Props {
  cells: HeatCell[];
  sites: AidSite[];
  showHeat: boolean;
  showSites: boolean;
  cellM: number;
}


export default function PublicMap({ cells, sites, showHeat, showSites, cellM }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const heat = useRef<L.Layer | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const [zoom, setZoom] = useState(incident.zoom);
  const chain = useMemo(() => tileChain(), []);
  const [providerIdx, setProviderIdx] = useState(0);

  // --- base map + tile failover ------------------------------------------
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true }).setView(
      [incident.center.lat, incident.center.lng],
      incident.zoom
    );
    map.current = m;
    m.on("zoomend", () => setZoom(m.getZoom()));
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const provider: TileProvider | undefined = chain[providerIdx];
    if (!m || !provider) return;
    if (tiles.current) m.removeLayer(tiles.current);

    let loaded = 0;
    let errored = 0;
    const layer = L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: provider.maxZoom,
    });
    layer.on("tileload", () => {
      loaded++;
    });
    // One failed tile is a tunnel; a sustained failure rate is a block or an
    // exhausted quota, and that is when we move down the chain. Automatic,
    // because the alternative is a grey map until somebody deploys — and during
    // an activation nobody is deploying.
    layer.on("tileerror", () => {
      errored++;
      if (shouldFailover(loaded, errored) && providerIdx < chain.length - 1) {
        console.warn(`[tiles] ${provider.id} failing (${errored}/${loaded + errored}) — falling back`);
        setProviderIdx((i) => i + 1);
      }
    });
    layer.addTo(m);
    tiles.current = layer;
  }, [chain, providerIdx]);

  // --- heat ---------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (heat.current) {
      m.removeLayer(heat.current);
      heat.current = null;
    }
    if (!showHeat || !cells.length) return;
    const max = Math.max(...cells.map((c) => c.weight)) || 1;
    const pts = cells.map((c) => [c.lat, c.lng, c.weight / max] as [number, number, number]);
    // Warmer, lighter ramp than the panel's: this sits on a light basemap and is
    // read by civilians, not by a night shift in a command room.
    // @ts-expect-error leaflet.heat has no bundled types
    heat.current = L.heatLayer(pts, {
      radius: 34,
      blur: 18,
      maxZoom: 16,
      minOpacity: 0.25,
      gradient: { 0.2: "#ffe08a", 0.5: "#f0883e", 0.8: "#ff5c5c", 1.0: "#c02020" },
    }).addTo(m);
  }, [cells, showHeat]);

  // --- aid sites, clustered ----------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (markers.current) {
      m.removeLayer(markers.current);
      markers.current = null;
    }
    if (!showSites || !sites.length) return;

    const group = L.layerGroup();
    // Verified first, so a cluster's representative marker is a site somebody
    // actually stood in rather than an OSM guess.
    const ordered = [...sites].sort((a, b) => Number(b.verified) - Number(a.verified));
    for (const c of clusterPoints(ordered, zoom, 56)) {
      if (c.items.length === 1) {
        const s = c.items[0];
        const style = KIND_STYLE[s.kind] ?? KIND_STYLE.other;
        L.circleMarker([s.lat, s.lng], {
          radius: 7,
          color: style.colour,
          weight: s.verified ? 3 : 1,
          // Unverified sites are hollow and dashed. A family must be able to see
          // at a glance that "there is a hospital here according to a map" is not
          // the same claim as "we were there this morning".
          dashArray: s.verified ? undefined : "3 3",
          fillColor: style.colour,
          fillOpacity: s.verified ? 0.75 : 0.25,
        })
          .bindPopup(
            `<strong>${escapeHtml(s.name)}</strong><br/>${style.label}` +
              (s.address ? `<br/>${escapeHtml(s.address)}` : "") +
              (s.phone ? `<br/><a href="tel:${escapeHtml(s.phone)}">${escapeHtml(s.phone)}</a>` : "") +
              `<br/><span style="opacity:.7">${
                s.verified ? "Verificado en terreno" : "Sin verificar — confirme antes de desplazarse"
              }</span>`
          )
          .addTo(group);
      } else {
        const n = c.items.length;
        L.marker([c.lat, c.lng], {
          icon: L.divIcon({
            className: "cluster",
            html: `<div class="cluster-badge">${n}</div>`,
            iconSize: [34, 34],
          }),
        })
          .on("click", () => m.setView([c.lat, c.lng], Math.min(m.getZoom() + 2, 18)))
          .addTo(group);
      }
    }
    markers.current = group.addTo(m);
  }, [sites, showSites, zoom]);

  return (
    <>
      <div ref={el} className="map map-light" />
      <p className="muted small" style={{ marginTop: 8 }}>
        Celdas de {cellM} m — el mapa muestra zonas, nunca direcciones.{" "}
        {chain[providerIdx] ? `Base: ${chain[providerIdx].id}.` : ""} Sitios de ayuda: OpenStreetMap (ODbL).
      </p>
    </>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
