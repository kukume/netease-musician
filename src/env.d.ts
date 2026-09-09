/** Cap bindings come from .dev.vars, Dashboard, or secrets — not wrangler.jsonc vars. */
interface Env {
  CAP_URL: string;
  CAP_SITE_KEY: string;
  CAP_SECRET_KEY: string;
}
