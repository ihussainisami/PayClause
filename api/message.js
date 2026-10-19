import { route } from "../src/app-lib.mjs";
export default route("POST", (s, req, ctx) => s.payerMessage(String(req.body?.id), req.body?.message, ctx));
