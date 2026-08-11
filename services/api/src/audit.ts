import { query } from "./db.js";
import { Actor, actorLabel } from "./security.js";

// Every operator/admin write, every export, every merge, every erasure.
// The app role has no UPDATE/DELETE on this table (0005_roles.sql).
export async function audit(
  actor: Actor,
  action: string,
  subject: string | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `INSERT INTO audit_log (actor, role, action, subject, ip_hash, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorLabel(actor), actor.kind, action, subject, actor.ipHash, JSON.stringify(detail)]
  );
}

export async function systemAudit(action: string, detail: Record<string, unknown> = {}) {
  await query(
    `INSERT INTO audit_log (actor, role, action, detail) VALUES ('system','system',$1,$2)`,
    [action, JSON.stringify(detail)]
  );
}
