"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { incident } from "@/lib/incident";

const links = [
  { href: "/", label: "Producto" },
  { href: "/reportar", label: "Reportar" },
  { href: "/buscar", label: "Buscar" },
  { href: "/mapa", label: "Mapa" },
  { href: "/panel", label: "Panel de mando" },
];

// Demo unless a deployment explicitly says otherwise (NEXT_PUBLIC_DEMO=0).
const isDemo = incident.demo;

export default function Nav() {
  const path = usePathname();
  return (
    <>
      {/* This banner is a safety interlock, not decoration: it is driven by an
          explicit deploy-time flag, so a staging build cannot quietly look like
          the real thing to a family reporting a missing person. */}
      {isDemo && (
        <div className="mock-banner">
          ENTORNO DE PRUEBAS — {incident.name}. Los reportes enviados aquí no llegan a ningún equipo de rescate.
        </div>
      )}
      <div className="topbar">
        <Link href="/" className="brand">
          <span className="dot" />
          Rescue Heatmap
        </Link>
        <nav className="nav">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={path === l.href ? "active" : ""}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
