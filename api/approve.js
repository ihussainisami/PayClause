import { route } from "../src/app-lib.mjs";
export default route("POST", (s, req) => s.approveAgreement(String(req.body?.id)));
