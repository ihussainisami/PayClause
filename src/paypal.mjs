// Local dev: read .env if present. On a server (Render) the values come from real environment variables.
try { process.loadEnvFile(".env"); } catch {}

const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, PAYPAL_ENV: env } = process.env;
if (env !== "sandbox") throw new Error("PAYPAL_ENV must be 'sandbox'");
if (!id || !secret) throw new Error("Client ID or secret missing in .env");

let token = null;
async function getToken() {
  if (token) return token;
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  token = (await r.json()).access_token;
  return token;
}

// body may be an object (sent as JSON) or an already-built JSON string (sent as is)
export async function pp(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
