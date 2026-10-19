import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractTerms, listModels } from "../src/gemini.mjs";
import { verifyExtraction } from "../src/verify.mjs";

const clean = fs.readFileSync(new URL("../samples/clean-contract.txt", import.meta.url), "utf8");
const goodJson = JSON.stringify({
  total_fee: { value: 3000, quote: "The total fee for the project is $3,000.00 USD" },
  currency: { value: "USD", quote: "$3,000.00 USD" },
  net_days: { value: 15, quote: "Invoices are due Net 15 days from the invoice date" },
  scope_summary: { value: "Website", quote: "design and build a five-page marketing website" },
  milestones: [
    { name: "A", amount: 1000, quote: "$1,000.00 on signing" },
    { name: "B", amount: 1000, quote: "$1,000.00 on delivery of the design" },
    { name: "C", amount: 1000, quote: "$1,000.00 on launch" },
  ],
});
const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
const gem = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test("request: key goes in a header (never in the URL), temperature 0, JSON schema, contract wrapped as data", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => gem(goodJson) }; };
  await extractTerms(clean, { apiKey: "SECRET123", model: "m", fetchImpl });
  assert.ok(!seen.url.includes("SECRET123"));
  assert.equal(seen.init.headers["x-goog-api-key"], "SECRET123");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.match(body.contents[0].parts[0].text, /^<agreement>/);
  assert.match(body.systemInstruction.parts[0].text, /UNTRUSTED/);
});

test("model output flows into the verifier (clean -> verified)", async () => {
  const extraction = await extractTerms(clean, { apiKey: "k", model: "m", fetchImpl: reply(200, gem(goodJson)) });
  assert.equal(verifyExtraction(clean, extraction).status, "verified");
});

test("markdown-fenced JSON is accepted, garbage is an error", async () => {
  const fenced = "```json\n" + goodJson + "\n```";
  assert.ok((await extractTerms(clean, { apiKey: "k", model: "m", fetchImpl: reply(200, gem(fenced)) })).total_fee);
  await assert.rejects(extractTerms(clean, { apiKey: "k", model: "m", fetchImpl: reply(200, gem("sorry, I can't")) }), /valid JSON/);
});

test("HTTP errors carry the status (so the CLI can list models on 404)", async () => {
  await assert.rejects(
    extractTerms(clean, { apiKey: "k", model: "bad", fetchImpl: reply(404, { error: { message: "model not found" } }) }),
    (e) => e.status === 404 && /model not found/.test(e.message),
  );
});

test("listModels keeps only generateContent models", async () => {
  const names = await listModels({
    apiKey: "k",
    fetchImpl: reply(200, { models: [
      { name: "models/a", supportedGenerationMethods: ["generateContent"] },
      { name: "models/b", supportedGenerationMethods: ["embedContent"] },
    ] }),
  });
  assert.deepEqual(names, ["a"]);
});

import { extractWithFallback } from "../src/gemini.mjs";

test("503 on first model: retries, then falls back to the next model", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.includes("busy") ? "busy" : "ok");
    return url.includes("busy")
      ? { ok: false, status: 503, json: async () => ({ error: { message: "high demand" } }) }
      : { ok: true, status: 200, json: async () => gem(goodJson) };
  };
  const r = await extractWithFallback(clean, { apiKey: "k", models: ["busy", "ok"], fetchImpl, sleep: async () => {} });
  assert.equal(r.model, "ok");
  assert.deepEqual(calls, ["busy", "busy", "busy", "ok"]);
});

test("404 is not retried; all models failing throws the last error", async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 404, json: async () => ({ error: { message: "nope" } }) }; };
  await assert.rejects(extractWithFallback(clean, { apiKey: "k", models: ["a", "b"], fetchImpl, sleep: async () => {} }), /404/);
  assert.equal(n, 2);
});

test("network error (no status) is retried, not fatal", async () => {
  const { extractWithFallback } = await import("../src/gemini.mjs");
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"total_fee":{"value":1,"quote":"x"}}' }] } }] }) };
  };
  const r = await extractWithFallback("t", { apiKey: "k", models: ["m"], fetchImpl, sleep: async () => {} });
  assert.equal(n, 2);
  assert.equal(r.model, "m");
});
