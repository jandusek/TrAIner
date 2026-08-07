// Settings page — connect data sources (Health Auto Export) and clients (MCP).
// React (no build) via htm + esm.sh; Phosphor icons. Sibling to home.client.js
// but its own bundle, per this app's one-file-per-route convention.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { html } from "htm/react";
import * as Ph from "@phosphor-icons/react";

const BOOT = JSON.parse(document.getElementById("bootstrap").textContent);

/* HDR glow — see home.client.js. Applied only to the profile Save, which is
   the page's primary action. */
const themeKey = () => document.documentElement.dataset.theme || "illuminate";


/* ── Theme picker ──────────────────────────────────────────────────────────
   Themes are pure CSS: each owns the accent family and the two zone scales,
   selected by data-theme on <html> (see ui.css). Switching is therefore a
   single attribute write — no re-render, no reload.

   The choice is persisted to localStorage and re-applied by an inline script
   in the page shell that runs before the stylesheet, so a reload does not
   flash Illuminate before settling on the saved theme. */
const THEMES = {
  "illuminate": {
    "label": "Illuminate",
    "swatches": [
      "#afffa9",
      "#3fdcc9",
      "#a8aedd"
    ]
  },
  "purple": {
    "label": "Purple",
    "swatches": [
      "#6ee9de",
      "#00c9d5",
      "#0094fb"
    ]
  },
  "purple2": {
    "label": "Purple 2",
    "swatches": [
      "#c9e1d7",
      "#83ced2",
      "#979ad6"
    ]
  },
  "neon": {
    "label": "Neon",
    "swatches": [
      "#ff4fd8",
      "#a855f7",
      "#9b8cff"
    ]
  }
};
const THEME_KEY = "trainer.theme";

function currentTheme() {
  return document.documentElement.dataset.theme || "illuminate";
}

function ThemePicker() {
  const [theme, setTheme] = useState(currentTheme());
  function pick(key) {
    if (key === "illuminate") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = key;
    try {
      localStorage.setItem(THEME_KEY, key);
    } catch (e) {
      /* private mode — the theme still applies for this session */
    }
    setTheme(key);
  }
  return html`
    <div class="panel open">
      <div class="panel__summary">
        <${I} name="Palette" size=${18} weight="duotone" />Colour theme
      </div>
      <div class="panel__body">
        <p>Applies everywhere — accents, charts, zone scales and the HDR glow.</p>
        <div class="themegrid">
          ${Object.entries(THEMES).map(
            ([key, t]) => html`
              <button
                key=${key}
                type="button"
                class=${`themecard ${theme === key ? "is-active" : ""}`}
                data-theme-preview=${key}
                onClick=${() => pick(key)}
                aria-pressed=${theme === key}
              >
                <span class="themecard__swatches">
                  ${t.swatches.map(
                    (c, i) =>
                      html`<i key=${i} style=${{ background: c }}></i>`,
                  )}
                </span>
                <span class="themecard__name">${t.label}</span>
                ${theme === key
                  ? html`<${I} name="Check" size=${14} weight="bold" />`
                  : null}
              </button>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

function HdrGlow({ className }) {
  return html`<video
    class=${className}
    src=${`/glow/${themeKey()}.webm`}
    autoPlay
    muted
    loop
    playsInline
    aria-hidden="true"
  />`;
}


function I({ name, ...rest }) {
  const C = Ph[name] || Ph.CircleDashed;
  return html`<${C} ...${rest} />`;
}

// Icon-only copy-to-clipboard button with transient check feedback. The tooltip
// (title) names what gets copied since there's no visible label.
function CopyBtn({ text, title = "Copy", disabled }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {}
  }
  return html`
    <button
      class=${`iconbtn iconbtn--icon ${done ? "is-done" : ""}`}
      onClick=${copy}
      disabled=${disabled}
      title=${disabled ? "Generate a token first" : title}
      aria-label=${title}
    >
      <${I} name=${done ? "Check" : "Copy"} size=${15} weight="bold" />
    </button>
  `;
}

function ConfigRow({ k, copy, copyTitle, copyDisabled, children }) {
  return html`
    <div class="config__row">
      <span class="config__k">${k}</span>
      <code class="config__v">${children}</code>
      ${copy !== undefined
        ? html`<${CopyBtn}
            text=${copy}
            title=${copyTitle}
            disabled=${copyDisabled}
          />`
        : html`<span></span>`}
    </div>
  `;
}

// Settings panel: the exact Health Auto Export (iOS) REST-automation config.
// The token is hash-only on the server, so the live header (with the real token)
// is shown — copyable — only in the moment right after generate/rotate.
function Webhook() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(null); // plaintext, available only this session after rotate
  const [busy, setBusy] = useState(false);
  const configured = BOOT.hasToken || !!token;

  async function rotate() {
    const msg = configured
      ? "Generate a new token? The current token stops working immediately."
      : "Generate an ingest token for Health Auto Export?";
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/token/rotate", { method: "POST" });
      const data = await res.json();
      setToken(data.token);
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class=${`panel ${open ? "open" : ""}`}>
      <div class="panel__summary" onClick=${() => setOpen((o) => !o)}>
        <${I} name="DeviceMobile" size=${18} weight="duotone" />
        Health Auto Export setup
        <${I} className="chev" name="CaretRight" size=${15} weight="bold" />
      </div>
      ${open
        ? html`<div class="panel__body">
            <p>In the iOS <strong>Health Auto Export</strong> app, add a <strong>REST API</strong> automation with exactly these settings:</p>
            <div class="config">
              <${ConfigRow} k="URL" copy=${BOOT.ingestUrl} copyTitle="Copy URL">${BOOT.ingestUrl}</${ConfigRow}>
              <${ConfigRow} k="Method"><span class="pill">POST</span></${ConfigRow}>
              <${ConfigRow} k="Format"><span class="pill">JSON v2</span><span class="faint"> · per-second aggregation</span></${ConfigRow}>
              <div class="config__row">
                <span class="config__k">Header</span>
                <code class="config__v"><span class="tok-key">Authorization</span>: Bearer ${
                  token
                    ? html`<span class="tok">${token}</span>`
                    : html`<span class="tok tok--masked"
                        >${configured
                          ? "•••••••• (hidden — rotate to reveal)"
                          : "— generate a token —"}</span
                      >`
                }</code>
                <div class="copygroup">
                  <${CopyBtn} text="Authorization" title="Copy header name (Authorization)" />
                  <${CopyBtn} text=${token ? `Bearer ${token}` : ""} title="Copy header value (Bearer …)" disabled=${!token} />
                </div>
              </div>
            </div>

            ${
              token
                ? html`<div class="callout">
                    <${I} name="WarningCircle" size=${16} weight="fill" /><span
                      >Copy the header now — for security the token is shown
                      <strong>only once</strong> and can't be retrieved
                      later.</span
                    >
                  </div>`
                : configured
                  ? html`<p class="faint">
                      A token is already configured on this account. Generate a
                      new one only if you need to re-enter it — rotating
                      invalidates the old token.
                    </p>`
                  : html`<p class="faint">
                      No token yet — generate one to fill in the header above.
                    </p>`
            }

            <div class="setup-actions">
              <button class="btn btn--accent" onClick=${rotate} disabled=${busy}>
                <${I} name="ArrowsClockwise" size=${16} weight="bold" />${busy ? "Generating…" : configured ? "Rotate token" : "Generate token"}
              </button>
            </div>

            <div class="links">
              <a href="/api/last"><${I} name="FileText" size=${14} weight="bold" />Last raw payload</a>
              <a href="/api/workouts?limit=100"><${I} name="BracketsCurly" size=${14} weight="bold" />Workouts JSON</a>
            </div>
          </div>`
        : null}
    </div>
  `;
}

// Settings panel: how to connect a Claude client to the training MCP server.
// Unlike the ingest webhook, there's no per-user token to generate here — the
// MCP server sits behind Cloudflare Access OAuth, so the only "credential" is
// signing in through Access when a client first connects.
function McpSetup() {
  const MCP_URL = BOOT.mcpUrl;
  const [open, setOpen] = useState(false);
  return html`
    <div class=${`panel ${open ? "open" : ""}`}>
      <div class="panel__summary" onClick=${() => setOpen((o) => !o)}>
        <${I} name="Robot" size=${18} weight="duotone" />
        MCP server setup
        <${I} className="chev" name="CaretRight" size=${15} weight="bold" />
      </div>
      ${open
        ? html`<div class="panel__body">
            <p>Add this as a remote MCP connector in <strong>Claude</strong> (claude.ai, Claude Desktop, or Claude Code) to query workouts, personal bests, and training focus directly from chat.</p>
            <div class="config">
              <${ConfigRow} k="URL" copy=${MCP_URL} copyTitle="Copy URL"
                >${MCP_URL}</${ConfigRow}
              >
              <${ConfigRow} k="Transport"
                ><span class="pill">Streamable HTTP</span></${ConfigRow}
              >
              <${ConfigRow} k="Auth"
                ><span class="pill">Cloudflare Access</span
                ><span class="faint"> · OAuth, no token to copy</span></${ConfigRow}
              >
            </div>
            <p class="faint">
              No token to generate — connecting triggers a Cloudflare Access
              sign-in the first time, then it's remembered for that client.
            </p>
          </div>`
        : null}
    </div>
  `;
}

// Athlete profile: freeform markdown Claude reads at the start of an
// analysis (age, VO2max/HR zones, active sports, equipment, anything else
// worth knowing). Athlete-authored here, Claude-read only via MCP — same
// ownership split as workout notes, just scoped to the athlete instead of a
// single workout. Plain textarea (not the notes page's rich-text editor):
// this is edited rarely and the content is closer to a CLAUDE.md-style prose
// block than per-workout notes.
function Profile() {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState(BOOT.profileMd || "");
  const [saved, setSaved] = useState(BOOT.profileMd || "");
  const [busy, setBusy] = useState(false);
  const dirty = value !== saved;

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_md: value }),
      });
      if (res.ok) setSaved(value);
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class=${`panel ${open ? "open" : ""}`}>
      <div class="panel__summary" onClick=${() => setOpen((o) => !o)}>
        <${I} name="UserCircle" size=${18} weight="duotone" />
        Athlete profile
        <${I} className="chev" name="CaretRight" size=${15} weight="bold" />
      </div>
      ${open
        ? html`<div class="panel__body">
            <p>Freeform notes about you — age, VO2max, HR zones, active sports, equipment, anything else worth knowing. Claude reads this via MCP at the start of an analysis; it's never written by Claude.</p>
            <textarea
              class="profile-editor"
              rows=${14}
              placeholder=${"e.g.\n- 44-year-old male, based in Singapore\n- VO2max: 51.2 (Apple Watch estimate)\n- Est. max HR: ~175 bpm\n- HR zones: Z1 <130, Z2 131-141, Z3 142-153, Z4 154-164, Z5 165+\n- Active sports: swimming, road cycling, tennis\n- Equipment: pull buoy, road bike w/ power meter"}
              value=${value}
              onInput=${(e) => setValue(e.target.value)}
            ></textarea>
            <div class="setup-actions">
              <button class="btn btn--accent" onClick=${save} disabled=${busy || !dirty}>
                ${dirty && !busy ? html`<${HdrGlow} className="btn-hdr" />` : null}
                <${I} name="FloppyDisk" size=${16} weight="bold" />${busy ? "Saving…" : "Save"}
              </button>
              ${!dirty && saved ? html`<span class="faint">Saved</span>` : null}
            </div>
          </div>`
        : null}
    </div>
  `;
}

function App() {
  return html`
    <div class="wrap">
      <a class="back" href="/"><${I} name="ArrowLeft" size=${16} weight="bold" />Home</a>
      <div class="hero">
        <div class="hero__icon"><${I} name="GearSix" size=${26} weight="duotone" /></div>
        <div class="hero__title">Settings</div>
      </div>

      <div class="section-label">You</div>
      <${Profile} />

      <div class="section-label">Appearance</div>
      <${ThemePicker} />

      <div class="section-label">Data sources</div>
      <${Webhook} />

      <div class="section-label">Clients</div>
      <${McpSetup} />
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`
  <${Ph.IconContext.Provider} value=${{ weight: "regular" }}><${App} /></${Ph.IconContext.Provider}>
`);
