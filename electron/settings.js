"use strict";

/** Renderer for the Settings window. Talks to main only via `window.settingsApi`. */

const form = document.getElementById("form");
const statusEl = document.getElementById("status");
const storageEl = document.getElementById("storage");

let fields = [];

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind ? `status ${kind}` : "status";
}

async function init() {
  fields = await window.settingsApi.fields();
  const saved = await window.settingsApi.read();

  for (const field of fields) {
    const wrap = document.createElement("div");
    wrap.className = "field";

    const label = document.createElement("label");
    label.setAttribute("for", field.key);
    label.textContent = field.label;
    if (field.required) {
      const star = document.createElement("span");
      star.className = "req";
      star.textContent = " *";
      label.appendChild(star);
    }

    const input = document.createElement("input");
    input.id = field.key;
    input.name = field.key;
    // `password` keeps keys out of over-the-shoulder view and screen shares.
    input.type = field.secret ? "password" : "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = saved[field.key] || "";

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = field.hint;

    wrap.append(label, input, hint);
    form.appendChild(wrap);
  }

  storageEl.textContent = `Stored at: ${await window.settingsApi.path()}`;
}

document.getElementById("save").addEventListener("click", async () => {
  const values = {};
  for (const field of fields) {
    values[field.key] = document.getElementById(field.key).value;
  }

  const missing = fields
    .filter((f) => f.required && !values[f.key].trim())
    .map((f) => f.label);

  if (missing.length) {
    setStatus(`Still needed: ${missing.join(", ")}`, "err");
    return;
  }

  const result = await window.settingsApi.save(values);
  setStatus(
    result.needsRestart
      ? "Saved. Quit and reopen Asset Manager for the keys to take effect."
      : "Saved.",
    "ok"
  );
});

document.getElementById("cancel").addEventListener("click", () => window.close());

init().catch((err) => setStatus(String(err?.message || err), "err"));
