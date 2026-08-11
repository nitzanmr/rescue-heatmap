import { Report } from "@/lib/schema";

export default function StatusBadge({ status }: { status: Report["status"] }) {
  const map: Record<string, [string, string]> = {
    missing: ["missing", "Se busca"],
    trapped_alive: ["trapped", "Atrapado con vida"],
    found_safe: ["safe", "Apareció"],
    found_injured: ["injured", "Herido"],
    deceased: ["muted", "Fallecido"],
    withdrawn: ["muted", "Retirado"],
  };
  const [cls, label] = map[status] ?? ["muted", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}
