// Workout detail — summary, laps with equipment tagging, rich-text notes.
// React (no build) via htm + esm.sh; Phosphor icons; Tiptap for the editor.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { html } from "htm/react";
import * as Ph from "@phosphor-icons/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
// MapLibre GL is loaded as UMD via a <script> in the page shell (see index.ts);
// grab it off the global rather than importing (its worker breaks under esm.sh).
const maplibregl = window.maplibregl;
// Same pattern for Highcharts — the interactive power/cadence/stroke-drift
// charts, so hovering shows exact values instead of reading an SVG by eye.
const Highcharts = window.Highcharts;

// One-time dark theme matching the page's own palette (ui.css's :root vars —
// Highcharts can't read CSS custom properties itself, so these are the same
// hex values copied over by hand; keep in sync if the palette changes).
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
  colors: ["#afffa9", "#a8aedd", "#3fdcc9"],
  xAxis: {
    lineColor: "rgba(126, 176, 168, 0.24)",
    tickColor: "rgba(126, 176, 168, 0.24)",
    tickLength: 2,
    // 11.5px meets the zonebar labels (0.77rem ≈ 11.5px) in the middle of
    // Highcharts' own default (12.8px) — the two chart types sit side by
    // side in a split-row, so their type scale should match.
    labels: { style: { color: "#97a296", fontSize: "11.5px" }, y: 14 },
    // Visible on every chart, not just synced ones — a vertical marker at
    // the hovered instant reads naturally even solo, and is exactly what
    // cross-chart sync (see useChart's `sync` option) drives on the other
    // charts in a group.
    crosshair: { color: "rgba(233, 242, 239, 0.25)", width: 1, dashStyle: "Dash" },
  },
  yAxis: {
    gridLineColor: "rgba(126, 176, 168, 0.12)",
    tickLength: 0,
    labels: { style: { color: "#97a296", fontSize: "11.5px" }, x: -2 },
    title: { style: { color: "#97a296" } },
  },
  legend: { itemStyle: { color: "#eaf1e9" }, itemHoverStyle: { color: "#afffa9" } },
  tooltip: {
    backgroundColor: "#0a0a0a",
    borderColor: "rgba(126, 176, 168, 0.24)",
    style: { color: "#eaf1e9" },
  },
  plotOptions: {
    series: { animation: false, marker: { enabled: false } },
  },
});

/**
 * Cross-chart hover sync — charts registered under the same key highlight
 * the same instant together, the way Apple's Health app lines up a single
 * hovered moment across its stacked Cadence / Vertical Oscillation / Ground
 * Contact Time charts. Only the running section's cadence chart joins a
 * group today; adding the next running chart is just passing the same
 * `sync: "running"` key to its own useChart call — no other wiring needed.
 */
const syncGroups = new Map(); // key -> Set<Highcharts.Chart>

function broadcastHover(sourceChart, groupKey, nativeEvent) {
  const group = syncGroups.get(groupKey);
  if (!group) return;
  for (const other of group) {
    if (other === sourceChart || !other.series.length) continue;
    const event = other.pointer.normalize(nativeEvent);
    const point = other.series[0].searchPoint(event, true);
    if (!point) continue;
    point.onMouseOver();
    other.tooltip.refresh(point);
    other.xAxis[0].drawCrosshair(event, point);
  }
}

function broadcastLeave(sourceChart, groupKey) {
  const group = syncGroups.get(groupKey);
  if (!group) return;
  for (const other of group) {
    if (other === sourceChart) continue;
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
const HDR_BRAND = "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKdEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEvTbuMU6uEHFO7a1OsggKH7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAj0AAAAAAABZUrmvUrgEAAAAAAABL14EBc8WIP97QIMNc/a+cgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QHc1lA4JywgUC6gUCagQJVsJBVuoEQVbGBCVW7gQlVuYECElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjEuMTAwc3PZY8CLY8WIP97QIMNc/a9nyKRFo4dFTkNPREVSRIeXTGF2YzYxLjMuMTAwIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QM/ngQCjt4EAAICSSYNCWAH4AfsEHBIODCkAABhgAAAlI///nKB4HN+GUJIpob3//1sfqqO////tORflwACjk4EAfQCWAECSnBBJwAADIAAAVHCjk4EA+gCWAECSnBBLIAADIAAAVHCjk4EBdwCWAECSnBBKQAADIAAAVHCjk4EB9ACWAECSnBBJQAADIAAAVHCjk4ECcQCWAECSnBBIIAADIAAAVHCjk4EC7gCWAECSnBBHoAADIAAAVHCjk4EDawCWAECSnBBHAAADIAAAVHAcU7trkbuPs4EAt4r3gQHxggGy8IED";

function HdrGlow({ className }) {
  return html`<video
    class=${className}
    src=${HDR_BRAND}
    autoPlay
    muted
    loop
    playsInline
    aria-hidden="true"
  />`;
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

// Custom MapLibre vector style, keyed to the app palette so the basemap is part
// of the design system rather than a stock theme. Vector tiles from OpenFreeMap
// (keyless, OSM data, OpenMapTiles schema). Deliberately minimal — land, water,
// and faint roads only; no labels, POIs, buildings or boundaries — so the route
// stays the hero.
//   water = --surface  → matches the power-zones card background (by request)
//   land  = --surface-2 → a hair lighter, so landmass reads against the water
//   roads = faint --line-ish teal-grey
const MAP_COLORS = {
  land: "#101010",
  water: "#0a0a0a",
  road: "rgba(126,176,168,0.20)",
};
const MAP_STYLE = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    ofm: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
  },
  layers: [
    {
      id: "land",
      type: "background",
      paint: { "background-color": MAP_COLORS.land },
    },
    {
      id: "water",
      type: "fill",
      source: "ofm",
      "source-layer": "water",
      paint: { "fill-color": MAP_COLORS.water },
    },
    {
      id: "roads",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": MAP_COLORS.road,
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
      style: MAP_STYLE,
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
          "line-color": "#afffa9",
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
          "circle-color": [
            "match",
            ["get", "role"],
            "finish",
            "#a8aedd",
            "#afffa9",
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#031703",
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
const HR_ZONES = [
  { label: "Z1 Recovery", low: 0, high: 130, color: "#a8aedd" },
  { label: "Z2 Aerobic", low: 130, high: 141, color: "#73c5ed" },
  { label: "Z3 Tempo", low: 141, high: 153, color: "#3fdcc9" },
  { label: "Z4 Threshold", low: 153, high: 164, color: "#72f5bd" },
  { label: "Z5 VO2max", low: 164, high: 200, color: "#afffa9" },
];
// Cool → bright gradient across a Coggan-style 7-zone power split (Active
// Recovery through Neuromuscular). Independent of HR_ZONES — power and HR
// zones don't share a boundary scheme, so no attempt is made to align them.
const POWER_ZONE_COLORS = [
  "#a8aedd",
  "#88bced",
  "#5bcee8",
  "#3fdcc9",
  "#5fedc2",
  "#85fcb7",
  "#afffa9",
];

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
            color: "#afffa9",
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

function Decoupling({ samples }) {
  const withPower = samples.filter((s) => s.power_w != null);
  const withHr = samples.filter((s) => s.hr != null);
  if (withPower.length < 20 || withHr.length < 6) return null;
  const midT = (samples[0].t + samples[samples.length - 1].t) / 2;
  const avg = (arr, key) => arr.reduce((a, s) => a + s[key], 0) / arr.length;
  const p1 = withPower.filter((s) => s.t < midT),
    p2 = withPower.filter((s) => s.t >= midT);
  const h1 = withHr.filter((s) => s.t < midT),
    h2 = withHr.filter((s) => s.t >= midT);
  if (!p1.length || !p2.length || !h1.length || !h2.length) return null;
  const r1 = avg(p1, "power_w") / avg(h1, "hr");
  const r2 = avg(p2, "power_w") / avg(h2, "hr");
  const pct = ((r1 - r2) / r1) * 100;
  const kind = pct < 5 ? "good" : pct < 8 ? "warn" : "bad";
  return html`
    <div class=${`decoupling decoupling--${kind} rise`}>
      <span class="decoupling__v"
        >${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span
      >
      <span class="decoupling__label">
        Aerobic decoupling (Power:HR, 1st half vs 2nd half) —
        ${kind === "good"
          ? "held steady, aerobically sound."
          : kind === "warn"
            ? "some fade in the back half."
            : "notable fade — likely working above aerobic base."}
      </span>
    </div>
  `;
}

function PowerHrChart({ samples }) {
  const t0 = samples[0].t;
  const ref = useChart(() => {
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
          plotBands: HR_ZONES.map((z) => ({ from: z.low, to: z.high, color: `${z.color}0f` })),
        },
      ],
      tooltip: {
        shared: true,
        headerFormat: '<b>{point.key}</b><br/>',
        formatter() {
          const rows = this.points
            .map((p) => `<span style="color:${p.color}">●</span> ${p.series.name}: <b>${Math.round(p.y)}</b>`)
            .join("<br/>");
          return `<b>${fmtDur(this.x)}</b><br/>${rows}`;
        },
      },
      series: [
        { name: "Power (W)", data: powers, yAxis: 0, color: "#afffa9", fillOpacity: 0.12, type: "area" },
        { name: "Heart rate (bpm)", data: hrs, yAxis: 1, color: "#a8aedd" },
      ],
    };
  }, [samples]);

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
  return html`
    <div class="section-label" style=${{ marginTop: "2.4rem" }}>
      Power & heart rate
    </div>
    <${PowerHrChart} samples=${state.samples} />
    <${Decoupling} samples=${state.samples} />
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
            states: { hover: { color: "#afffa9", brightness: 0 } },
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
            // 33% more muted than the full accent (#afffa9) — see the
            // column.states.hover override above for the full-color pop.
            color: "rgba(175, 255, 169, 0.67)",
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
            // CadenceChart's color comment.
            color: "rgba(255, 125, 104, 0.67)",
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
            color: "rgba(255, 125, 104, 0.67)",
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
