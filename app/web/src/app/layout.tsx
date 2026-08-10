import type { Metadata, Viewport } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Rescue Heatmap — reporte de personas desaparecidas",
  description:
    "Open-source missing-person intake and search-and-rescue heatmap. Works offline. Built from the Venezuela 2026 lessons learned.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0d1117",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
