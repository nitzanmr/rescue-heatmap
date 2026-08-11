import type { Metadata } from "next";
import { Suspense } from "react";
import { incident } from "@/lib/incident";
import PersonPage from "./PersonPage";

// Where the API lives as seen FROM THE SERVER. In the browser the client uses a
// relative /api path that Next rewrites; server-side rendering has no origin to
// be relative to, so it needs the internal address (http://api:8080 in compose).
const SERVER_API = process.env.API_ORIGIN ?? "http://api:8080";

// Link-preview tags. A WhatsApp link that unfurls as an empty grey rectangle is
// read as phishing and does not get forwarded — this small technical detail is
// worth more than any social-media plan.
//
// The preview is rendered from the PUBLIC projection only, and the page is
// noindex: a card that spreads through WhatsApp is not the same thing as a page
// Google may keep after the family asks us to delete it.
export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }): Promise<Metadata> {
  const { ref } = await params;
  const reference = decodeURIComponent(ref).toUpperCase();

  let title = `Persona desaparecida — ${incident.name}`;
  let description = `Reporte ${reference}. Si la has visto o sabes algo, entra y avísanos.`;

  try {
    const res = await fetch(`${SERVER_API}/v1/public/cases/${encodeURIComponent(reference)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const c = (await res.json()) as { name: string; age_approx: number | null; status: string };
      const found = c.status.startsWith("found");
      title = found
        ? `${c.name} ya apareció — ${incident.name}`
        : `SE BUSCA: ${c.name}${c.age_approx ? ` (~${c.age_approx} años)` : ""} — ${incident.name}`;
      description = found
        ? `${c.name} fue encontrada. No hace falta seguir compartiendo esta ficha.`
        : `Si has visto a ${c.name} o sabes algo, entra y avísanos. Ref. ${reference}.`;
    }
  } catch {
    // A slow or unavailable API must never block the page from rendering. The
    // generic preview is worse, not fatal.
  }

  return {
    title,
    description,
    openGraph: { title, description, type: "article", siteName: "Rescue Heatmap", locale: "es_CO" },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: false, follow: false }, // ADR-001: never indexed by search engines
  };
}

export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return (
    <Suspense fallback={<div className="wrap-narrow"><p className="muted small">Cargando…</p></div>}>
      <PersonPage reference={decodeURIComponent(ref).toUpperCase()} />
    </Suspense>
  );
}
