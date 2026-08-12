"use client";
// Confirm-the-point map for the intake form.
//
// Browser-only (Leaflet touches `window` at import time) — every page that uses
// it must load it with `dynamic(..., { ssr: false })` and must not import any
// binding from this file statically. See services/api/test/ssr-safety.test.ts.
//
// Why a confirmation step at all: a geocoder answering "Cra 1 con Calle 24" is
// making a guess about a street, not about the house that collapsed. The person
// who was there is the only one who can move the pin the fifty metres that
// decide which building a team opens first.
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { incident } from "@/lib/incident";
import { withinIncident } from "@/lib/geo";
import { shouldFailover, tileChain, type TileProvider } from "@/lib/tiles";

interface Props {
  lat?: number | null;
  lng?: number | null;
  onPick: (lat: number, lng: number) => void;
}

export default function LocationPicker({ lat, lng, onPick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const [providerIdx, setProviderIdx] = useState(0);
  const [outside, setOutside] = useState(false);
  const chain = useRef<TileProvider[]>(tileChain());

  useEffect(() => {
    if (!el.current || map.current) return;
    const start: [number, number] =
      lat != null && lng != null ? [lat, lng] : [incident.center.lat, incident.center.lng];
    const m = L.map(el.current, { zoomControl: true }).setView(start, lat != null ? 17 : incident.zoom);
    map.current = m;

    const pin = L.marker(start, { draggable: true }).addTo(m);
    marker.current = pin;
    const commit = (p: L.LatLng) => {
      const ok = withinIncident(p.lat, p.lng);
      setOutside(!ok);
      if (ok) onPick(p.lat, p.lng);
    };
    pin.on("dragend", () => commit(pin.getLatLng()));
    m.on("click", (e: L.LeafletMouseEvent) => {
      pin.setLatLng(e.latlng);
      commit(e.latlng);
    });

    return () => {
      m.remove();
      map.current = null;
      marker.current = null;
    };
    // Deliberately mounted once: re-creating the map on every parent render
    // would throw away the pin the user just placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basemap in its own effect so a failover swaps the layer without tearing
  // down the map — and with it the pin the user just placed.
  useEffect(() => {
    const m = map.current;
    const provider = chain.current[providerIdx];
    if (!m || !provider) return;
    let loaded = 0;
    let errored = 0;
    const layer = L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: provider.maxZoom,
    });
    layer.on("tileload", () => { loaded++; });
    layer.on("tileerror", () => {
      errored++;
      if (shouldFailover(loaded, errored) && providerIdx < chain.current.length - 1) {
        setProviderIdx((i) => i + 1);
      }
    });
    layer.addTo(m);
    return () => { layer.remove(); };
  }, [providerIdx]);

  // Keep the pin in step when the point changes from outside (a geocoder result
  // chosen, or "use my location" pressed) without rebuilding the map.
  useEffect(() => {
    if (lat == null || lng == null || !map.current || !marker.current) return;
    marker.current.setLatLng([lat, lng]);
    map.current.setView([lat, lng], Math.max(map.current.getZoom(), 17));
  }, [lat, lng]);

  return (
    <div>
      <div ref={el} style={{ height: 260, borderRadius: 10, overflow: "hidden" }} />
      <p className="small muted" style={{ marginTop: 6 }}>
        Toca el mapa o arrastra el punto hasta el lugar exacto.
      </p>
      {outside && (
        <p className="small" style={{ color: "var(--danger)", marginTop: 4 }}>
          Ese punto está fuera de la zona del evento. No se guardó.
        </p>
      )}
    </div>
  );
}
