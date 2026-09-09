import { bootstrapAdmin } from "./auth";
import { handleApi } from "./api";
import { tickListen } from "./listen";
import { dbNotReadyResponse, ensureSchema } from "./setup";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!(await ensureSchema(env))) {
      return dbNotReadyResponse(url.pathname.startsWith("/api/"));
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env) {
    if (!(await ensureSchema(env))) {
      console.log("[listen] scheduled.skip 数据库未就绪");
      return;
    }
    await bootstrapAdmin(env);
    console.log("[listen] scheduled.begin");
    await tickListen(env);
  },
} satisfies ExportedHandler<Env>;
