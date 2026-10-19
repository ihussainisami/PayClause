// Keeps the Supabase free project from pausing (Vercel cron calls this daily) and gives a simple uptime check.
import { route } from "../src/app-lib.mjs";
export default route("GET", async (s) => { await s.ping(); return { ok: true, at: new Date().toISOString() }; });
