import type { Metadata } from "next";
import { incident } from "@/lib/incident";
import PersonPage from "./PersonPage";

// Link-preview tags. A WhatsApp link that unfurls as an empty grey rectangle is
// read as phishing and does not get forwarded — this small technical detail is
// worth more than any social-media plan.
//
// Today the report only exists in the browser (no backend), so the preview is
// incident-level. The moment /api/reports exists, this function fetches the
// report and emits the real name, area and card image. Marked in the tracker.
export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }): Promise<Metadata> {
  const { ref } = await params;
  const title = `Persona desaparecida — ${incident.name}`;
  const description = `Reporte ${decodeURIComponent(ref)}. Si la has visto o sabes algo, entra y avísanos. También puedes reportar a alguien más o avisar que estás bien.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      siteName: "Rescue Heatmap",
      locale: "es_CO",
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: false, follow: false }, // ADR-001: never indexed by search engines
  };
}

export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return <PersonPage reference={decodeURIComponent(ref).toUpperCase()} />;
}
