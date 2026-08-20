"use strict";

/**
 * Credential storage for the desktop build.
 *
 * On the web the keys come from Vercel env vars; in the packaged app there is
 * no such thing, so they live in a single JSON file under the OS app-data
 * directory (`~/Library/Application Support/Asset Manager/config.json` on
 * macOS). The file is written 0600 — readable only by the logged-in user.
 *
 * The Next server reads all of these through `process.env`, exactly as it does
 * on Vercel, so no application code has to know the desktop build exists.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Keys we persist, in the order the Settings window shows them. */
const FIELDS = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    hint: "From console.anthropic.com → API Keys. Used to extract contract note PDFs.",
    secret: true,
    required: true,
  },
  {
    key: "ANTHROPIC_MODEL",
    label: "Model (optional)",
    hint: "Defaults to claude-opus-5.",
    secret: false,
    required: false,
  },
];

/**
 * Where the local portfolio database lives. The desktop build stores everything
 * it extracts here — no hosted database, no service-role key to look after — so
 * this path is the whole of the user's financial data and worth surfacing in
 * the Settings window for backups.
 */
function dbPath(app) {
  return path.join(app.getPath("userData"), "portfolio.db");
}

function configPath(app) {
  return path.join(app.getPath("userData"), "config.json");
}

function read(app) {
  try {
    const raw = fs.readFileSync(configPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing file on first launch, or hand-edited into invalid JSON. Either
    // way an empty config is the right answer: the app opens Settings.
    return {};
  }
}

function write(app, values) {
  const file = configPath(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = {};
  for (const { key } of FIELDS) {
    const v = typeof values[key] === "string" ? values[key].trim() : "";
    if (v) clean[key] = v;
  }
  // Write private from the start rather than chmod-ing after: a 0644 window,
  // however brief, is a window where another account can read the keys.
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

/** True when every `required: true` field has a value. */
function isComplete(values) {
  return FIELDS.filter((f) => f.required).every((f) => {
    const v = values[f.key];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/** Copy stored config into the env object handed to the Next server. */
function toEnv(values) {
  const env = {};
  for (const { key } of FIELDS) {
    if (values[key]) env[key] = values[key];
  }
  return env;
}

module.exports = { FIELDS, configPath, dbPath, read, write, isComplete, toEnv };
