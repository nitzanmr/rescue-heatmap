// Mint an operator session token.
//
// There is deliberately NO password login endpoint in the API. Building one
// during an emergency is how you end up with a bcrypt round count chosen at
// 3 a.m. and a password reset flow nobody tested. Instead, an operator token is
// minted here, out of band, by whoever already has access to the deployment —
// and pasted once into the panel.
//
//   docker compose run --rm -e OPERATOR_EMAIL=ana@ungrd.gov.co migrate node dist/operator.js
//   make operator-token EMAIL=ana@ungrd.gov.co ROLE=admin
//
// The token is printed ONCE. We store sha256(pepper + token), never the token,
// so a database leak does not hand over the panel.
import { one, pool, query } from "./db.js";
import { assertConfig } from "./config.js";
import { hashToken, newToken } from "./security.js";
import { systemAudit } from "./audit.js";

async function main() {
  assertConfig();

  const email = process.env.OPERATOR_EMAIL?.trim().toLowerCase();
  const role = (process.env.OPERATOR_ROLE ?? "operator").trim();
  const days = Number(process.env.OPERATOR_DAYS ?? 7);

  if (!email) throw new Error("OPERATOR_EMAIL is required");
  if (role !== "operator" && role !== "admin") throw new Error("OPERATOR_ROLE must be operator or admin");
  if (!Number.isFinite(days) || days <= 0 || days > 90) {
    // A session that outlives the deployment is a credential nobody remembers
    // issuing. 90 days is already generous for an incident that lasts weeks.
    throw new Error("OPERATOR_DAYS must be between 1 and 90");
  }

  const user = await one<{ id: string; role: string }>(
    `INSERT INTO app_user (email, role, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, disabled_at = NULL
     RETURNING id, role`,
    [email, role, process.env.OPERATOR_NAME ?? email.split("@")[0]]
  );

  const token = newToken(24); // 192-bit: this one opens every case in the incident
  await query(
    `INSERT INTO user_session (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [user!.id, hashToken(token), days]
  );

  await systemAudit("operator.token_issued", { email, role, days }).catch(() => {});

  process.stdout.write(
    [
      "",
      "  Operator token (shown once — it is not recoverable):",
      "",
      `    ${token}`,
      "",
      `  user:    ${email} (${user!.role})`,
      `  expires: ${days} day(s)`,
      "",
      "  Paste it into the panel at /panel.",
      "",
    ].join("\n")
  );

  await pool.end();
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: err.message }));
  process.exit(1);
});
