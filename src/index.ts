import { bootstrapAdmin } from "./auth";
import { handleApi } from "./api";
import { tickListen } from "./listen";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    await bootstrapAdmin(env);
    console.log("[listen] scheduled.begin");
    await tickListen(env, ctx);
  },
} satisfies ExportedHandler<Env>;
