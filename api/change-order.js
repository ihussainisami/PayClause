import { route } from "../src/app-lib.mjs";
export default route("POST", (s, req, ctx) => s.approveChangeOrder(String(req.body?.decisionId), ctx));
