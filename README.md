# 云村互助

## 本地

Node 22+

```bash
npm install
copy .dev.vars.example .dev.vars
npm run types
npm run dev
```

`.dev.vars` 里默认管理员是 `admin` / `changeme123`

`npm run dev` 带了 `--test-scheduled`。要手动跑一轮定时任务：http://localhost:8787/__scheduled，或者后台点「立即调度空闲账号」。
