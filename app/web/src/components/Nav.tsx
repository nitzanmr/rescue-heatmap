"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { incident } from "@/lib/incident";

const links = [
  { href: "/", label: "Producto" },
  { href: "/reportar", label: "Reportar" },
  { href: "/buscar", label: "Buscar" },
  { href: "/panel", label: "Panel de mando" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <>
      <div className="mock-banner">
        MAQUETA / DEMO — {incident.name}. Datos ficticios, nada se envía a ninguna autoridad.
      </div>
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
