import { route } from "../src/app-lib.mjs";
export default route("GET", (s, req) => s.state(String(req.query.id)));
