import { handleApi } from "./api";
import { handleListenQueue, recordCronError, tickListen, type ListenQueueMessage } from "./listen";
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
    const t0 = Date.now();
    try {
      if (!(await ensureSchema(env))) {
        console.log("[listen] scheduled.skip 数据库未就绪");
        return;
      }
      console.log("[listen] scheduled.begin");
      await tickListen(env);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[listen] scheduled.fail", message);
      try {
        await recordCronError(env, message, Date.now() - t0);
      } catch (err) {
        console.error("[listen] heartbeat.fail", err);
      }
    } finally {
      console.log(`[listen] scheduled.end wallMs=${Date.now() - t0}`);
    }
  },

  async queue(batch, env) {
    if (!(await ensureSchema(env))) {
      console.log("[listen] queue.skip 数据库未就绪");
      batch.retryAll({ delaySeconds: 30 });
      return;
    }
    await handleListenQueue(env, batch);
  },
} satisfies ExportedHandler<Env, ListenQueueMessage>;
