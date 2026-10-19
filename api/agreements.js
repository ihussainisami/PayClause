import { route } from "../src/app-lib.mjs";
export default route("POST", (s, req, ctx) => s.submitAgreement({ text: req.body?.text, sampleId: req.body?.sampleId }, ctx));
