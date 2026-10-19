import { route } from "../src/app-lib.mjs";
export default route("GET", (s, req) => s.ledger(req.query?.id));
