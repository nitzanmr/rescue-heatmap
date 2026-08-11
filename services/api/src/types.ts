// Type augmentation: every request carries a resolved actor, attached once in a
// preHandler hook (index.ts). Routes never re-resolve identity.
import type { Actor } from "./security.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

export {};
