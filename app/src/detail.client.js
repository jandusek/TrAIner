// Workout detail — summary, laps with equipment tagging, rich-text notes.
// React (no build) via htm + esm.sh; Phosphor icons; Tiptap for the editor.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { html } from "htm/react";
import * as Ph from "@phosphor-icons/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/* Read a theme token. Must sit above every module-level consumer: the
   Highcharts theme literal below is evaluated at module scope, so declaring
   this further down left it in the temporal dead zone. */
const cssVar = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// MapLibre GL is loaded as UMD via a <script> in the page shell (see index.ts);
// grab it off the global rather than importing (its worker breaks under esm.sh).
const maplibregl = window.maplibregl;
// Same pattern for Highcharts — the interactive power/cadence/stroke-drift
// charts, so hovering shows exact values instead of reading an SVG by eye.
const Highcharts = window.Highcharts;

/* A colour, dimmed. Highcharts' own colour class does the mixing because it
   understands every notation a theme token can arrive in — including the
   color(display-p3 …) form the accent family takes on wide-gamut browsers,
   which it hands to CSS color-mix() rather than dropping. (MapLibre has no
   such fallback, hence the separate srgb() round-trip further down.) */
const fade = (color, alpha) => Highcharts.color(color).setOpacity(alpha).get();

// One-time dark theme, read from the page's own palette. Highcharts can't
// resolve CSS custom properties itself, so each value is pulled through
// cssVar at module scope — after the shell's inline script has set
// data-theme, so what lands here is the athlete's chosen theme, not a copy
// of one theme's hexes.
Highcharts.setOptions({
  chart: {
    backgroundColor: "transparent",
    style: { fontFamily: "inherit" },
    // Default spacing ([10,10,15,10]) leaves a big empty margin now that the
    // axis titles are gone — pull it in on every side. Top keeps a bit more
    // room than the rest (10px) so the topmost y-axis tick label doesn't get
    // clipped against the card edge; bottom/left go to 0 since the axis
    // labels' own reserved space already covers them.
    spacing: [10, 4, 0, 0],
  },
  title: { text: undefined },
  credits: { enabled: false },
  // Series fallback for any chart that doesn't name its own colour: the
  // theme's accent, its heart-rate/effort hue, then the second accent.
  colors: [cssVar("--accent"), cssVar("--hot"), cssVar("--accent-2")],
  xAxis: {
    lineColor: cssVar("--line-2"),
    tickColor: cssVar("--line-2"),
    tickLength: 2,
    // 11.5px meets the zonebar labels (0.77rem ≈ 11.5px) in the middle of
    // Highcharts' own default (12.8px) — the two chart types sit side by
    // side in a split-row, so their type scale should match.
    labels: { style: { color: cssVar("--muted"), fontSize: "11.5px" }, y: 14 },
    // Visible on every chart, not just synced ones — a vertical marker at
    // the hovered instant reads naturally even solo, and is exactly what
    // cross-chart sync (see useChart's `sync` option) drives on the other
    // charts in a group.
    crosshair: { color: fade(cssVar("--text"), 0.25), width: 1, dashStyle: "Dash" },
  },
  yAxis: {
    gridLineColor: cssVar("--line"),
    tickLength: 0,
    labels: { style: { color: cssVar("--muted"), fontSize: "11.5px" }, x: -2 },
    title: { style: { color: cssVar("--muted") } },
  },
  legend: { itemStyle: { color: cssVar("--text") }, itemHoverStyle: { color: cssVar("--accent") } },
  tooltip: {
    backgroundColor: cssVar("--surface"),
    borderColor: cssVar("--line-2"),
    style: { color: cssVar("--text") },
  },
  plotOptions: {
    series: { animation: false, marker: { enabled: false } },
  },
});

/**
 * Cross-chart hover sync — charts registered under the same key highlight
 * the same instant together, the way Apple's Health app lines up a single
 * hovered moment across its stacked Cadence / Vertical Oscillation / Ground
 * Contact Time charts. Two groups exist today: "running" (cadence + heart
 * rate) and "cycling" (power/HR + speed/cadence). Adding another chart to
 * either is just passing the same key to its own useChart call — no other
 * wiring needed. Charts in a group must share an x scale; both groups use
 * elapsed seconds from the session's first sample.
 */
const syncGroups = new Map(); // key -> Set<Highcharts.Chart>

/** Drop the hover state we applied on a previous sync, so highlighted markers
 * don't accumulate as the pointer moves. */
function clearSynced(chart) {
  for (const p of chart.__syncPoints ?? []) p.setState("");
  chart.__syncPoints = null;
}

function broadcastHover(sourceChart, groupKey, nativeEvent) {
  const group = syncGroups.get(groupKey);
  if (!group) return;
  // Sync on the hovered TIME, not on the screen pixel. Stacked charts don't
  // share a plot origin — a wider y-axis label gutter on one (power's "450"
  // against speed's "45") shifts its plot area by a few pixels, which at these
  // durations is most of a minute of drift between what the two charts claim
  // to be showing. Reading the source's data-x once and looking every other
  // chart up by that value keeps them on the same instant by construction.
  const srcEvent = sourceChart.pointer.normalize(nativeEvent);
  const dataX = sourceChart.xAxis[0].toValue(srcEvent.chartX);

  for (const other of group) {
    if (other === sourceChart || !other.series.length) continue;
    clearSynced(other);
    // EVERY series, not just series[0] — the receiving chart has two of them,
    // and searching only the first is why a synced hover used to surface a
    // single value. pointAtX also enforces a proximity window, so a chart
    // with nothing recorded at this instant (speed and cadence during an
    // auto-paused stop) goes quiet rather than snapping its crosshair to the
    // nearest point minutes away and implying the two charts are aligned.
    const points = other.series.map((s) => pointAtX(s, dataX)).filter(Boolean);
    if (!points.length) {
      // hide(0) rather than the default delay: this is "nothing was recorded
      // here", so the previous instant's numbers must not sit on screen while
      // the pointer is already somewhere else.
      other.tooltip.hide(0);
      other.xAxis[0].hideCrosshair();
      continue;
    }
    for (const p of points) p.setState("hover");
    other.__syncPoints = points;
    // An ARRAY, not a single point: `tooltip.shared` only produces a
    // multi-row tooltip when refresh is handed one point per series.
    other.tooltip.refresh(points);
    other.xAxis[0].drawCrosshair(srcEvent, points[0]);
  }
}

function broadcastLeave(sourceChart, groupKey) {
  const group = syncGroups.get(groupKey);
  if (!group) return;
  for (const other of group) {
    if (other === sourceChart) continue;
    clearSynced(other);
    other.tooltip.hide();
    other.xAxis[0].hideCrosshair();
  }
}

/**
 * Mounts/updates/tears down a Highcharts chart in a plain div. `getOptions`
 * is re-invoked whenever `deps` changes; passing null skips creation (e.g. no
 * data yet). Chart.update() would work too, but full recreation is simpler
 * and cheap at these data sizes (a few thousand points, once per data load).
 *
 * `opts.sync` opts this chart into cross-chart hover sync (see above) under
 * the given group key.
 */
function useChart(getOptions, deps, opts = {}) {
  const ref = useRef(null);
  const chart = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    // No chart exists yet for the first call — getOptions falls back to
    // estimating off the container's outer width (see CadenceChart).
    const options = getOptions(ref.current, null);
    if (!options) return;
    const c = Highcharts.chart(ref.current, options);
    chart.current = c;

    const groupKey = opts.sync;
    let group;
    if (groupKey) {
      group = syncGroups.get(groupKey) ?? new Set();
      syncGroups.set(groupKey, group);
      group.add(c);
      // searchPoint (used by broadcastHover on every OTHER chart in the
      // group) relies on a per-series spatial index Highcharts otherwise
      // builds lazily on that series' first-ever hover — so the very first
      // synced hover a chart receives would silently miss. Build it now
      // instead of waiting for that first miss.
      c.series.forEach((s) => s.buildKDTree?.());
      const onMove = (e) => broadcastHover(c, groupKey, e);
      const onLeave = () => broadcastLeave(c, groupKey);
      // Capture phase: Highcharts attaches its own mousemove/mouseleave
      // handlers to this same container when the chart is constructed
      // (above), before we get here, and its tooltip handling can call
      // stopImmediatePropagation — which would silently swallow ours if we
      // registered on the (default) bubble phase.
      c.container.addEventListener("mousemove", onMove, true);
      c.container.addEventListener("touchmove", onMove, true);
      c.container.addEventListener("mouseleave", onLeave, true);
    }

    // Responsive re-bucketing: a chart like CadenceChart sizes its own bar
    // count off the container's width, so as the window resizes that count
    // needs to be recomputed too — Highcharts reflowing the existing bars to
    // fit a new width on its own would just stretch/squash them. Debounced
    // so a continuous window drag doesn't rebuild on every intermediate
    // pixel, and passes the chart's own `plotWidth` (the real plotted area,
    // narrower than the container by the y-axis label gutter) rather than
    // the container's outer width, which the first, chart-less call above
    // could only estimate.
    let resizeTimer;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const next = getOptions(ref.current, c);
        if (next) c.update(next, true, false);
      }, 150);
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      clearTimeout(resizeTimer);
      group?.delete(c);
      c.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

const BOOT = JSON.parse(document.getElementById("bootstrap").textContent);

const SID = BOOT.sourceId;

const EQUIPMENT = [
  { key: "pull_buoy", label: "Buoy", icon: "Lifebuoy" },
  { key: "front_snorkel", label: "Snorkel", icon: "Wind" },
];

function I({ name, ...rest }) {
  const C = Ph[name] || Ph.CircleDashed;
  return html`<${C} ...${rest} />`;
}
const SPORT_ICON = {
  swimming: "PersonSimpleSwim",
  cycling: "PersonSimpleBike",
  tennis: "TennisBall",
  running: "PersonSimpleRun",
  calisthenics: "Barbell",
};
const sportIcon = (s) => SPORT_ICON[s] || "Barbell";

const pad = (n) => String(n).padStart(2, "0");
const WHEN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WHEN_MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Format a workout timestamp at the workout's OWN recorded offset (e.g. a
// Singapore swim reads in +0800 regardless of where it's viewed). Pass null to
// render in UTC.
function fmtWhen(epoch, offset) {
  const offMin = offset
    ? (offset[0] === "-" ? -1 : 1) *
      (parseInt(offset.slice(1, 3)) * 60 + parseInt(offset.slice(3, 5)))
    : 0;
  const d = new Date((epoch + offMin * 60) * 1000);
  return `${WHEN_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${WHEN_MONS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Format an app-generated timestamp (eval / focus write time) in the VIEWER's
// local timezone. These are UTC epochs with no meaningful workout offset — the
// athlete wants to know when they pressed the button in their own clock, which
// client-side rendering gives us for free via the local Date accessors.
function fmtWhenLocal(epoch) {
  const d = new Date(epoch * 1000);
  return `${WHEN_DAYS[d.getDay()]} ${d.getDate()} ${WHEN_MONS[d.getMonth()]} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDur(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = Math.round(s % 60);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtDist(m) {
  if (m == null) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
const round = (v) => (v == null ? null : Math.round(v));

/* ── the sexy checkbox ────────────────────────────────────────────────────── */
function Check({ checked, onChange, title }) {
  return html`
    <label class="chk" title=${title}>
      <input
        type="checkbox"
        checked=${!!checked}
        onChange=${(e) => onChange(e.target.checked)}
      />
      <span class="chk__box"
        ><${I} name="Check" size=${14} weight="bold"
      /></span>
    </label>
  `;
}

function Stat({ k, v, unit, icon, hot, sub, tip }) {
  if (v == null || v === "") return null;
  return html`
    <div
      class=${`stat ${hot ? "stat--hot" : ""} ${tip ? "stat--tip" : ""}`}
      title=${tip || undefined}
    >
      <div class="stat__head">
        <${I} name=${icon} size=${13} weight="bold" /><span class="stat__k"
          >${k}</span
        >${tip
          ? html`<${I}
              name="Info"
              size=${11}
              weight="bold"
              class="stat__hint"
            />`
          : null}
      </div>
      <div class="stat__v">
        ${v}${unit ? html`<small>${unit}</small>` : null}
      </div>
      ${sub ? html`<div class="stat__sub">${sub}</div>` : null}
    </div>
  `;
}

function dash(v) {
  return v == null ? html`<span class="dash">—</span>` : v;
}

/* ── minimal, safe markdown → HTML (escape first, then a small subset) ──────── */
function mdToHtml(src) {
  const esc = (s) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(m[1].length + 2, 6); // # → h3, to stay under the page title
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

// Claude's written assessment of the workout, plus the athlete-facing control
// to (re)generate it. The eval is produced on demand by POST /api/evaluate
// (Workers AI, see src/evaluate.ts) — an explicit action, not a side effect of
// saving notes, so recording a note never triggers inference. When notes have
// been edited more recently than the eval, a passive hint offers a refresh
// without coupling the two saves.
// Friendly author name for the eval byline, from the stored generated_by. The
// in-app button records the Workers AI model id (e.g. "@cf/zai-org/glm-5.2");
// Claude-in-chat via MCP records "claude". NULL is legacy/unknown provenance —
// historically all evals were Claude-authored, so that's the safe default.
function evalAuthorLabel(generatedBy) {
  if (!generatedBy || generatedBy === "claude") return "Claude";
  const s = generatedBy.toLowerCase();
  if (s.includes("glm-5.2")) return "GLM 5.2";
  if (s.includes("glm")) return "GLM";
  return generatedBy.split("/").pop(); // fallback: last path segment of the id
}


/* HDR glow — see home.client.js for the reasoning. Only CTAs that are already
   the accent gradient get one: they are the single primary action on the page,
   so this stays one video each rather than one per row. */
const themeKey = () => document.documentElement.dataset.theme || "illuminate";
/* Peak luminance is user-set; "off" is handled in CSS so the element stays
   mounted and toggling costs nothing. */
const hdrNits = () => {
  const v = document.documentElement.dataset.hdr;
  return v && v !== "off" ? v : "500";
};
/* One asset per nit level, shared by every theme — the colour comes from
   .glow-tint in CSS, not from the video. */
const glowSrc = (nits) => {
  const k = `white@${nits || hdrNits()}`;
  return `/glow/${encodeURIComponent(k)}.webm?v=${(window.__GLOW_VER || {})[k] || ""}`;
};

function HdrGlow({ className, nits }) {
  return html`<span class=${`hdrglow ${className}`}>
    <video
      class="hdrglow-vid"
      src=${glowSrc(nits)}
      autoPlay
      muted
      loop
      playsInline
      aria-hidden="true"
    />
    <span class="hdrglow-tint"></span>
  </span>`;
}

function Evaluation({ ev, onGenerate, generating, error, stale }) {
  const btnLabel = generating
    ? "Generating…"
    : ev
      ? "Regenerate"
      : "Generate evaluation";
  const btn = html`
    <button
      class=${`btn btn--sm ${ev ? "btn--ghost" : "btn--accent"}`}
      disabled=${generating}
      onClick=${onGenerate}
    >
      ${!ev && !generating ? html`<${HdrGlow} className="btn-hdr" />` : null}
      <${I} name="Sparkle" size=${13} weight="fill" />${btnLabel}
    </button>
  `;

  return html`
    <div
      class="section-label"
      style=${{ marginTop: "2.4rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}
    >
      <span>Evaluation</span>
      ${btn}
    </div>
    ${stale && ev && !generating
      ? html`<p class="hint">
          <${I} name="Info" size=${14} weight="bold" />Notes changed since this
          evaluation — regenerate to fold them in.
        </p>`
      : null}
    ${error && !generating
      ? html`<p class="hint hint--err">
          <${I} name="Warning" size=${14} weight="bold" />${error}
        </p>`
      : null}
    ${generating
      ? html`<div class="skeleton" style=${{ height: "6rem", marginTop: "0.8rem" }} />`
      : ev
        ? html`<div class="prose">
            <div
              dangerouslySetInnerHTML=${{ __html: mdToHtml(ev.content_md) }}
            ></div>
            <div class="eval__foot">
              <${I} name="Sparkle" size=${12} weight="fill" />${evalAuthorLabel(
                ev.generated_by,
              )}${" "}·${" "}${fmtWhenLocal(ev.updated_at)}
            </div>
          </div>`
        : html`<p class="muted" style=${{ marginTop: "0.6rem" }}>
            No evaluation yet — generate one to compare this session against your
            comparable past workouts.
          </p>`}
  `;
}

function Focus({ focus }) {
  if (!focus || !focus.items?.length) return null;
  return html`
    <div class="focus rise">
      <div class="focus__head">
        <${I} name="Target" size=${15} weight="bold" />Next-session focus
      </div>
      <ul class="focus__list">
        ${focus.items.map((it, i) => html`<li key=${i}>${it}</li>`)}
      </ul>
      <div class="focus__foot">
        Set ${fmtWhenLocal(focus.created_at)}${focus.set_by_source_id
          ? " · from this session"
          : ""}
      </div>
    </div>
  `;
}

/* ── route map (cycling / running) ────────────────────────────────────────── */
// Sports that record a GPS track. Swims and tennis never do, so we skip the
// fetch entirely for them (matches the ROUTE_SPORTS gate on the server).
const ROUTE_SPORTS = new Set(["cycling", "running"]);

/* Theme token → a colour MapLibre can actually parse.

   The style spec's parser only understands sRGB notations (hex, rgb(), hsl(),
   named colours). Our accent family is redeclared as color(display-p3 …) on
   wide-gamut browsers (see ui.css's @supports blocks), which it rejects — and
   a rejected paint value fails the whole style, not just that layer. So paint
   the token onto a 1×1 sRGB canvas and read the pixel back: the browser clips
   to sRGB and we hand MapLibre a plain rgba(). The clip is the honest answer
   anyway — MapLibre draws into an untagged (sRGB) WebGL canvas, so it could
   not show the wider primaries whatever we passed it. Alpha survives the
   round-trip (getImageData is unpremultiplied), so a token that carries
   transparency keeps it. */
function srgb(value) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
const mapColor = (name) => srgb(cssVar(name));

// Custom MapLibre vector style, keyed to the app palette so the basemap is part
// of the design system rather than a stock theme. Vector tiles from OpenFreeMap
// (keyless, OSM data, OpenMapTiles schema). Deliberately minimal — land, water,
// and faint roads only; no labels, POIs, buildings or boundaries — so the route
// stays the hero.
//   water = --surface  → matches the power-zones card background (by request)
//   land  = --surface-2 → a hair lighter, so landmass reads against the water
//   roads = --hot at a low opacity → keeps the basemap theme-aware without
//           echoing the route. It was briefly a faint --accent, which put the
//           road web and the route on one hue and left the accent marking
//           nothing in particular; --hot is a family over, so the two read
//           apart at any theme.
//
// Built as a function, not a module-level literal: every colour is read from
// the live theme tokens, and a literal would freeze whichever theme happened to
// be active when this module first evaluated.
function mapStyle() {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      ofm: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
    },
    layers: [
      {
        id: "land",
        type: "background",
        paint: { "background-color": mapColor("--surface-2") },
      },
      {
        id: "water",
        type: "fill",
        source: "ofm",
        "source-layer": "water",
        paint: { "fill-color": mapColor("--surface") },
      },
      {
        id: "roads",
        type: "line",
        source: "ofm",
        "source-layer": "transportation",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": mapColor("--hot"),
          "line-opacity": 0.18,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            0.4,
            14,
            1.2,
            18,
            3,
          ],
        },
      },
    ],
  };
}

function RouteMap({ sport }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  // 'loading' → 'ok' (has a track) | 'none' (indoor / no GPS / failed).
  const [state, setState] = useState({ status: "loading" });

  // Phase 1: fetch the track. Kept separate from init so the visible map
  // container is mounted before MapLibre touches it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/route?source_id=${encodeURIComponent(SID)}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (cancelled) return;
        if (!data.points || data.points.length < 2) {
          setState({ status: "none" });
          return;
        }
        setState({
          status: "ok",
          points: data.points,
          bounds: data.bounds,
          total: data.total,
        });
      } catch {
        if (!cancelled) setState({ status: "none" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase 2: once we have a track and the container is on screen, build the map.
  useEffect(() => {
    if (state.status !== "ok" || !elRef.current || mapRef.current) return;
    // MapLibre wants [lon, lat]; our API returns [lat, lon, elev].
    const coords = state.points.map((p) => [p[1], p[0]]);
    const bounds = [
      [state.bounds.min[1], state.bounds.min[0]], // SW [lon, lat]
      [state.bounds.max[1], state.bounds.max[0]], // NE [lon, lat]
    ];
    const map = new maplibregl.Map({
      container: elRef.current,
      style: mapStyle(),
      attributionControl: false,
      // Fit the whole track on load — no manual view math; MapLibre tracks the
      // container size itself (ResizeObserver), so no invalidateSize dance.
      bounds,
      fitBoundsOptions: { padding: 24, animate: false },
      dragRotate: false,
      pitchWithRotate: false,
      // Don't hijack page scroll; drag-pan and the zoom buttons still work.
      scrollZoom: false,
    });
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-left",
    );

    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
        },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          // The accent. The route is the one thing this card exists to show,
          // so it takes the theme's primary rather than the quieter --hot the
          // trace used to carry — the faint accent wash on the roads reads as
          // the same light, turned down.
          "line-color": mapColor("--accent"),
          "line-width": 4,
          "line-opacity": 0.95,
        },
      });
      map.addSource("ends", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { role: "start" },
              geometry: { type: "Point", coordinates: coords[0] },
            },
            {
              type: "Feature",
              properties: { role: "finish" },
              geometry: {
                type: "Point",
                coordinates: coords[coords.length - 1],
              },
            },
          ],
        },
      });
      map.addLayer({
        id: "ends",
        type: "circle",
        source: "ends",
        paint: {
          "circle-radius": 6,
          // Both ends must stay separable from the route and from each other,
          // so neither can reuse the line's colour — which is now --accent,
          // so start moves to --hot. That leaves the three marks on the three
          // hues every theme is required to own.
          "circle-color": [
            "match",
            ["get", "role"],
            "finish",
            mapColor("--accent-2"),
            mapColor("--hot"),
          ],
          "circle-stroke-width": 2,
          // Page ground, so the ring reads as a cut-out at any theme.
          "circle-stroke-color": mapColor("--bg"),
        },
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [state.status]);

  if (state.status === "none") return null;

  return html`
    <div class="section-label">
      Route${state.status === "ok"
        ? html`<span class="count">${fmtDist(routeMeters(state))}</span>`
        : null}
    </div>
    ${state.status === "loading"
      ? html`<div class="skeleton map-skeleton"></div>`
      : html`<div class="map-wrap rise">
          <div class="map map--dark" ref=${elRef}></div>
        </div>`}
  `;
}

// Rough track length from the (already-thinned) display points — enough for a
// "12.4 km" caption, not a precise odometer. Haversine over consecutive points.
function routeMeters(state) {
  const pts = state.points || [];
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversine(pts[i - 1], pts[i]);
  return m || null;
}
function haversine(a, b) {
  const R = 6371000,
    toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]),
    dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ── cycling power: zone bars, power+HR chart, aerobic decoupling ──────────── */
// Athlete's HR zones (see CLAUDE.md — Apple Watch defaults, refined over time).
// Zone colours live in the theme (see ui.css --z1..--z5, --pz1..--pz7) so the
// scales re-derive per theme instead of being pinned to one palette.
const HR_ZONES = [
  { label: "Z1 Recovery", low: 0, high: 130, color: cssVar("--z1") },
  { label: "Z2 Aerobic", low: 130, high: 141, color: cssVar("--z2") },
  { label: "Z3 Tempo", low: 141, high: 153, color: cssVar("--z3") },
  { label: "Z4 Threshold", low: 153, high: 164, color: cssVar("--z4") },
  { label: "Z5 VO2max", low: 164, high: 200, color: cssVar("--z5") },
];
// Cool → bright gradient across a Coggan-style 7-zone power split (Active
// Recovery through Neuromuscular). Independent of HR_ZONES — power and HR
// zones don't share a boundary scheme, so no attempt is made to align them.
const POWER_ZONE_COLORS = [1,2,3,4,5,6,7].map((i) => cssVar(`--pz${i}`));

function PowerZones({ zonesJson }) {
  let zones;
  try {
    zones = JSON.parse(zonesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(zones) || !zones.length) return null;
  const total = zones.reduce((a, z) => a + (z.secs || 0), 0);
  if (!total) return null;
  return html`
    <div class="section-label">Power zones</div>
    <div class="zonecard rise">
      <div class="zonebars">
        ${zones.map(
          (z) =>
            html` <div class="zonebar" key=${z.zone}>
              <span class="zonebar__label"
                >Z${z.zone}${" "}${z.low ?? 0}–${z.high != null && z.high < 2000
                  ? z.high
                  : "∞"}W</span
              >
              <span class="zonebar__track">
                <span
                  class="zonebar__fill"
                  style=${{
                    width: `${(100 * (z.secs || 0)) / total}%`,
                    background:
                      POWER_ZONE_COLORS[
                        (z.zone - 1) % POWER_ZONE_COLORS.length
                      ],
                  }}
                ></span>
              </span>
              <span class="zonebar__time">${fmtDur(z.secs)}</span>
            </div>`,
        )}
      </div>
    </div>
  `;
}

// Buckets HR samples into HR_ZONES, weighting each sample by the gap to the
// next one (capped so a real sensor dropout doesn't inflate a zone). There's
// no device-reported HR zone config to pair against (unlike power, which
// comes straight off the FIT file's zone messages) — HR only ever arrives as
// a raw stream from the Apple Watch echo, so the buckets are computed here
// against the athlete's configured HR_ZONES.
//
// The cap can't be a fixed 5s: swim/cycling samples land every ~1s (a >5s
// gap there really is a dropout), but running/tennis only get HR every
// ~5-9s natively (see /api/running-hr-samples's and /api/tennis-hr-samples's
// comments) — a hardcoded 5s cap was silently truncating most of those
// normal gaps, undercounting a run's total zone time by minutes. Deriving
// the cap from the series' own median gap makes it self-adjust to whatever
// sampling rate the sport actually provides.
function computeHeartZoneSecs(samples) {
  const withHr = samples.filter((s) => s.hr != null);
  const secs = HR_ZONES.map(() => 0);
  if (!withHr.length) return secs;
  const gaps = [];
  for (let i = 0; i < withHr.length - 1; i++) gaps.push(withHr[i + 1].t - withHr[i].t);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1;
  const cap = Math.max(5, median * 3);
  for (let i = 0; i < withHr.length; i++) {
    const cur = withHr[i];
    const next = withHr[i + 1];
    const dt = next ? Math.min(next.t - cur.t, cap) : median;
    const idx = HR_ZONES.findIndex((z) => cur.hr >= z.low && cur.hr < z.high);
    if (idx >= 0) secs[idx] += dt;
  }
  return secs;
}

function HeartZones({ samples }) {
  const secsByZone = computeHeartZoneSecs(samples);
  const total = secsByZone.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return html`
    <div class="section-label">Heart rate zones</div>
    <div class="zonecard rise">
      <div class="zonebars">
        ${HR_ZONES.map(
          (z, i) => html`
            <div class="zonebar" key=${z.label} title=${z.label}>
              <span class="zonebar__label"
                >Z${i + 1} ${z.low}–${z.high < 200 ? z.high : "∞"}bpm</span
              >

              <span class="zonebar__track">
                <span
                  class="zonebar__fill"
                  style=${{
                    width: `${(100 * secsByZone[i]) / total}%`,
                    background: z.color,
                  }}
                ></span>
              </span>
              <span class="zonebar__time">${fmtDur(secsByZone[i])}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

/* ── swim: stroke-count-per-50m drift chart (the fatigue signature — see
 * CLAUDE.md's analysis playbook, "the most informative single chart") ──── */

// Shared by the chart and its drift badge, computed once per render (see
// App's `strokeDrift`) so the two — placed in different parts of the page,
// same as PowerZones/HeartZones vs Decoupling for cycling — agree.
// Above this distance-per-stroke a full length is physically implausible for
// freestyle (efficient masters swimmers sit ~1.5–2.6 m/stroke; Apple counts
// single-arm strokes). A higher value means the Watch under-detected strokes on
// a glide-heavy length (or recorded zero) — treat as MISSING, not a real
// low-stroke lap (see CLAUDE.md known instrumentation issues). Mirrors the MCP
// server's strokeDriftSeries so the chart and the analysis tools agree.
const MAX_M_PER_STROKE = 3.0;

function isFullLength(l, poolLengthM) {
  return !poolLengthM || l.distance_m == null || l.distance_m >= poolLengthM * 0.9;
}

function strokesReliable(l, poolLengthM) {
  if (l.strokes == null || l.strokes <= 0) return false;
  const dist = l.distance_m ?? poolLengthM;
  return !(dist && dist / l.strokes > MAX_M_PER_STROKE);
}

function computeStrokeDrift(laps, poolLengthM) {
  // Full-length laps with a trustworthy stroke count only. Lap 1 is the known
  // short-start artifact; under-detected lengths (implausibly few strokes for
  // the distance) are dropped rather than plotted as real dips — otherwise a
  // phantom low lap looks like a huge efficiency swing (see CLAUDE.md).
  const pts = laps.filter(
    (l) => l.lap_num !== 1 && isFullLength(l, poolLengthM) && strokesReliable(l, poolLengthM),
  );
  if (pts.length < 3) return null;

  // Drift = avg of the first two vs last two laps, not endpoint-to-endpoint —
  // a single noisy lap at either end shouldn't swing the headline number.
  const strokes = pts.map((l) => l.strokes);
  const edge = Math.min(2, Math.floor(pts.length / 2));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const startAvg = avg(strokes.slice(0, edge));
  const endAvg = avg(strokes.slice(-edge));
  const driftPct = startAvg ? ((endAvg - startAvg) / startAvg) * 100 : 0;
  // Only a RISING stroke count is the fatigue signature (distance-per-stroke
  // falling as form breaks down). A flat or falling count means form held or
  // efficiency improved through the session — that's good, so don't flag it
  // the way the old Math.abs() did.
  const kind = driftPct <= 10 ? "good" : driftPct <= 20 ? "warn" : "bad";

  return { pts, strokes, driftPct, kind };
}

function StrokeDriftChart({ drift }) {
  const ref = useChart(
    () =>
      drift && {
        chart: { type: "line" },
        xAxis: {
          title: { text: undefined },
          categories: drift.pts.map((l) => String(l.lap_num)),
        },
        yAxis: { title: { text: undefined }, allowDecimals: false },
        legend: { enabled: false },
        tooltip: { valueSuffix: " strokes", headerFormat: "<b>Lap {point.key}</b><br/>" },
        series: [
          {
            name: "Strokes / lap",
            data: drift.strokes,
            color: cssVar("--accent"),
            marker: { enabled: true, radius: 3 },
          },
        ],
      },
    [drift],
  );
  if (!drift) return null;
  return html`
    <div class="section-label">Stroke count per 50m</div>
    <div class="pwchart-wrap pwchart-wrap--tile rise">
      <div class="pwchart-plot" ref=${ref}></div>
    </div>
  `;
}

function StrokeDriftBadge({ drift }) {
  if (!drift) return null;
  const { driftPct, kind } = drift;
  return html`
    <div class=${`decoupling decoupling--${kind} rise`}>
      <span class="decoupling__v"
        >${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(0)}%</span
      >
      <span class="decoupling__label">
        Stroke count drift (start vs finish) —
        ${kind === "good"
          ? driftPct < -5
            ? "stroke count fell — form held, efficiency improved."
            : "held steady, form intact."
          : kind === "warn"
            ? "some drift — early fatigue signature."
            : "significant drift — breaking down by the end."}
      </span>
    </div>
  `;
}

// How close an HR reading must sit to a recorded power second to count as
// "taken while riding". The Watch samples HR at ~5s and never pauses, so a
// plain nearest-neighbour test needs a tolerance wider than that spacing but
// far narrower than any real stop.
const RIDING_HR_TOLERANCE_SEC = 30;

// A pause longer than this makes "first half vs second half" a comparison
// between two separate efforts rather than the drift within one, so the
// figure gets an explicit caveat instead of being read at face value.
const DECOUPLING_SPLIT_GAP_SEC = 600;

/**
 * Aerobic decoupling — how much the power:HR ratio degraded from the first
 * half of the ride to the second. Rising HR for the same watts is the classic
 * aerobic-fade signature.
 *
 * Two things make this harder than averaging two halves, both consequences of
 * the ride's two clocks (see migrations/0023_moving_time.sql):
 *
 *  1. **The head unit auto-pauses; the Watch does not.** A ride with a long
 *     stop has power recorded only while moving but HR recorded continuously,
 *     including a stretch of resting HR. Averaging that resting HR into a
 *     half deflates its denominator and inflates its ratio — which is what
 *     produced a -98.7% reading (and a cheerful "held steady") on a commute
 *     with a 70-minute break in the middle. HR is therefore restricted to
 *     readings that sit near an actually-recorded power second.
 *  2. **The elapsed midpoint is not the halfway point of the riding.** On the
 *     same ride the elapsed midpoint lands inside the break. Split at the
 *     median recorded power sample instead, so each half holds an equal
 *     amount of real riding.
 */
function Decoupling({ samples }) {
  const withPower = samples.filter((s) => s.power_w != null);
  if (withPower.length < 20) return null;

  // Two sorted sequences walked once: keep an HR reading only if some power
  // second sits within the tolerance of it.
  const powerTimes = withPower.map((s) => s.t);
  const ridingHr = [];
  let pi = 0;
  for (const s of samples) {
    if (s.hr == null) continue;
    while (pi < powerTimes.length - 1 && Math.abs(powerTimes[pi + 1] - s.t) <= Math.abs(powerTimes[pi] - s.t)) pi++;
    if (Math.abs(powerTimes[pi] - s.t) <= RIDING_HR_TOLERANCE_SEC) ridingHr.push(s);
  }
  if (ridingHr.length < 6) return null;

  const midT = powerTimes[Math.floor(powerTimes.length / 2)];
  const avg = (arr, key) => arr.reduce((a, s) => a + s[key], 0) / arr.length;
  const p1 = withPower.filter((s) => s.t < midT),
    p2 = withPower.filter((s) => s.t >= midT);
  const h1 = ridingHr.filter((s) => s.t < midT),
    h2 = ridingHr.filter((s) => s.t >= midT);
  if (!p1.length || !p2.length || !h1.length || !h2.length) return null;

  const r1 = avg(p1, "power_w") / avg(h1, "hr");
  const r2 = avg(p2, "power_w") / avg(h2, "hr");
  if (!(r1 > 0)) return null;
  const pct = ((r1 - r2) / r1) * 100;

  // Classify on MAGNITUDE. The old `pct < 5` test had no lower bound, so an
  // extreme negative — the second half producing far more power per heartbeat
  // than the first — passed as the healthiest possible result.
  const mag = Math.abs(pct);
  const kind = mag < 5 ? "good" : mag < 8 ? "warn" : "bad";
  const verdict =
    mag < 5
      ? "held steady, aerobically sound."
      : pct > 0
        ? mag < 8
          ? "some fade in the back half."
          : "notable fade — likely working above aerobic base."
        : "the back half produced more power per heartbeat than the first — a hard finish, or two efforts too different to compare.";

  // Longest hole in the recording. Its presence changes what the number means,
  // so say so rather than letting a split ride read as one continuous effort.
  let longestGap = 0;
  for (let i = 1; i < powerTimes.length; i++) longestGap = Math.max(longestGap, powerTimes[i] - powerTimes[i - 1]);
  const split = longestGap >= DECOUPLING_SPLIT_GAP_SEC;

  return html`
    <div class=${`decoupling decoupling--${kind} rise`}>
      <span class="decoupling__v"
        >${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span
      >
      <span class="decoupling__label">
        Aerobic decoupling (Power:HR, 1st half vs 2nd half) — ${verdict}
        ${split
          ? html`<br /><span style=${{ opacity: 0.7 }}
              >Split by a ${fmtDur(longestGap)} stop, so the halves are really two separate
              efforts — read this as a comparison between them, not drift within one ride.</span
            >`
          : null}
      </span>
    </div>
  `;
}

// How far from the hovered instant a series' point may sit and still be shown
// as that instant's value. Wide enough for HR's ~5s Watch cadence, narrow
// enough that a series with nothing there (power during an auto-paused stop,
// speed through a GPS dropout) drops out of the tooltip instead of reporting a
// stale reading from minutes away.
const TOOLTIP_SNAP_SEC = 15;

/** Nearest point of `series` to data-x with a real value, or null if the
 * closest one is further away than TOOLTIP_SNAP_SEC. Binary search — `points`
 * is x-sorted, and these series run to thousands of samples. */
function pointAtX(series, x) {
  const pts = series.points;
  if (!pts || !pts.length) return null;
  let lo = 0,
    hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  let best = null;
  for (const p of [pts[lo - 1], pts[lo], pts[lo + 1]]) {
    if (!p || p.y == null) continue;
    if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  }
  return best && Math.abs(best.x - x) <= TOOLTIP_SNAP_SEC ? best : null;
}

/**
 * Tooltip contents for the ride charts, derived by looking every series up at
 * the hovered x rather than rendering whatever point set the tooltip was
 * refreshed with.
 *
 * Both charts declare `shared: true`, but that alone does not get every series
 * into the tooltip. Two separate paths were each dropping rows:
 *   * Highcharts' own pointer gathering hands the tooltip a single series here
 *     even when both have a point at that x (verified in the browser: each
 *     series' own `searchPoint` finds one, yet `chart.hoverPoints` holds just
 *     the one) — so the chart under the cursor showed one value.
 *   * `broadcastHover` refreshes a synced sibling explicitly, and can only
 *     pass what it gathered.
 * Deriving the rows here makes both paths render the same complete set.
 *
 * Per-series decimals ride along in `series.custom.dp`.
 */
function rideTooltipFormatter() {
  const chart = this.points?.[0]?.series?.chart ?? this.point?.series?.chart;
  if (!chart) return false;
  const rows = chart.series
    .map((s) => {
      const p = pointAtX(s, this.x);
      if (!p) return null;
      return `<span style="color:${s.color}">\u25cf</span> ${s.name}: <b>${p.y.toFixed(s.options.custom?.dp ?? 0)}</b>`;
    })
    .filter(Boolean);
  return rows.length ? `<b>${fmtDur(this.x)}</b><br/>${rows.join("<br/>")}` : false;
}

function PowerHrChart({ samples }) {
  const t0 = samples[0].t;
  const ref = useChart(
    () => {
      const powers = samples.filter((s) => s.power_w != null).map((s) => [s.t - t0, s.power_w]);
      const hrs = samples.filter((s) => s.hr != null).map((s) => [s.t - t0, s.hr]);
      return {
        chart: { type: "line", height: 220, zooming: { type: "x" } },
        xAxis: {
          title: { text: undefined },
          labels: { formatter() { return fmtDur(this.value); } },
        },
        yAxis: [
          { title: { text: undefined } },
          {
            title: { text: undefined },
            opposite: true,
            // A wash, not a fill — the bands orient the eye without competing
            // with the traces. fade() rather than appending an alpha pair to
            // the hex: that only works while every zone token happens to be
            // 6-digit hex, and silently produces garbage the day one isn't.
            plotBands: HR_ZONES.map((z) => ({ from: z.low, to: z.high, color: fade(z.color, 0.06) })),
          },
        ],
        tooltip: { shared: true, formatter: rideTooltipFormatter },
        series: [
          { name: "Power (W)", data: powers, yAxis: 0, color: cssVar("--accent"), fillOpacity: 0.12, type: "area" },
          { name: "Heart rate (bpm)", data: hrs, yAxis: 1, color: cssVar("--hot") },
        ],
      };
    },
    [samples],
    { sync: "cycling" },
  );

  return html`<div class="pwchart-wrap rise"><div ref=${ref}></div></div>`;
}

/* ── cycling: speed + cadence over time ───────────────────────────────────
 * Both come straight off the Wahoo at 1 Hz (see fit.ts's extractFitSamples);
 * neither is derived the way running's cadence is. Split out from the
 * power/HR chart rather than added to it — four series over two axes was
 * already the readable limit there — and joined to it by hover sync so the
 * pair reads as one stacked view of the same ride.
 */

// Centered rolling-mean window. Raw 1 Hz cadence swings ~15 rpm between
// adjacent seconds on a normal pedal stroke, and raw speed jitters with every
// GPS/wheel-sensor tick; at a chart's pixel density that renders as a solid
// band whose shape is unreadable. 15s is long enough to settle both and short
// enough to keep a real surge or a traffic-light slowdown intact.
const RIDE_SMOOTH_SEC = 15;

// A pause in the recording longer than this breaks the line rather than
// drawing across it. The Wahoo records nothing while auto-paused, so a stop
// is a gap in `t`, not a run of zeros — and a line drawn straight across it
// would read as "still riding, just slower", which is exactly the confusion
// migrations/0023_moving_time.sql documents at the averages level. 10s is
// comfortably above the ~1s sample spacing and below a real traffic stop.
const RIDE_GAP_SEC = 10;

/**
 * Smooth one `{ t, [key] }` series with a centered time-window mean and
 * return `[elapsedSec, value]` pairs, with a null point inserted across any
 * gap longer than RIDE_GAP_SEC so the line breaks there.
 *
 * Time-windowed rather than a fixed sample count: the stream is only
 * nominally 1 Hz, and averaging "the previous N samples" across a stop would
 * silently blend the two sides of it together.
 */
function smoothedSeries(samples, key, t0) {
  const pts = [];
  for (const s of samples) {
    if (s[key] != null) pts.push([s.t, s[key]]);
  }
  if (!pts.length) return [];

  const half = RIDE_SMOOTH_SEC / 2;
  const out = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = pts[i][0];
    // Both pointers only ever advance, so this stays O(n) overall despite
    // the inner loops — each sample enters and leaves the window once.
    while (hi < pts.length && pts[hi][0] <= t + half) sum += pts[hi++][1];
    while (pts[lo][0] < t - half) sum -= pts[lo++][1];
    if (i > 0 && t - pts[i - 1][0] > RIDE_GAP_SEC) out.push([pts[i - 1][0] - t0 + 1, null]);
    out.push([t - t0, sum / (hi - lo)]);
  }
  return out;
}

function SpeedCadenceChart({ samples }) {
  const t0 = samples[0].t;
  const ref = useChart(
    () => {
      const speeds = smoothedSeries(samples, "speed_ms", t0).map(([t, v]) => [t, v == null ? null : v * 3.6]);
      const cadences = smoothedSeries(samples, "cadence_rpm", t0);
      if (!speeds.length && !cadences.length) return null;
      return {
        chart: { type: "line", height: 220, zooming: { type: "x" } },
        xAxis: {
          title: { text: undefined },
          labels: { formatter() { return fmtDur(this.value); } },
        },
        yAxis: [
          { title: { text: undefined } },
          // Cadence pinned to start at 0 rather than auto-scaling: a rider
          // holding 85-90 rpm the whole way would otherwise get an axis
          // spanning 5 rpm, magnifying noise into what looks like structure.
          { title: { text: undefined }, opposite: true, min: 0, softMax: 120 },
        ],
        tooltip: { shared: true, formatter: rideTooltipFormatter },
        series: [
          // Palette tokens, not fixed hex: the four themes (see ui.css)
          // re-derive every chart colour, and --accent/--hot are already
          // spoken for by power and HR on the chart above.
          { name: "Speed (km/h)", data: speeds, yAxis: 0, color: cssVar("--gold"), fillOpacity: 0.14, type: "area", custom: { dp: 1 } },
          { name: "Cadence (rpm)", data: cadences, yAxis: 1, color: cssVar("--accent-2") },
        ],
      };
    },
    [samples],
    { sync: "cycling" },
  );

  return html`<div class="pwchart-wrap rise"><div ref=${ref}></div></div>`;
}

/** Fetches per-second samples from `url` once and hands them to every
 * consumer (the power+HR chart, the decoupling stat, the heart-rate-zones
 * card), so none of them issue their own request. Pass `url: null` to skip
 * the fetch entirely (e.g. no power data on this workout, or not a swim). */
function useSamples(url) {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    if (!url) {
      setState({ status: "none" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (cancelled) return;
        if (!data.samples || data.samples.length < 5) {
          setState({ status: "none" });
          return;
        }
        setState({ status: "ok", samples: data.samples });
      } catch {
        if (!cancelled) setState({ status: "none" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

function CyclingSamplesSection({ state }) {
  if (state.status === "loading")
    return html`<div
      class="skeleton"
      style=${{ height: "13rem", marginTop: "1rem" }}
    ></div>`;
  if (state.status !== "ok") return null;
  // A ride that only ever had the Watch echo carries HR and nothing else
  // (see migrations/0012_cycling_samples_by_source.sql) — no Wahoo row means
  // no speed or cadence, so that chart is skipped rather than rendered empty.
  const hasSpeedCadence = state.samples.some((s) => s.speed_ms != null || s.cadence_rpm != null);
  return html`
    <div class="section-label" style=${{ marginTop: "2.4rem" }}>
      Power & heart rate
    </div>
    <${PowerHrChart} samples=${state.samples} />
    <${Decoupling} samples=${state.samples} />
    ${hasSpeedCadence
      ? html`<div class="section-label" style=${{ marginTop: "2.4rem" }}>Speed & cadence</div>
          <${SpeedCadenceChart} samples=${state.samples} />`
      : null}
  `;
}

/* ── running: cadence-over-time chart (see CLAUDE.md's running section —
 * derived from stepCount deltas, no native per-second field) ─────────────── */

// How many bars to render regardless of session length — matches Apple's own
// Health app charts (a fixed, readable count of wide bars, not a dense
// per-second trace). Raw samples run ~1/s, so a 20min run and a 2hr run both
// collapse to this many buckets, just wider ones for the longer run.
// Target width per bar (including its gap) — wide enough that individual
// bars stay visually distinct rather than blurring into a solid block, which
// is what a fixed bar count did on narrower containers. Clamped so a very
// wide screen doesn't render thousands of near-empty buckets and a very
// narrow one doesn't go below a readable minimum.
const CADENCE_BAR_TARGET_PX = 10;
const CADENCE_BARS_MIN = 30;
const CADENCE_BARS_MAX = 200;
// Fixed bar width in px (see plotOptions.column.pointWidth below) — roughly
// 70% of the target slot, leaving a visible ~30% gap.
const CADENCE_BAR_PX = Math.round(CADENCE_BAR_TARGET_PX * 0.7);

/** How many bars reasonably fit in `containerWidthPx` at the target density. */
function barsForWidth(containerWidthPx) {
  const target = Math.round(containerWidthPx / CADENCE_BAR_TARGET_PX);
  const lo = Math.max(CADENCE_BARS_MIN, target - 10);
  const hi = Math.min(CADENCE_BARS_MAX, target + 10);
  // Highcharts' column renderer always snaps bar geometry to whole pixels
  // (independent of CSS) — for a slot width (containerWidthPx / n) that
  // isn't itself a whole number, that snapping necessarily makes some gaps
  // 1px different from others (pigeonhole principle, not a bug). Search
  // near the target count for whichever n divides the actual width most
  // evenly, minimizing how much rounding slack there is to distribute.
  let best = target;
  let bestRemainder = Infinity;
  for (let n = lo; n <= hi; n++) {
    const remainder = containerWidthPx % n;
    const dist = Math.min(remainder, n - remainder);
    if (dist < bestRemainder) {
      bestRemainder = dist;
      best = n;
    }
  }
  return best;
}

/**
 * Downsample a `{ t, [key]: number }` time series into `bucketCount`
 * equal-width windows, averaging `key` within each — the same idea as
 * StrokeDriftChart's per-lap points, just on a time axis instead of a lap
 * axis. Empty buckets (a gap in the raw stream) are dropped rather than
 * rendered as zero. Returns the bucket width alongside the points so the
 * caller can set `series.pointRange` for evenly-sized bars.
 */
function bucketAverage(samples, key, bucketCount) {
  if (!samples.length) return { points: [], width: 0 };
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const width = Math.max(1, t1 - t0) / bucketCount;
  const sums = new Array(bucketCount).fill(0);
  const counts = new Array(bucketCount).fill(0);
  for (const s of samples) {
    const v = s[key];
    if (v == null) continue;
    const i = Math.min(bucketCount - 1, Math.floor((s.t - t0) / width));
    sums[i] += v;
    counts[i] += 1;
  }
  const points = [];
  for (let i = 0; i < bucketCount; i++) {
    if (counts[i] === 0) continue;
    points.push({ t: t0 + (i + 0.5) * width, [key]: sums[i] / counts[i] });
  }
  return { points, width };
}

function CadenceChart({ samples }) {
  const t0 = samples.length ? samples[0].t : 0;
  const ref = useChart(
    (container, existingChart) => {
      if (!samples.length) return null;
      // The bar-count search needs the actual *plotted* width, not the
      // container's outer width — narrower by the y-axis label gutter — but
      // that's only known once a chart exists. Estimate on first paint
      // (~30px gutter for "0"–"300" at this font); the resize-observer pass
      // in useChart immediately self-corrects using the real plotWidth.
      const plotWidth = existingChart ? existingChart.plotWidth : container.clientWidth - 30;
      const barCount = barsForWidth(plotWidth);
      const { points } = bucketAverage(samples, "cadence_spm", barCount);
      return {
        // Extra bottom spacing: with the x-axis labels off there's no reserved
        // row beneath the plot area, so the "0" gridline/label sat flush
        // against the card's bottom edge without this.
        chart: { type: "column", height: 220, spacingBottom: 12 },
        // The section label above ("Cadence") already names the single
        // series; a legend under the axis repeats it.
        legend: { enabled: false },
        // Categories rather than a numeric/datetime axis: every bar occupies
        // exactly one evenly-sized category slot, so widths and gaps come
        // out pixel-perfect by construction — a numeric axis translates each
        // bucket's real time span through the scale individually, and that
        // floating-point-to-pixel rounding varied by ±1px bar to bar (the
        // same trick StrokeDriftChart already uses for its lap axis).
        xAxis: {
          title: { text: undefined },
          // Categories still carry the elapsed-time label for the tooltip
          // (via this.category) — just not rendered as axis ticks. The
          // section label above ("Cadence") already says what this is;
          // repeating elapsed time along the bottom was redundant chrome.
          categories: points.map((s) => fmtDur(s.t - t0)),
          labels: { enabled: false },
        },
        yAxis: { title: { text: undefined } },
        plotOptions: {
          column: {
            borderWidth: 0,
            // …and a transparent border colour as a belt to that braces.
            // Highcharts' default column border is *white*, and it drops the
            // `stroke-width="0"` attribute off existing point paths when a
            // chart.update() changes the point count — which is exactly what
            // the resize-observer re-bucketing pass does whenever the
            // first-paint bar-count estimate disagrees with the real
            // plotWidth (so: some viewport widths, not others). SVG's default
            // stroke-width of 1 then applies and every bar picks up a 1px
            // white outline. With the colour transparent there's nothing to
            // paint even if the width attribute goes missing again.
            borderColor: "transparent",
            // Rounded caps like Apple's own Health charts — top only, flat
            // where the bar meets the axis.
            borderRadiusTopLeft: 2,
            borderRadiusTopRight: 2,
            borderRadiusBottomLeft: 0,
            borderRadiusBottomRight: 0,
            groupPadding: 0,
            pointPadding: 0,
            // A fixed pixel width rather than a fractional pointPadding —
            // even with a slot width chosen to divide the container evenly
            // (see barsForWidth), splitting that slot into fractional
            // left/right padding can still round asymmetrically bar to bar.
            // A constant width has nothing left to round unevenly.
            pointWidth: CADENCE_BAR_PX,
            // Bars sit muted by default; only the one under the cursor pops
            // to the full accent color, drawing the eye to exactly one bar
            // at a time instead of a wall of solid teal.
            states: { hover: { color: cssVar("--accent"), brightness: 0 } },
          },
        },
        tooltip: {
          headerFormat: "",
          pointFormatter() {
            return `<b>${this.category}</b><br/>Cadence: <b>${Math.round(this.y)}</b> spm`;
          },
        },
        series: [
          {
            name: "Cadence (spm)",
            data: points.map((s) => Math.round(s.cadence_spm)),
            // 33% more muted than the full accent — see the
            // column.states.hover override above for the full-color pop.
            color: fade(cssVar("--accent"), 0.67),
          },
        ],
      };
    },
    [samples],
    { sync: "running" },
  );

  if (!samples.length) return null;
  return html`<div class="pwchart-wrap rise"><div ref=${ref}></div></div>`;
}

/* ── running: heart rate — a plain line/area rather than bars (HR is
 * naturally smooth, unlike derived cadence), sharing the same "running"
 * hover-sync group as CadenceChart above so hovering either highlights the
 * same instant on both. ──────────────────────────────────────────────── */

function RunningHrChart({ samples }) {
  const t0 = samples.length ? samples[0].t : 0;
  const ref = useChart(
    () => {
      if (!samples.length) return null;
      return {
        // Same bottom-spacing fix as CadenceChart — see its comment.
        chart: { type: "area", height: 220, spacingBottom: 12 },
        // Same as CadenceChart — the "Heart rate" section label makes the
        // legend redundant.
        legend: { enabled: false },
        xAxis: { title: { text: undefined }, labels: { enabled: false } },
        yAxis: { title: { text: undefined } },
        tooltip: {
          headerFormat: "",
          pointFormatter() {
            return `<b>${fmtDur(this.x)}</b><br/>Heart rate: <b>${Math.round(this.y)}</b> bpm`;
          },
        },
        series: [
          {
            name: "Heart rate (bpm)",
            data: samples.map((s) => [s.t - t0, s.hr]),
            // Muted like cadence's bars, for the same reason — see
            // CadenceChart's color comment. --hot is the heart-rate/effort
            // hue, and every theme owns it.
            color: fade(cssVar("--hot"), 0.67),
            fillOpacity: 0.12,
            marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
            states: { hover: { lineWidthPlus: 0 } },
          },
        ],
      };
    },
    [samples],
    { sync: "running" },
  );

  if (!samples.length) return null;
  return html`<div class="pwchart-wrap rise"><div ref=${ref}></div></div>`;
}

/* ── swimming/tennis: heart rate — same shape/rendering as RunningHrChart,
 * just without a hover-sync group since neither sport has another
 * time-synced chart to join. ─────────────────────────────────────────── */

function HrLineChart({ samples }) {
  const t0 = samples.length ? samples[0].t : 0;
  const ref = useChart(
    () => {
      if (!samples.length) return null;
      return {
        chart: { type: "area", height: 220, spacingBottom: 12 },
        legend: { enabled: false },
        xAxis: { title: { text: undefined }, labels: { enabled: false } },
        yAxis: { title: { text: undefined } },
        tooltip: {
          headerFormat: "",
          pointFormatter() {
            return `<b>${fmtDur(this.x)}</b><br/>Heart rate: <b>${Math.round(this.y)}</b> bpm`;
          },
        },
        series: [
          {
            name: "Heart rate (bpm)",
            data: samples.map((s) => [s.t - t0, s.hr]),
            color: fade(cssVar("--hot"), 0.67),
            fillOpacity: 0.12,
            marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
            states: { hover: { lineWidthPlus: 0 } },
          },
        ],
      };
    },
    [samples],
  );

  if (!samples.length) return null;
  return html`<div class="pwchart-wrap rise"><div ref=${ref}></div></div>`;
}

function RunningMetricsSection({ cadence, hr }) {
  if (cadence.status === "loading" || hr.status === "loading")
    return html`<div
      class="skeleton"
      style=${{ height: "13rem", marginTop: "1rem" }}
    ></div>`;
  return html`
    ${cadence.status === "ok"
      ? html`<div class="section-label" style=${{ marginTop: "2.4rem" }}>Cadence</div>
          <${CadenceChart} samples=${cadence.samples} />`
      : null}
    ${hr.status === "ok"
      ? html`<${HeartZones} samples=${hr.samples} />`
      : null}
    ${hr.status === "ok"
      ? html`<div class="section-label" style=${{ marginTop: "2.4rem" }}>Heart rate</div>
          <${RunningHrChart} samples=${hr.samples} />`
      : null}
  `;
}

function Laps({ laps, equip, setEquip }) {
  // Equipment tends to stay the same across subsequent laps, so toggling a
  // lap's checkbox cascades the change to that lap and every lap below it.
  function toggleFromLap(lapNum, key, on) {
    const startIdx = laps.findIndex((l) => l.lap_num === lapNum);
    if (startIdx < 0) return;
    const targets = new Set(laps.slice(startIdx).map((l) => l.lap_num));
    setEquip((prev) => {
      const next = { ...prev };
      for (const lapKey of targets) {
        const set = new Set(next[lapKey] || []);
        on ? set.add(key) : set.delete(key);
        next[lapKey] = set;
      }
      return next;
    });
  }

  return html`
    <div class="laps-wrap">
      <div class="laps-scroll">
        <table class="laps">
          <thead>
            <tr>
              <th>Lap</th>
              <th>Dist</th>
              <th>Active</th>
              <th>Pace/50</th>
              <th>Strokes</th>
              <th>SWOLF</th>
              <th>Rest</th>
              <th>HR</th>
              ${EQUIPMENT.map(
                (eq) =>
                  html` <th class="eqcol" key=${eq.key}>
                    <span class="eqhead">${eq.label}</span>
                  </th>`,
              )}
            </tr>
          </thead>
          <tbody>
            ${laps.map(
              (l) =>
                html` <tr key=${l.lap_num}>
                  <td class="lapnum">${l.lap_num}</td>
                  <td>
                    ${dash(
                      l.distance_m != null
                        ? `${Math.round(l.distance_m)}m`
                        : null,
                    )}
                  </td>
                  <td>${fmtDur(l.active_sec)}</td>
                  <td>
                    ${dash(
                      l.pace_per_50m != null ? fmtDur(l.pace_per_50m) : null,
                    )}
                  </td>
                  <td>${dash(round(l.strokes))}</td>
                  <td>${dash(round(l.swolf))}</td>
                  <td>
                    ${dash(l.rest_after_sec ? fmtDur(l.rest_after_sec) : null)}
                  </td>
                  <td>${dash(round(l.avg_hr))}</td>
                  ${EQUIPMENT.map(
                    (eq) =>
                      html` <td class="eqcol" key=${eq.key}>
                        <${Check}
                          checked=${equip[l.lap_num]?.has(eq.key)}
                          title=${`${eq.label}, lap ${l.lap_num} and all laps below`}
                          onChange=${(on) =>
                            toggleFromLap(l.lap_num, eq.key, on)}
                        />
                      </td>`,
                  )}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ── calisthenics: per-set reps/RIR/rest table ───────────────────────────────
 * No laps, no device samples — this sport is 100% self-reported (see
 * migrations/0018_calisthenics.sql). rest_before_sec is the athlete's own
 * countdown-timer reading from the logger, not a device measurement. */
function CalisthenicsSets({ sets }) {
  return html`
    <div class="laps-wrap">
      <div class="laps-scroll">
        <table class="laps">
          <thead>
            <tr>
              <th>Set</th>
              <th>Reps</th>
              <th>RIR</th>
              <th>Rest before</th>
            </tr>
          </thead>
          <tbody>
            ${sets.map(
              (s) => html`
                <tr key=${s.set_num}>
                  <td class="lapnum">${s.set_num}</td>
                  <td>${s.reps}</td>
                  <td>
                    ${s.is_amrap
                      ? html`<span class="tag" style=${{ margin: 0 }}
                          ><${I} name="Fire" size=${10} weight="fill" />AMRAP</span
                        >`
                      : dash(s.rir)}
                  </td>
                  <td>${dash(s.rest_before_sec != null ? fmtDur(s.rest_before_sec) : null)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function Notes({ note }) {
  const elRef = useRef(null);
  const edRef = useRef(null);
  const dirtyRef = useRef(false);
  const [active, setActive] = useState({});
  const [status, setStatus] = useState(
    note?.updated_at
      ? { text: `Saved ${fmtWhen(note.updated_at, null)}` }
      : { text: "Not yet saved" },
  );

  useEffect(() => {
    const editor = new Editor({
      element: elRef.current,
      extensions: [StarterKit],
      content: note?.content_json ? JSON.parse(note.content_json) : "",
      onUpdate: () => {
        dirtyRef.current = true;
        setStatus({ text: "Unsaved changes", kind: "" });
        refresh();
      },
      onSelectionUpdate: refresh,
    });
    edRef.current = editor;
    function refresh() {
      setActive({
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        h3: editor.isActive("heading", { level: 3 }),
        bullet: editor.isActive("bulletList"),
        ordered: editor.isActive("orderedList"),
      });
    }
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    const onUnload = (e) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
      editor.destroy();
    };
  }, []);

  async function save() {
    const editor = edRef.current;
    if (!editor) return;
    setStatus({ text: "Saving…" });
    try {
      const res = await fetch("/api/notes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_id: SID,
          content_json: editor.getJSON(),
          content_html: editor.getHTML(),
        }),
      });
      if (res.ok) {
        const d = await res.json();
        dirtyRef.current = false;
        setStatus({ text: `Saved ${fmtWhen(d.updated_at, null)}`, kind: "ok" });
      } else setStatus({ text: "Save failed", kind: "err" });
    } catch {
      setStatus({ text: "Save failed", kind: "err" });
    }
  }

  const cmd = (fn) => () => fn(edRef.current.chain().focus()).run();
  const TOOLS = [
    { key: "bold", icon: "TextB", run: cmd((c) => c.toggleBold()) },
    { key: "italic", icon: "TextItalic", run: cmd((c) => c.toggleItalic()) },
    {
      key: "h3",
      icon: "TextHThree",
      run: cmd((c) => c.toggleHeading({ level: 3 })),
    },
    {
      key: "bullet",
      icon: "ListBullets",
      run: cmd((c) => c.toggleBulletList()),
    },
    {
      key: "ordered",
      icon: "ListNumbers",
      run: cmd((c) => c.toggleOrderedList()),
    },
  ];

  return html`
    <div>
      <div class="toolbar">
        ${TOOLS.map(
          (t) =>
            html` <button
              key=${t.key}
              class=${`tbtn ${active[t.key] ? "active" : ""}`}
              onMouseDown=${(e) => e.preventDefault()}
              onClick=${t.run}
            >
              <${I} name=${t.icon} size=${17} weight="bold" />
            </button>`,
        )}
      </div>
      <div class="editor" ref=${elRef}></div>
      <div class="saverow">
        <button class="btn btn--accent" onClick=${save}>
          <${HdrGlow} className="btn-hdr" />
          <${I} name="FloppyDisk" size=${16} weight="bold" />Save notes
        </button>
        <span
          class=${`status ${status.kind === "ok" ? "status--ok" : status.kind === "err" ? "status--err" : ""}`}
        >
          ${status.kind === "ok"
            ? html`<${I} name="CheckCircle" size=${14} weight="fill" />`
            : null}${status.text}
        </span>
      </div>
    </div>
  `;
}

function DeleteButton({ sourceId }) {
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm("Delete this workout? This can't be undone from the UI.")) return;
    const reason = prompt(
      "Optional note for why (helps if your automation resubmits it later):",
      "",
    );
    if (reason === null) return; // cancelled the prompt
    setBusy(true);
    try {
      const res = await fetch(`/api/workout?source_id=${encodeURIComponent(sourceId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      if (!res.ok) {
        alert("Delete failed — please try again.");
        setBusy(false);
        return;
      }
      window.location.href = "/";
    } catch {
      alert("Delete failed — please try again.");
      setBusy(false);
    }
  }

  return html`
    <button class="btn btn--sm btn--danger" disabled=${busy} onClick=${onDelete}>
      <${I} name="Trash" size=${14} weight="bold" />${busy ? "Deleting…" : "Delete"}
    </button>
  `;
}

function App() {
  const [state, setState] = useState({ status: "loading" });
  const [equip, setEquip] = useState({});
  const [eqStatus, setEqStatus] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const timer = useRef(null);
  // Only autosave equipment after a real user edit — never on initial data load.
  const touched = useRef(false);

  // Generate (or regenerate) the AI evaluation for this workout. A single
  // POST /api/evaluate call; the server does the cohort selection + model run
  // and returns the markdown, which we swap into state.ev in place — no reload.
  async function generateEval() {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source_id: SID }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGenError(
          d.error === "ai_failed"
            ? "The model didn't respond — please try again."
            : d.detail || d.error || "Generation failed — please try again.",
        );
        return;
      }
      setState((prev) => ({
        ...prev,
        ev: {
          content_md: d.content_md,
          updated_at: d.updated_at,
          created_at: prev.ev?.created_at ?? d.updated_at,
          generated_by: d.generated_by,
        },
        // The eval also evolves the sport's next-session focus. The server
        // returns next_focus only when it actually changed (null on a no-op),
        // so fall back to the focus we already show.
        focus: d.next_focus ?? prev.focus,
      }));
    } catch {
      setGenError("Generation failed — please try again.");
    } finally {
      setGenerating(false);
    }
  }
  const editEquip = (updater) => {
    touched.current = true;
    setEquip(updater);
  };

  useEffect(() => {
    (async () => {
      const res = await fetch(
        `/api/workout?source_id=${encodeURIComponent(SID)}`,
      );
      if (!res.ok) {
        setState({ status: "notfound" });
        return;
      }
      const data = await res.json();
      const init = {};
      for (const l of data.laps || [])
        init[l.lap_num] = new Set(l.equipment || []);
      setEquip(init);
      setState({
        status: "ok",
        w: data.workout,
        laps: data.laps || [],
        sets: data.sets || [],
        calisStats: data.calisthenics_stats || null,
        note: data.note,
        ev: data.eval,
        focus: data.current_focus,
      });
    })();
  }, []);

  // Debounced autosave of equipment, but only once the user has actually toggled
  // something — the data-load setEquip must not trigger a write.
  useEffect(() => {
    if (!touched.current) return;
    setEqStatus({ text: "Saving…" });
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const set = [];
      for (const [lap, keys] of Object.entries(equip))
        for (const k of keys) set.push({ lap_num: Number(lap), equipment: k });
      try {
        const res = await fetch("/api/lap-equipment", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source_id: SID, set }),
        });
        setEqStatus(
          res.ok
            ? { text: "Saved", kind: "ok" }
            : { text: "Save failed", kind: "err" },
        );
      } catch {
        setEqStatus({ text: "Save failed", kind: "err" });
      }
    }, 400);
  }, [equip]);

  // Gate the fetch on power actually being present — computed off `state`
  // directly (rather than the `hasPower` local below) since this hook call
  // must run on every render, including the loading/notfound ones that
  // return before `hasPower` exists.
  const cySamples = useSamples(
    state.status === "ok" &&
      state.w?.sport === "cycling" &&
      state.w?.avg_power_w != null
      ? `/api/cycling-samples?source_id=${encodeURIComponent(SID)}`
      : null,
  );
  const swimHr = useSamples(
    state.status === "ok" && state.w?.sport === "swimming"
      ? `/api/swim-hr-samples?source_id=${encodeURIComponent(SID)}`
      : null,
  );
  const runningCadence = useSamples(
    state.status === "ok" && state.w?.sport === "running"
      ? `/api/running-cadence-samples?source_id=${encodeURIComponent(SID)}`
      : null,
  );
  const runningHr = useSamples(
    state.status === "ok" && state.w?.sport === "running"
      ? `/api/running-hr-samples?source_id=${encodeURIComponent(SID)}`
      : null,
  );
  const tennisHr = useSamples(
    state.status === "ok" && state.w?.sport === "tennis"
      ? `/api/tennis-hr-samples?source_id=${encodeURIComponent(SID)}`
      : null,
  );

  if (state.status === "loading")
    return html`<div class="wrap">
      <a class="back" href="/"
        ><${I} name="ArrowLeft" size=${15} weight="bold" />All workouts</a
      >
      <div class="skeleton" style=${{ height: "8rem" }} />
    </div>`;
  if (state.status === "notfound")
    return html`<div class="wrap">
      <a class="back" href="/"
        ><${I} name="ArrowLeft" size=${15} weight="bold" />All workouts</a
      >
      <div class="empty">
        <${I} name="MagnifyingGlass" size=${30} weight="duotone" />
        <p>Workout not found.</p>
      </div>
    </div>`;

  const { w, laps, sets, calisStats, note, ev, focus } = state;
  const isSwim = w.sport === "swimming";
  const isRunning = w.sport === "running";
  const isTennis = w.sport === "tennis";
  const isCalisthenics = w.sport === "calisthenics";
  const hasPower = w.sport === "cycling" && w.avg_power_w != null;
  // Split the Time stat into moving + elapsed only when the device actually
  // auto-paused for a stretch worth naming. Sub-30s gaps are rounding and a
  // stopped-clock caption on every ride would be noise, not information.
  const hasMoving =
    w.moving_sec != null && w.duration_sec != null && w.duration_sec - w.moving_sec >= 30;
  const topSetReps = isCalisthenics && sets.length ? Math.max(...sets.map((s) => s.reps)) : null;
  const strokeDrift = isSwim ? computeStrokeDrift(laps, w.pool_length_m) : null;
  const dist = fmtDist(w.distance_m);
  const showWatchEnergy =
    w.watch_active_energy != null &&
    (w.active_energy == null ||
      Math.round(w.watch_active_energy) !== Math.round(w.active_energy));

  return html`
    <div class="wrap">
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <a class="back" href="/"
          ><${I} name="ArrowLeft" size=${15} weight="bold" />All workouts</a
        >
        <${DeleteButton} sourceId=${SID} />
      </div>

      <div class="hero rise">
        <div class="hero__icon">
          <${I} name=${sportIcon(w.sport)} size=${34} weight="duotone" />
        </div>
        <div>
          <div class="hero__title">${w.sub_type || w.sport}</div>
          <div class="hero__when">${fmtWhen(w.start_time, w.tz_offset)}</div>
          <span class="tag"
            ><${I}
              name=${sportIcon(w.sport)}
              size=${12}
              weight="bold"
            />${w.sport}</span
          >
          ${w.source === "wahoo"
            ? html`<span
                class="tag tag--source"
                title="Recorded on a Wahoo bike computer"
                ><${I} name="Gauge" size=${12} weight="bold" />Wahoo</span
              >`
            : html`<span class="tag tag--source" title="Recorded on Apple Watch"
                ><${I} name="Watch" size=${12} weight="bold" />Apple Watch</span
              >`}
          ${w.has_watch_echo
            ? html`<span
                class="tag tag--source"
                title="Also synced from Apple Watch via Health — data like heart rate from that copy is merged in above"
                ><${I} name="Watch" size=${12} weight="bold" />Apple Watch</span
              >`
            : null}
        </div>
      </div>

      <div class="stat-grid rise" style=${{ animationDelay: "60ms" }}>
        ${hasMoving
          ? html`<${Stat}
              k="Time"
              v=${fmtDur(w.moving_sec)}
              icon="Timer"
              sub=${`${fmtDur(w.duration_sec)} elapsed`}
              tip=${`Moving time — the head unit auto-paused, so ${fmtDur(
                w.duration_sec - w.moving_sec,
              )} of the ${fmtDur(
                w.duration_sec,
              )} elapsed was spent stopped. Avg power, cadence and HR are all over moving time.`}
            />`
          : html`<${Stat} k="Time" v=${fmtDur(w.duration_sec)} icon="Timer" />`}
        ${dist ? html`<${Stat} k="Distance" v=${dist} icon="Path" />` : null}
        <${Stat}
          k="Avg HR"
          v=${round(w.avg_hr)}
          unit="bpm"
          icon="Heartbeat"
          hot=${true}
          sub=${hasMoving ? "moving only" : null}
        />
        <${Stat} k="Max HR" v=${w.max_hr} unit="bpm" icon="Pulse" hot=${true} />
        ${isSwim
          ? html`<${Stat}
              k="Pool"
              v=${w.pool_length_m}
              unit="m"
              icon="Ruler"
            />`
          : null}
        ${isSwim
          ? html`<${Stat} k="Strokes" v=${w.total_strokes} icon="Waves" />`
          : null}
        ${isCalisthenics
          ? html`<${Stat} k="Sets" v=${sets.length} icon="ListNumbers" />`
          : null}
        ${isCalisthenics
          ? html`<${Stat} k="Top set" v=${topSetReps} unit="reps" icon="Trophy" />`
          : null}
        ${isCalisthenics && calisStats?.effort_pct != null
          ? html`<${Stat}
              k="Effort"
              v=${calisStats.effort_pct}
              unit="%"
              icon="Gauge"
              tip="This session's top set (reps adjusted for RIR — reps left in the tank count toward it) compared to your best going into today. 100% = matched it."
            />`
          : null}
        <${Stat}
          k="Energy"
          v=${round(w.active_energy)}
          unit="kcal"
          icon="Fire"
          sub=${showWatchEnergy
            ? `Watch est. ${round(w.watch_active_energy)} kcal`
            : null}
        />
        ${hasPower
          ? html`<${Stat}
              k="Avg Power"
              v=${w.avg_power_w}
              unit="W"
              icon="Lightning"
            />`
          : null}
        ${hasPower
          ? html`<${Stat}
              k="NP"
              v=${w.normalized_power_w}
              unit="W"
              icon="ChartLineUp"
              tip="Normalized Power — weights surges and coasting more heavily than a plain average, so it better reflects the true physiological cost of a variable ride."
            />`
          : null}
        ${hasPower && w.intensity_factor != null
          ? html`<${Stat}
              k="IF"
              v=${w.intensity_factor.toFixed(2)}
              icon="Gauge"
              tip="Intensity Factor — Normalized Power divided by threshold power (FTP). 1.00 = a threshold effort; below ~0.75 is aerobic-base territory."
            />`
          : null}
        ${hasPower && w.training_stress_score != null
          ? html`<${Stat}
              k="TSS"
              v=${w.training_stress_score.toFixed(1)}
              icon="Battery"
              tip="Training Stress Score — combines duration and intensity into one load number. ~100 = one hour at threshold effort. Used to track training load and recovery over time."
            />`
          : null}
        ${hasPower
          ? html`<${Stat}
              k="Cadence"
              v=${w.avg_cadence_rpm}
              unit="rpm"
              icon="ArrowsClockwise"
            />`
          : null}
        ${isRunning && w.avg_cadence_rpm != null
          ? html`<${Stat}
              k="Cadence"
              v=${w.avg_cadence_rpm}
              unit="spm"
              icon="ArrowsClockwise"
            />`
          : null}
        ${hasPower && w.elevation_gain_m != null
          ? html`<${Stat}
              k="Elevation"
              v=${round(w.elevation_gain_m)}
              unit="m"
              icon="Mountains"
            />`
          : null}
        ${hasPower && w.work_kj != null
          ? html`<${Stat}
              k="Work"
              v=${round(w.work_kj)}
              unit="kJ"
              icon="Barbell"
            />`
          : null}
      </div>

      <${Focus} focus=${focus} />

      ${ROUTE_SPORTS.has(w.sport)
        ? html`<${RouteMap} sport=${w.sport} />`
        : null}
      ${isRunning
        ? html`<${RunningMetricsSection} cadence=${runningCadence} hr=${runningHr} />`
        : null}
      ${hasPower
        ? html`<div class="split-row rise">
            <div class="split-col">
              <${PowerZones} zonesJson=${w.power_zone_secs_json} />
            </div>
            <div class="split-col">
              ${cySamples.status === "ok"
                ? html`<${HeartZones} samples=${cySamples.samples} />`
                : cySamples.status === "loading"
                  ? html`<div
                      class="skeleton"
                      style=${{ height: "13rem" }}
                    ></div>`
                  : null}
            </div>
          </div>`
        : null}
      ${hasPower ? html`<${CyclingSamplesSection} state=${cySamples} />` : null}
      ${isSwim
        ? html`<div class="split-row rise">
            <div class="split-col">
              ${swimHr.status === "ok"
                ? html`<${HeartZones} samples=${swimHr.samples} />`
                : swimHr.status === "loading"
                  ? html`<div
                      class="skeleton"
                      style=${{ height: "13rem" }}
                    ></div>`
                  : null}
            </div>
            <div class="split-col">
              <${StrokeDriftChart} drift=${strokeDrift} />
            </div>
          </div>`
        : null}
      ${isSwim && swimHr.status === "ok"
        ? html`<div class="section-label" style=${{ marginTop: "2.4rem" }}>Heart rate</div>
            <${HrLineChart} samples=${swimHr.samples} />`
        : isSwim && swimHr.status === "loading"
          ? html`<div class="skeleton" style=${{ height: "13rem", marginTop: "1rem" }}></div>`
          : null}
      ${isSwim ? html`<${StrokeDriftBadge} drift=${strokeDrift} />` : null}
      ${isTennis && tennisHr.status === "ok"
        ? html`<${HeartZones} samples=${tennisHr.samples} />`
        : isTennis && tennisHr.status === "loading"
          ? html`<div class="skeleton" style=${{ height: "13rem", marginTop: "2.4rem" }}></div>`
          : null}
      ${isTennis && tennisHr.status === "ok"
        ? html`<div class="section-label" style=${{ marginTop: "2.4rem" }}>Heart rate</div>
            <${HrLineChart} samples=${tennisHr.samples} />`
        : isTennis && tennisHr.status === "loading"
          ? html`<div class="skeleton" style=${{ height: "13rem", marginTop: "1rem" }}></div>`
          : null}
      ${isSwim && laps.length
        ? html`<div class="section-label">
              Laps <span class="count">${laps.length}</span>
              ${eqStatus
                ? html`<span
                    class=${`status ${eqStatus.kind === "ok" ? "status--ok" : eqStatus.kind === "err" ? "status--err" : ""}`}
                    style=${{
                      marginLeft: "auto",
                      letterSpacing: 0,
                      textTransform: "none",
                    }}
                  >
                    ${eqStatus.kind === "ok"
                      ? html`<${I}
                          name="CheckCircle"
                          size=${13}
                          weight="fill"
                        />`
                      : null}${eqStatus.text}</span
                  >`
                : null}
            </div>
            <${Laps} laps=${laps} equip=${equip} setEquip=${editEquip} />`
        : null}
      ${isCalisthenics && sets.length
        ? html`<div class="section-label">Sets <span class="count">${sets.length}</span></div>
            <${CalisthenicsSets} sets=${sets} />`
        : null}

      <${Evaluation}
        ev=${ev}
        onGenerate=${generateEval}
        generating=${generating}
        error=${genError}
        stale=${Boolean(note && ev && note.updated_at > ev.updated_at)}
      />

      <div class="section-label" style=${{ marginTop: "2.4rem" }}>Notes</div>
      <${Notes} note=${note} />
      ${isSwim && laps.length
        ? html`<p class="hint">
            <${I} name="Info" size=${14} weight="bold" />Tag which laps used the
            buoy or snorkel above — changes save automatically.
          </p>`
        : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`
  <${Ph.IconContext.Provider} value=${{ weight: "regular" }}><${App} /></${Ph.IconContext.Provider}>
`);
