<script lang="ts">
  import BookmarkPlus from "@lucide/svelte/icons/bookmark-plus";
  import Brush from "@lucide/svelte/icons/brush";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import Columns2 from "@lucide/svelte/icons/columns-2";
  import Download from "@lucide/svelte/icons/download";
  import Eraser from "@lucide/svelte/icons/eraser";
  import ImageUp from "@lucide/svelte/icons/image-up";
  import Lasso from "@lucide/svelte/icons/lasso";
  import Maximize from "@lucide/svelte/icons/maximize";
  import MousePointer2 from "@lucide/svelte/icons/mouse-pointer-2";
  import Pentagon from "@lucide/svelte/icons/pentagon";
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import ScanEye from "@lucide/svelte/icons/scan-eye";
  import Square from "@lucide/svelte/icons/square";
  import SquareDashed from "@lucide/svelte/icons/square-dashed";
  import SquaresIntersect from "@lucide/svelte/icons/squares-intersect";
  import SquaresSubtract from "@lucide/svelte/icons/squares-subtract";
  import SquaresUnite from "@lucide/svelte/icons/squares-unite";
  import Star from "@lucide/svelte/icons/star";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";
  import { onMount, tick, untrack, type Component } from "svelte";
  import { backend } from "../lib/backend";
  import { app, BRUSH_MAX, BRUSH_MIN, describeJob, selectsInImage, type SelectMode, type Tool } from "../lib/app.svelte";
  import { dialogs } from "../lib/dialogs.svelte";
  import { forControl } from "../lib/keys";
  import { fig, zoomText } from "../lib/format";
  import { loadImage } from "../lib/media";
  import { i18n, t, type Key } from "../lib/i18n.svelte";
  import { altKey, redoKey, undoKey } from "../lib/platform";
  import { dismissible } from "../lib/popover";
  import {
    clampShape, dragBox, handlePoint, HANDLES, hitRegion, inRegion, regionBox, resizeBox, shapesBox, simplify, snap45, transformShapes,
    type Box, type Handle,
  } from "../lib/geometry";
  import type { Point, Region, Shape } from "../lib/types";

  let viewport: HTMLDivElement;
  let stage: HTMLElement;
  let toolbar: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let fileInput = $state<HTMLInputElement>();

  // View: screen position (CSS px) = offset + image pixel × scale
  let view = $state({ scale: 1, x: 0, y: 0 });
  let fitted = true;
  let width = $state(0);
  let height = $state(0);

  let image = $state<HTMLImageElement | null>(null);
  let preview = $state<HTMLImageElement | null>(null);
  let parentImage = $state<HTMLImageElement | null>(null);
  /** a request's image, over the original (see app.partView) */
  let partImage = $state<HTMLImageElement | null>(null);
  let shownDims = "";

  let split = $state(0.5);
  let hover = $state<Point | null>(null);
  let spaceHeld = $state(false);
  /** Shift and Alt as held now: they pick the selection mode, as in Photoshop */
  let mods = $state({ shift: false, alt: false });
  /** the shape being dragged out */
  let drawing = $state<Shape | null>(null);
  /** a polygonal lasso in progress: its corners so far, in image pixels */
  let poly = $state<{ points: Point[]; mode: SelectMode; lastTap: { at: number; p: Point } } | null>(null);
  /** an open flyout: a tool group's variants, or the selection modes */
  let menu = $state<{ id: string; x: number; y: number } | null>(null);
  let menuClosed = { id: "", at: 0 };

  type Gesture =
    | { kind: "pan"; start: Point; origin: { x: number; y: number } }
    | { kind: "split" }
    | { kind: "draw"; mode: SelectMode; start: Point; last: Point; startShift: boolean; startAlt: boolean; shiftUp: boolean; altUp: boolean }
    | { kind: "tap"; start: Point }
    | { kind: "move"; region: number; start: Point; last: Point; shapes: Shape[] }
    | { kind: "scale"; region: number; handle: Handle; from: Box; shapes: Shape[] }
    | { kind: "pinch"; dist: number; mid: Point; view: { scale: number; x: number; y: number } };
  let gesture = $state<Gesture | null>(null);
  const pointers = new Map<number, Point>();

  const node = $derived(app.selected);
  // a job opened from the tree: its parent shows with the job's regions, and nothing is edited
  const viewing = $derived(app.viewedJob);
  // one request of an edit sent in several, over the original it was made from
  const part = $derived(viewing ? null : app.shownPart);
  const editing = $derived(app.mode === "edit" && !!node && !viewing && !part);
  const comparing = $derived(app.compare && !!app.parentNode && !!node && !viewing);
  // When pasted back, the "other" image is the one this version didn't adopt:
  // the pasted result or the model's whole output
  const usingRaw = $derived(!!node?.raw_image && node.image === node.raw_image);
  const altSha = $derived(node?.raw_image ? (usingRaw ? node.merged_image : node.raw_image) : null);
  const altLabel = $derived(usingRaw ? t("canvas.altMerged") : t("canvas.altRaw"));
  // The brush slider runs on a log scale (0 to 1000), so small sizes get as much room as large ones
  const sliderOf = (size: number) => Math.round((1000 * Math.log(size / BRUSH_MIN)) / Math.log(BRUSH_MAX / BRUSH_MIN));
  const sizeOf = (v: number) => Math.round(BRUSH_MIN * (BRUSH_MAX / BRUSH_MIN) ** (v / 1000));
  // the picker's dot grows with the brush, 3 to 13px
  const dotSize = $derived(Math.round(3 + sliderOf(app.brushSize) / 100));
  const altShort = $derived(usingRaw ? t("canvas.altMergedShort") : t("canvas.altRawShort"));
  const altName = $derived(usingRaw ? t("canvas.altMergedName") : t("canvas.altRawName"));
  const shownSha = $derived(node ? (part ? (app.parentNode?.image ?? null) : app.showAlt && altSha ? altSha : node.image) : null);
  // the frame drawn: the original's while a request is shown over it, else the version's
  const dims = $derived(part && app.parentNode ? app.parentNode : node);
  const partSha = $derived(part ? (part.kind === "raw" ? part.part.raw_image : part.part.merged_image) : null);
  const partAt = $derived(part ? ((part.kind === "raw" ? part.part.raw_at : part.part.merged_at) ?? [0, 0]) : [0, 0]);
  const partBox = $derived(part && node?.job_id ? (app.jobs[node.job_id]?.requests[part.part.request]?.box ?? null) : null);
  const narrow = $derived(app.layout === "narrow");
  // The regions this version was made with, outlined until a new edit is drawn; for a job on screen,
  // its own regions, drawn on the image it was sent with
  const madeWith = $derived(
    viewing
      ? node && viewing.parent_id === node.id
        ? viewing.regions
        : []
      : app.showMadeWith && !comparing && !app.showAlt && !part && !app.draft.regions.length && !drawing && !poly
        ? app.madeWithRegions
        : [],
  );
  const coarse = matchMedia("(pointer: coarse)").matches;

  // -- tools: grouped as in Photoshop's toolbar ---------------------------------
  interface Variant {
    tool: Tool;
    label: Key;
    key: string;
    icon: Component;
  }
  const groups: { id: string; label: Key; variants: Variant[] }[] = [
    { id: "select", label: "tool.select", variants: [{ tool: "select", label: "tool.select", key: "V", icon: MousePointer2 }] },
    {
      id: "marquee",
      label: "tool.marquee",
      variants: [
        { tool: "rect", label: "tool.rect", key: "M", icon: SquareDashed },
        { tool: "ellipse", label: "tool.ellipse", key: "⇧M", icon: CircleDashed },
      ],
    },
    {
      id: "lasso",
      label: "tool.lassoGroup",
      variants: [
        { tool: "lasso", label: "tool.lasso", key: "L", icon: Lasso },
        { tool: "polygon", label: "tool.polygon", key: "⇧L", icon: Pentagon },
      ],
    },
    {
      id: "brush",
      label: "tool.brushGroup",
      variants: [
        { tool: "brush", label: "tool.brush", key: "B", icon: Brush },
        { tool: "eraser", label: "tool.eraser", key: "E", icon: Eraser },
      ],
    },
  ];
  const shown = (g: (typeof groups)[number]): Variant => {
    const kind = g.id === "marquee" ? app.marquee : g.id === "lasso" ? app.lassoKind : g.id === "brush" ? app.brushKind : "select";
    return g.variants.find((v) => v.tool === kind) ?? g.variants[0];
  };

  const modes: { id: SelectMode; label: Key; hint: string; icon: Component }[] = [
    { id: "new", label: "selmode.new", hint: "", icon: Square },
    { id: "add", label: "selmode.add", hint: "Shift", icon: SquaresUnite },
    { id: "subtract", label: "selmode.subtract", hint: altKey, icon: SquaresSubtract },
    { id: "intersect", label: "selmode.intersect", hint: `Shift+${altKey}`, icon: SquaresIntersect },
  ];
  const drawsShapes = $derived(app.tool !== "select");
  /** the mode the next shape gets: held keys override the chosen one; the eraser always subtracts */
  const liveMode = $derived<SelectMode>(
    app.tool === "eraser" ? "subtract" : mods.shift && mods.alt ? "intersect" : mods.shift ? "add" : mods.alt ? "subtract" : app.selectMode,
  );
  const modeIcon = $derived(modes.find((m) => m.id === app.selectMode)!.icon);

  function pickTool(id: Tool) {
    if (id === "rect" || id === "ellipse") app.marquee = id;
    if (id === "lasso" || id === "polygon") app.lassoKind = id;
    if (id === "brush" || id === "eraser") app.brushKind = id;
    app.tool = id;
    app.persistPrefs();
  }

  function pickMode(id: SelectMode) {
    app.selectMode = id;
    app.persistPrefs();
  }

  function toggleMenu(id: string, e: MouseEvent) {
    // the click that opened it lands outside the menu: don't reopen what that click just closed
    if (menuClosed.id === id && performance.now() - menuClosed.at < 400) return;
    if (menu?.id === id) {
      menu = null;
      return;
    }
    const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    menu = { id, x: Math.max(4, Math.min(at.left - box.left - 40, box.width - 220)), y: at.bottom - box.top + 4 };
  }

  // Press and hold a tool to see its group, as in Photoshop
  let holdTimer = 0;
  function holdStart(id: string, e: PointerEvent) {
    clearTimeout(holdTimer);
    const target = e.currentTarget as HTMLElement;
    holdTimer = window.setTimeout(() => {
      if (menu?.id !== id) toggleMenu(id, { currentTarget: target } as unknown as MouseEvent);
    }, 450);
  }
  const holdEnd = () => clearTimeout(holdTimer);

  function onToolClick(g: (typeof groups)[number], v: Variant, e: MouseEvent) {
    // touch has no right click and the corner is small: tapping the active tool opens its group
    if (coarse && g.variants.length > 1 && app.tool === v.tool && menu?.id !== g.id) {
      toggleMenu(g.id, e);
      return;
    }
    pickTool(v.tool);
  }

  function closeMenu(e?: Event) {
    // a press outside may be on the button that opened the menu: its click mustn't reopen it
    if (menu && e?.type === "pointerdown") menuClosed = { id: menu.id, at: performance.now() };
    menu = null;
  }

  // -- the toolbar fits its width: it drops what matters least, one step at a time --------
  // 1 zoom buttons, 2 tool names, 3 the names on Compare and the like (shorter for the output switch), 4 selection modes fold
  // into a menu, 5 a shorter brush slider, 6 a second row for the view controls. Measured, not
  // guessed: widths differ by language. Nothing is ever cut off or scrolled away.
  const FIT_MAX = 6;
  let fitLevel = $state(0);
  let fitRun = 0;

  /**
   * ``fresh``: start over (the width or the buttons changed). A tool switch starts over too, but
   * keeps a second row once there is one, so the canvas doesn't change height as tools change.
   */
  async function fitToolbar(fresh: boolean) {
    const run = ++fitRun;
    const floor = !fresh && fitLevel >= FIT_MAX ? FIT_MAX : 0;
    fitLevel = floor;
    await tick();
    // all of this happens before the browser paints, so the steps never show
    while (run === fitRun && toolbar && toolbar.scrollWidth > toolbar.clientWidth && fitLevel < FIT_MAX) {
      fitLevel++;
      await tick();
    }
  }

  $effect(() => {
    void [editing, comparing, altSha, app.parentNode?.id, app.madeWithRegions.length, app.layout, i18n.lang, app.compare, viewing];
    untrack(() => void fitToolbar(true));
  });

  // a tool switch adds or removes the slider and the modes
  $effect(() => {
    void app.tool;
    untrack(() => void fitToolbar(false));
  });

  // -- image loading ------------------------------------------------------
  // Reload only when the image or its size changes (starring doesn't flicker)
  const shownKey = $derived(dims && shownSha ? `${shownSha}@${dims.width}x${dims.height}` : "");
  const parentSha = $derived(comparing ? (app.parentNode?.image ?? null) : null);

  $effect(() => {
    const key = shownKey;
    image = null;
    preview = null;
    if (!key) {
      shownDims = "";
      return;
    }
    const [sha, dims] = key.split("@");
    // Refit for an image of another size; keep the view for the same size
    // (between variants, say) so they can be compared in place
    if (dims !== shownDims) {
      shownDims = dims;
      fitted = true;
      untrack(fit);
    }
    let cancelled = false;
    loadImage(sha, true).then((img) => !cancelled && !image && (preview = img), () => {});
    loadImage(sha).then(
      (img) => !cancelled && (image = img),
      (e: Error) => !cancelled && app.notify(e.message, true),
    );
    return () => (cancelled = true);
  });

  $effect(() => {
    const sha = partSha;
    partImage = null;
    if (!sha) return;
    let cancelled = false;
    loadImage(sha).then(
      (img) => !cancelled && (partImage = img),
      (e: Error) => !cancelled && app.notify(e.message, true),
    );
    return () => (cancelled = true);
  });

  $effect(() => {
    const sha = parentSha;
    parentImage = null;
    if (!sha) return;
    let cancelled = false;
    loadImage(sha).then((img) => !cancelled && (parentImage = img), () => {});
    return () => (cancelled = true);
  });

  // A polygon in progress belongs to this version and this tool
  $effect(() => {
    void [app.tool, node?.id, editing, comparing];
    untrack(cancelPolygon);
  });

  // While a drag is under way the app's keys wait, and a finished job doesn't change the version
  $effect(() => {
    app.gestureOpen = gesture !== null;
  });

  // -- view ---------------------------------------------------------------
  /**
   * The image can be scrolled until an edge reaches the middle of the view, no further (as
   * Photoshop's overscroll): some of it always stays in sight.
   */
  function setView(v: { scale: number; x: number; y: number }) {
    if (dims && width && height) {
      const w = dims.width * v.scale;
      const h = dims.height * v.scale;
      v = { scale: v.scale, x: Math.min(width / 2, Math.max(width / 2 - w, v.x)), y: Math.min(height / 2, Math.max(height / 2 - h, v.y)) };
    }
    view = v;
    app.zoom = v.scale;
  }

  function scrollBy(dx: number, dy: number) {
    setView({ ...view, x: view.x - dx, y: view.y - dy });
    fitted = false;
  }

  // Photoshop's zoom levels, which the zoom keys and buttons step through
  const ZOOM_STEPS = [0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32];

  function zoomStep(dir: 1 | -1) {
    const s = view.scale;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > s * 1.001) : [...ZOOM_STEPS].reverse().find((z) => z < s / 1.001);
    if (next) zoomAt(next / s, width / 2, height / 2);
  }

  function fit() {
    if (!dims || !width || !height) return;
    const pad = narrow ? 12 : 28;
    const scale = Math.min((width - pad * 2) / dims.width, (height - pad * 2) / dims.height, 4);
    setView({ scale, x: (width - dims.width * scale) / 2, y: (height - dims.height * scale) / 2 });
  }

  function zoomAt(factor: number, sx: number, sy: number) {
    const scale = Math.max(0.02, Math.min(32, view.scale * factor));
    const k = scale / view.scale;
    setView({ scale, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k });
    fitted = false;
  }

  const actualSize = () => zoomAt(1 / view.scale, width / 2, height / 2);
  const refit = () => {
    fitted = true;
    fit();
  };

  const toImage = (sx: number, sy: number): Point => [(sx - view.x) / view.scale, (sy - view.y) / view.scale];
  const toScreen = ([ix, iy]: Point): Point => [view.x + ix * view.scale, view.y + iy * view.scale];

  onMount(() => {
    ctx = canvas.getContext("2d")!;
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (fitted) fit();
    });
    observer.observe(viewport);
    let lastWidth = 0;
    const toolbarObserver = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - lastWidth) < 1) return;
      lastWidth = entry.contentRect.width;
      void fitToolbar(true);
    });
    toolbarObserver.observe(toolbar);
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) viewport.addEventListener(type, onGesture);
    // Redraw when the system theme flips (checkerboard colors come from CSS)
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const redraw = () => requestAnimationFrame(draw);
    scheme.addEventListener("change", redraw);
    return () => {
      observer.disconnect();
      toolbarObserver.disconnect();
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) viewport.removeEventListener(type, onGesture);
      scheme.removeEventListener("change", redraw);
    };
  });

  // -- drawing ------------------------------------------------------------
  let frame = 0;
  $effect(() => {
    // Read everything the picture depends on; redraw when any of it changes
    void [view.scale, view.x, view.y, width, height, image, preview, parentImage, partImage, partBox, split, hover, drawing, comparing, poly];
    void [app.selectedRegion, app.tool, app.brushSize, app.theme, editing, spaceHeld, gesture, madeWith, mods.shift, mods.alt];
    void $state.snapshot(app.draft.regions);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });

  let checker: { key: string; pattern: CanvasPattern | null } = { key: "", pattern: null };

  function checkerPattern(): CanvasPattern | string {
    const css = getComputedStyle(document.documentElement);
    const a = css.getPropertyValue("--checker-a").trim();
    const b = css.getPropertyValue("--checker-b").trim();
    if (checker.key !== a + b) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 16;
      const t = tile.getContext("2d")!;
      t.fillStyle = b;
      t.fillRect(0, 0, 16, 16);
      t.fillStyle = a;
      t.fillRect(0, 0, 8, 8);
      t.fillRect(8, 8, 8, 8);
      checker = { key: a + b, pattern: ctx.createPattern(tile, "repeat") };
    }
    return checker.pattern ?? "#888";
  }

  function traceShape(c: CanvasRenderingContext2D, shape: Shape) {
    c.beginPath();
    if (shape.type === "rect") {
      const [x, y] = toScreen([shape.x, shape.y]);
      c.rect(x, y, shape.w * view.scale, shape.h * view.scale);
      return;
    }
    if (shape.type === "ellipse") {
      const [x, y] = toScreen([shape.x + shape.w / 2, shape.y + shape.h / 2]);
      c.ellipse(x, y, Math.max(0.1, (shape.w / 2) * view.scale), Math.max(0.1, (shape.h / 2) * view.scale), 0, 0, Math.PI * 2);
      return;
    }
    shape.points.forEach((p, i) => {
      const [x, y] = toScreen(p);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    if (shape.type === "lasso") c.closePath();
    else if (shape.points.length === 1) c.lineTo(...toScreen([shape.points[0][0] + 0.01, shape.points[0][1]]));
  }

  function paintShape(c: CanvasRenderingContext2D, shape: Shape, color: string) {
    traceShape(c, shape);
    if (shape.type === "brush") {
      c.strokeStyle = color;
      c.lineWidth = shape.radius * 2 * view.scale;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.stroke();
    } else {
      c.fillStyle = color;
      c.fill();
    }
  }

  // Regions are drawn as what they select: their shapes combined in order (an added
  // shape paints, a subtracted one cuts out, an intersecting one keeps only its inside),
  // then tinted and outlined along the result. Each region is drawn into a small canvas
  // around its box, kept until it or the view changes.
  interface Layer {
    key: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fill: HTMLCanvasElement;
    edges: HTMLCanvasElement[];
  }
  const layers = new Map<string, Layer>();
  let stripes: { dpr: number; tile: HTMLCanvasElement } | null = null;

  function stripeTile(dpr: number): HTMLCanvasElement {
    if (stripes?.dpr === dpr) return stripes.tile;
    // diagonal bands, half on and half off: an edge masked by them reads as a dashed line in every direction
    const n = Math.round(10 * dpr);
    const tile = document.createElement("canvas");
    tile.width = tile.height = n;
    const c = tile.getContext("2d")!;
    c.fillStyle = "#000";
    for (const k of [-1, 0, 1]) {
      c.beginPath();
      c.moveTo(k * n, 0);
      c.lineTo(k * n + n / 2, 0);
      c.lineTo(k * n + n / 2 + n, n);
      c.lineTo(k * n + n, n);
      c.closePath();
      c.fill();
    }
    stripes = { dpr, tile };
    return tile;
  }

  const blank = (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };

  /** the outline of a mask canvas: the mask minus itself shrunk by ``px`` device pixels */
  function edgeOf(mask: HTMLCanvasElement, px: number, color: string, dashed: boolean): HTMLCanvasElement {
    const shrunk = blank(mask.width, mask.height);
    const s = shrunk.getContext("2d")!;
    s.drawImage(mask, 0, 0);
    s.globalCompositeOperation = "destination-in";
    const d = Math.round(px * 0.7);
    for (const [dx, dy] of [[px, 0], [-px, 0], [0, px], [0, -px], [d, d], [-d, d], [d, -d], [-d, -d]]) s.drawImage(mask, dx, dy);
    const edge = blank(mask.width, mask.height);
    const g = edge.getContext("2d")!;
    g.drawImage(mask, 0, 0);
    g.globalCompositeOperation = "destination-out";
    g.drawImage(shrunk, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, edge.width, edge.height);
    if (dashed) {
      g.globalCompositeOperation = "destination-in";
      g.fillStyle = g.createPattern(stripeTile(window.devicePixelRatio || 1), "repeat")!;
      g.fillRect(0, 0, edge.width, edge.height);
    }
    return edge;
  }

  type Look = "selected" | "region" | "madeWith";

  function regionLayer(id: string, region: Region, color: string, look: Look): Layer | null {
    const box = regionBox(region);
    if (!box) return null;
    const dpr = window.devicePixelRatio || 1;
    const [ax, ay] = toScreen([box.x0, box.y0]);
    const [bx, by] = toScreen([box.x1, box.y1]);
    // a margin for the outline, and a little past the viewport so its edge doesn't count as one
    const x0 = Math.floor(Math.max(ax - 6, -12));
    const y0 = Math.floor(Math.max(ay - 6, -12));
    const x1 = Math.ceil(Math.min(bx + 6, width + 12));
    const y1 = Math.ceil(Math.min(by + 6, height + 12));
    if (x1 <= x0 || y1 <= y0) return null;
    const key = JSON.stringify([region.shapes, color, look, view, width, height, dpr]);
    const cached = layers.get(id);
    if (cached?.key === key) return cached;

    const mask = blank(Math.ceil((x1 - x0) * dpr), Math.ceil((y1 - y0) * dpr));
    const m = mask.getContext("2d")!;
    m.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);
    for (const s of region.shapes) {
      const op = s.op ?? "add";
      m.globalCompositeOperation = op === "add" ? "source-over" : op === "subtract" ? "destination-out" : "destination-in";
      paintShape(m, s, "#fff");
    }
    const fill = blank(mask.width, mask.height);
    const f = fill.getContext("2d")!;
    f.drawImage(mask, 0, 0);
    f.globalCompositeOperation = "source-in";
    f.fillStyle = color;
    f.fillRect(0, 0, fill.width, fill.height);
    const edges =
      look === "selected"
        ? [edgeOf(mask, Math.round(3 * dpr), "rgb(255 255 255 / 0.9)", false), edgeOf(mask, Math.round(2 * dpr), color, false)]
        : look === "region"
          ? [edgeOf(mask, Math.max(1, Math.round(1.5 * dpr)), color, true)]
          : [edgeOf(mask, Math.round(3 * dpr), "rgb(255 255 255 / 0.85)", true), edgeOf(mask, Math.max(1, Math.round(1.5 * dpr)), color, true)];
    const layer = { key, x: x0, y: y0, w: x1 - x0, h: y1 - y0, fill, edges };
    layers.set(id, layer);
    return layer;
  }

  function drawRegions(regions: Region[], prefix: string, look: (i: number) => Look, alpha: number) {
    regions.forEach((r, i) => {
      const layer = regionLayer(`${prefix}${i}`, r, app.regionColor(i), look(i));
      if (!layer) return;
      ctx.globalAlpha = alpha;
      ctx.drawImage(layer.fill, layer.x, layer.y, layer.w, layer.h);
      ctx.globalAlpha = 1;
      for (const e of layer.edges) ctx.drawImage(e, layer.x, layer.y, layer.w, layer.h);
    });
    for (const key of [...layers.keys()]) {
      if (key.startsWith(prefix) && Number(key.slice(prefix.length)) >= regions.length) layers.delete(key);
    }
    regions.forEach((r, i) => {
      const box = regionBox(r);
      if (!box) return;
      const [x, y] = toScreen([box.x0, box.y0]);
      // the selected region shows resize handles at its corners: its number moves off them
      const off = prefix === "r" && i === app.selectedRegion && handleBox ? 16 : 0;
      badge(i + 1, app.regionColor(i), [x - off, y - off], look(i) === "selected");
    });
  }

  /** the regions as they'll be once the shape being drawn is applied: what you see is what you get */
  function withDrawing(regions: Region[]): Region[] {
    if (!drawing || gesture?.kind !== "draw") return regions;
    const shape = drawing;
    if (shape.type === "lasso" && shape.points.length < 3) return regions;
    if ((shape.type === "rect" || shape.type === "ellipse") && (Math.abs(shape.w) < 1 || Math.abs(shape.h) < 1)) return regions;
    const mode = gesture.mode;
    const sel = regions[app.selectedRegion] ? app.selectedRegion : -1;
    if (mode === "new" || (mode === "add" && sel < 0)) return [...regions, { shapes: [shape], instruction: "" }];
    if (mode === "add") return regions.map((r, i) => (i === sel ? { ...r, shapes: [...r.shapes, shape] } : r));
    return regions.map((r, i) => (sel < 0 || i === sel ? { ...r, shapes: [...r.shapes, { ...shape, op: mode }] } : r));
  }

  /** marching-ants style line along a shape being drawn (it may cut outside every region) */
  function antsPath(path: () => void) {
    path();
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgb(255 255 255 / 0.95)";
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgb(20 23 27 / 0.9)";
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** the selected region's box and handles, for the move tool */
  const handleBox = $derived.by((): Box | null => {
    if (!editing || comparing || app.tool !== "select" || drawing) return null;
    const region = app.draft.regions[app.selectedRegion];
    return region ? regionBox(region) : null;
  });
  const handleSize = coarse ? 11 : 7;

  function handleAt(p: Point): Handle | null {
    if (!handleBox) return null;
    const reach = coarse ? 18 : 9;
    // The handles crowd a small region: a press inside it moves it instead
    const small = Math.min(handleBox.x1 - handleBox.x0, handleBox.y1 - handleBox.y0) * view.scale < 4 * reach;
    const region = app.draft.regions[app.selectedRegion];
    if (small && region && inRegion(toImage(...p), region)) return null;
    for (const h of HANDLES) {
      const [x, y] = toScreen(handlePoint(handleBox, h));
      if (Math.abs(p[0] - x) <= reach && Math.abs(p[1] - y) <= reach) return h;
    }
    return null;
  }

  function draw() {
    if (!ctx || !width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!node) return;

    const w = dims!.width * view.scale;
    const h = dims!.height * view.scale;
    const src = image ?? preview;
    ctx.save();
    ctx.shadowColor = "rgb(0 0 0 / 0.22)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = checkerPattern();
    ctx.fillRect(view.x, view.y, w, h);
    ctx.restore();
    // No smoothing once individual pixels are visible
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.imageSmoothingQuality = "high";
    if (src) ctx.drawImage(src, view.x, view.y, w, h);
    if (part && partImage) {
      const [px, py] = partAt;
      ctx.drawImage(partImage, view.x + px * view.scale, view.y + py * view.scale, partImage.naturalWidth * view.scale, partImage.naturalHeight * view.scale);
    }
    ctx.imageSmoothingEnabled = true;
    if (part && partBox) {
      // what the close-up took in
      const [x0, y0, x1, y1] = partBox;
      const r = [view.x + x0 * view.scale, view.y + y0 * view.scale, (x1 - x0) * view.scale, (y1 - y0) * view.scale] as const;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "rgb(0 0 0 / 0.6)";
      ctx.strokeRect(r[0] - 0.5, r[1] - 0.5, r[2] + 1, r[3] + 1);
      ctx.strokeStyle = "rgb(255 255 255 / 0.9)";
      ctx.lineDashOffset = 5;
      ctx.strokeRect(r[0] - 0.5, r[1] - 0.5, r[2] + 1, r[3] + 1);
      ctx.restore();
    }

    if (comparing) {
      drawCompare(w, h);
      return;
    }
    if (madeWith.length) drawRegions(madeWith, "m", () => "madeWith", 0.1);
    if (!editing) return;

    const regions = withDrawing(app.draft.regions);
    drawRegions(regions, "r", (i) => (i === app.selectedRegion || (i === app.draft.regions.length && gesture?.kind === "draw") ? "selected" : "region"), 0.28);

    if (drawing && drawing.type !== "brush") antsPath(() => traceShape(ctx, drawing!));
    if (poly) drawPolygon();
    if (handleBox) drawHandles(handleBox);

    if ((app.tool === "brush" || app.tool === "eraser") && hover && !spaceHeld && (!gesture || gesture.kind === "draw")) {
      const eraser = liveMode === "subtract";
      // the brush's diameter is in image pixels: its ring grows as you zoom in, as in Photoshop
      const r = Math.max(2, (app.brushSize / 2) * view.scale);
      const rings = [
        ["rgb(0 0 0 / 0.55)", r + 1],
        ["rgb(255 255 255 / 0.95)", r],
      ] as const;
      for (const [color, r] of rings) {
        ctx.beginPath();
        ctx.arc(hover[0], hover[1], r, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(eraser ? [3, 3] : []);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (liveMode !== "new" && liveMode !== "add") modeGlyph(hover[0] + r * 0.72, hover[1] + r * 0.72, liveMode);
    }
  }

  function drawPolygon() {
    if (!poly) return;
    const pts = poly.points.map(toScreen);
    const tip = hover && !coarse ? (mods.shift ? toScreen(snap45(poly.points.at(-1)!, toImage(...hover))) : hover) : null;
    antsPath(() => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (tip) ctx.lineTo(...tip);
    });
    const closing = !!tip && pts.length >= 3 && Math.hypot(tip[0] - pts[0][0], tip[1] - pts[0][1]) <= (coarse ? 18 : 9);
    pts.forEach(([x, y], i) => {
      const r = i === 0 ? (closing ? 6 : 4.5) : 3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "#fff" : "rgb(20 23 27 / 0.85)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = i === 0 ? "rgb(20 23 27 / 0.9)" : "#fff";
      ctx.stroke();
    });
  }

  function drawHandles(box: Box) {
    const [x0, y0] = toScreen([box.x0, box.y0]);
    const [x1, y1] = toScreen([box.x1, box.y1]);
    ctx.strokeStyle = "rgb(20 23 27 / 0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
    ctx.setLineDash([]);
    for (const h of HANDLES) {
      const [x, y] = toScreen(handlePoint(box, h));
      const s = handleSize;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgb(20 23 27 / 0.85)";
      ctx.lineWidth = 1;
      ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
      ctx.strokeRect(Math.round(x - s / 2) + 0.5, Math.round(y - s / 2) + 0.5, s - 1, s - 1);
    }
  }

  /** the small +, − or × beside a cursor that says what the next shape does */
  function modeGlyph(x: number, y: number, mode: SelectMode) {
    ctx.save();
    ctx.lineCap = "round";
    for (const [color, lw] of [["#fff", 3.5], ["rgb(20 23 27)", 1.5]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      if (mode === "intersect") {
        ctx.moveTo(x - 3.5, y - 3.5);
        ctx.lineTo(x + 3.5, y + 3.5);
        ctx.moveTo(x + 3.5, y - 3.5);
        ctx.lineTo(x - 3.5, y + 3.5);
      } else {
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        if (mode === "add") {
          ctx.moveTo(x, y - 4);
          ctx.lineTo(x, y + 4);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCompare(w: number, h: number) {
    const sx = split * width;
    if (parentImage) {
      // A different aspect (gemini's squares) is fitted into the frame, not stretched
      const k = Math.min(w / parentImage.naturalWidth, h / parentImage.naturalHeight);
      const pw = parentImage.naturalWidth * k;
      const ph = parentImage.naturalHeight * k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, sx, height);
      ctx.clip();
      ctx.fillStyle = checkerPattern();
      ctx.fillRect(view.x, view.y, w, h);
      ctx.drawImage(parentImage, view.x + (w - pw) / 2, view.y + (h - ph) / 2, pw, ph);
      ctx.restore();
    }
    ctx.fillStyle = "rgb(255 255 255 / 0.95)";
    ctx.fillRect(Math.round(sx) - 1, 0, 2, height);
    ctx.beginPath();
    ctx.arc(sx, height / 2, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgb(0 0 0 / 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#1d2125";
    ctx.beginPath();
    for (const dir of [-1, 1]) {
      ctx.moveTo(sx + dir * 3, height / 2 - 4);
      ctx.lineTo(sx + dir * 7, height / 2);
      ctx.lineTo(sx + dir * 3, height / 2 + 4);
    }
    ctx.fill();
    const parentVer = app.parentNode ? app.versions[app.parentNode.id] : "";
    label(t("canvas.labelPrevious", { v: parentVer }), sx - 10, "right");
    label(app.showAlt ? t("canvas.labelAlt", { v: version, alt: altLabel }) : t("canvas.labelThis", { v: version }), sx + 10, "left");
  }

  function badge(n: number, color: string, [x, y]: Point, selected: boolean) {
    const r = selected ? 11 : 9.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = "white";
    ctx.stroke();
    ctx.fillStyle = "white";
    ctx.font = `600 ${selected ? 12.5 : 11.5}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), x, y + 0.5);
  }

  function label(text: string, x: number, align: "left" | "right") {
    ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    const m = ctx.measureText(text).width;
    const left = align === "right" ? x - m - 16 : x;
    ctx.fillStyle = "rgb(20 23 27 / 0.66)";
    ctx.beginPath();
    ctx.roundRect(left, 10, m + 16, 22, 4);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + 8, 21.5);
  }

  // -- interaction --------------------------------------------------------
  function local(e: PointerEvent | WheelEvent): Point {
    const rect = viewport.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    // the first finger's move or resize was the start of the pinch: undo it
    if (gesture?.kind === "move" || gesture?.kind === "scale") app.cancelChange();
    drawing = null;
    gesture = {
      kind: "pinch",
      dist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])),
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      view: { ...view },
    };
  }

  /** the mode a shape started with these keys gets */
  function modeFor(e: { shiftKey: boolean; altKey: boolean }): SelectMode {
    if (app.tool === "eraser") return "subtract";
    if (e.shiftKey && e.altKey) return "intersect";
    if (e.shiftKey) return "add";
    if (e.altKey) return "subtract";
    return app.selectMode;
  }

  // -- polygonal lasso: click corners; click the first one, double-click or Enter to close
  function polygonTap(p: Point, e: { shiftKey: boolean; altKey: boolean }) {
    const now = performance.now();
    let ip = toImage(...p);
    if (!poly) {
      poly = { points: [ip], mode: modeFor(e), lastTap: { at: now, p } };
      app.polygonOpen = true;
      return;
    }
    const first = toScreen(poly.points[0]);
    const reach = coarse ? 18 : 9;
    const double = now - poly.lastTap.at < 350 && Math.hypot(p[0] - poly.lastTap.p[0], p[1] - poly.lastTap.p[1]) < 8;
    if ((poly.points.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) <= reach) || double) {
      finishPolygon();
      return;
    }
    if (e.shiftKey) ip = snap45(poly.points.at(-1)!, ip);
    poly = { ...poly, points: [...poly.points, ip], lastTap: { at: now, p } };
  }

  function finishPolygon() {
    if (!poly || !node) return cancelPolygon();
    const shape = poly.points.length >= 3 ? clampShape({ type: "lasso", points: poly.points }, node.width, node.height) : null;
    const mode = poly.mode;
    cancelPolygon();
    if (shape && selectsInImage(shape, node.width, node.height)) app.applyShape(shape, mode);
  }

  function cancelPolygon() {
    poly = null;
    app.polygonOpen = false;
  }

  function onPointerDown(e: PointerEvent) {
    // a pen's eraser end erases, as in Photoshop
    const penEraser = e.pointerType === "pen" && e.button === 5;
    if (!node || (e.button !== 0 && e.button !== 1 && !penEraser)) return;
    if (penEraser && !(editing && !comparing && (app.tool === "brush" || app.tool === "eraser"))) return;
    // the canvas takes the keyboard (out of a text box, off a button), as Photoshop's does
    viewport.focus({ preventScroll: true });
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events have no real pointer
    }
    const p = local(e);
    pointers.set(e.pointerId, p);
    mods = { shift: e.shiftKey, alt: e.altKey };
    if (pointers.size === 2) {
      // A second finger: drop the shape being drawn, pinch to zoom and pan
      startPinch();
      return;
    }
    if (pointers.size > 2) return;

    const origin = { x: view.x, y: view.y };
    const ip = toImage(...p);
    if (e.button === 1 || spaceHeld) {
      gesture = { kind: "pan", start: p, origin };
    } else if (comparing) {
      gesture = { kind: "split" };
      split = Math.min(1, Math.max(0, p[0] / width));
    } else if (!editing || app.tool === "select") {
      const handle = editing ? handleAt(p) : null;
      if (handle && handleBox) {
        app.beginChange();
        const region = app.draft.regions[app.selectedRegion];
        gesture = { kind: "scale", region: app.selectedRegion, handle, from: handleBox, shapes: $state.snapshot(region.shapes) as Shape[] };
        return;
      }
      const hit = editing ? hitRegion(ip, app.draft.regions) : -1;
      app.selectedRegion = hit;
      if (hit >= 0) app.beginChange();
      gesture = hit >= 0
        ? { kind: "move", region: hit, start: ip, last: ip, shapes: $state.snapshot(app.draft.regions[hit].shapes) as Shape[] }
        : { kind: "pan", start: p, origin };
    } else if (app.tool === "polygon") {
      gesture = { kind: "tap", start: p };
    } else {
      const mode = penEraser ? "subtract" : modeFor(e);
      gesture = { kind: "draw", mode, start: ip, last: ip, startShift: e.shiftKey, startAlt: e.altKey, shiftUp: false, altUp: false };
      if (app.tool === "rect" || app.tool === "ellipse") drawing = { type: app.tool, x: ip[0], y: ip[1], w: 0, h: 0 };
      else if (app.tool === "lasso") drawing = { type: "lasso", points: [ip] };
      else drawing = { type: "brush", points: [ip], radius: app.brushSize / 2 };
    }
  }

  function onPointerMove(e: PointerEvent) {
    const p = local(e);
    // a mouse or a pen shows where it is (the brush ring, the resize cursors); a finger doesn't
    if (e.pointerType !== "touch") hover = p;
    if (mods.shift !== e.shiftKey || mods.alt !== e.altKey) mods = { shift: e.shiftKey, alt: e.altKey };
    app.cursor = node ? toImage(...p) : null;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, p);
    if (!gesture) return;

    if (gesture.kind === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const g = gesture;
      const scale = Math.max(0.02, Math.min(32, g.view.scale * (dist / g.dist)));
      // Keep the image point under the starting midpoint under the fingers:
      // zooms and pans in one go
      const ix = (g.mid[0] - g.view.x) / g.view.scale;
      const iy = (g.mid[1] - g.view.y) / g.view.scale;
      setView({ scale, x: mid[0] - ix * scale, y: mid[1] - iy * scale });
      fitted = false;
    } else if (gesture.kind === "pan") {
      setView({ ...view, x: gesture.origin.x + p[0] - gesture.start[0], y: gesture.origin.y + p[1] - gesture.start[1] });
      fitted = false;
    } else if (gesture.kind === "split") {
      split = Math.min(1, Math.max(0, p[0] / width));
    } else if (gesture.kind === "move") {
      moveTo(toImage(...p), e.shiftKey);
    } else if (gesture.kind === "scale") {
      const to = resizeBox(gesture.from, gesture.handle, toImage(...p), e.shiftKey, e.altKey, 4);
      app.setShapes(gesture.region, transformShapes(gesture.shapes, gesture.from, to));
    } else if (gesture.kind === "draw") {
      drawTo(toImage(...p), e.shiftKey, e.altKey);
    }
  }

  /** The region being moved, at ``ip``; Shift keeps the move horizontal, vertical or at 45°, as in Photoshop. */
  function moveTo(ip: Point, shift: boolean) {
    if (gesture?.kind !== "move") return;
    const g = gesture;
    g.last = ip;
    let [dx, dy] = [ip[0] - g.start[0], ip[1] - g.start[1]];
    if (shift) [dx, dy] = snap45([0, 0], [dx, dy]);
    const from = shapesBox(g.shapes);
    if (from) app.setShapes(g.region, transformShapes(g.shapes, from, { x0: from.x0 + dx, y0: from.y0 + dy, x1: from.x1 + dx, y1: from.y1 + dy }));
  }

  /** The shape being drawn, out to ``ip`` with these keys held (also called as a key goes down or up). */
  function drawTo(ip: Point, shift: boolean, alt: boolean) {
    if (gesture?.kind !== "draw" || !drawing) return;
    const g = gesture;
    // As in Photoshop: the key that picked the mode must be let go and pressed again to constrain
    if (g.startShift && !shift) g.shiftUp = true;
    if (g.startAlt && !alt) g.altUp = true;
    if (drawing.type === "rect" || drawing.type === "ellipse") {
      // Space held: the marquee moves instead of growing
      if (spaceHeld) g.start = [g.start[0] + ip[0] - g.last[0], g.start[1] + ip[1] - g.last[1]];
      const square = shift && (!g.startShift || g.shiftUp);
      const centered = alt && (!g.startAlt || g.altUp);
      const box = dragBox(g.start, ip, square, centered);
      drawing = { type: drawing.type, x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
    } else {
      const last = drawing.points[drawing.points.length - 1];
      // sample about every 2 screen pixels
      if (Math.hypot(ip[0] - last[0], ip[1] - last[1]) * view.scale >= 2) {
        drawing = { ...drawing, points: [...drawing.points, ip] } as Shape;
      }
    }
    g.last = ip;
  }

  /** Esc, a lost pointer or a lost window: drop the drag under way, changing nothing. */
  function cancelGesture() {
    if (gesture?.kind === "move" || gesture?.kind === "scale") app.cancelChange();
    drawing = null;
    gesture = null;
    pointers.clear();
  }

  function onPointerCancel(e: PointerEvent) {
    if (gesture?.kind === "pinch") return onPointerUp(e);
    pointers.delete(e.pointerId);
    cancelGesture();
  }

  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (gesture?.kind === "pinch") {
      // Lifting one finger doesn't start drawing; wait for both
      if (!pointers.size) gesture = null;
      return;
    }
    if (gesture?.kind === "tap") {
      const p = local(e);
      if (Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) < 10) polygonTap(p, e);
    } else if (gesture?.kind === "move" || gesture?.kind === "scale") {
      app.endChange();
    } else if (gesture?.kind === "draw" && drawing && node) {
      let shape: Shape | null = drawing;
      if (shape.type === "lasso" || shape.type === "brush") shape = { ...shape, points: simplify(shape.points, 1.5 / view.scale) };
      shape = clampShape(shape, node.width, node.height);
      let mode = gesture.mode;
      // Painting on from the selected region carries it on (Photoshop's Quick Selection brush adds
      // after the first stroke); a stroke elsewhere starts a region of its own
      const selected = app.draft.regions[app.selectedRegion];
      if (shape?.type === "brush" && mode === "new" && app.tool === "brush" && selected && shape.points.some((q) => inRegion(q, selected))) {
        mode = "add";
      }
      if (shape && selectsInImage(shape, node.width, node.height)) app.applyShape(shape, mode);
      else if (!shape && drawing.type !== "brush") {
        // a click with a marquee or the lasso: select the region under it, or none (Photoshop deselects)
        app.selectedRegion = hitRegion(toImage(...local(e)), app.draft.regions);
      }
    }
    drawing = null;
    gesture = null;
  }

  // -- the wheel and the trackpad, as in Photoshop -----------------------------
  // The wheel scrolls the image up and down; with Shift, or Ctrl (⌘ on a Mac), left and right;
  // with Alt (⌥) it zooms about the pointer. "Zoom with scroll wheel" in Settings swaps scrolling
  // and zooming, like the Photoshop preference. A trackpad pans with two fingers and zooms with a
  // pinch, which Chrome, Edge and Firefox send as a wheel event with ctrlKey set while no Ctrl key
  // is down, and Safari as gesture events.
  let ctrlDown = false;
  let gesturing = false;

  function onWheel(e: WheelEvent) {
    if (!node) return;
    e.preventDefault();
    const [sx, sy] = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey && !ctrlDown && !e.metaKey) {
      if (!gesturing) zoomAt(Math.exp(-dy * 0.01), sx, sy);
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      scrollBy(dx || dy, 0);
    } else if (e.altKey !== app.wheelZoom) {
      // about a fifth per notch of a mouse wheel; a trackpad's small steps zoom smoothly
      zoomAt(Math.exp(-Math.max(-100, Math.min(100, dy || dx)) * 0.002), sx, sy);
    } else {
      scrollBy(dx, dy);
    }
  }

  /** Safari's trackpad pinch (two fingers on a touch screen are pointers, handled with those) */
  function onGesture(e: Event) {
    e.preventDefault();
    const g = e as Event & { scale: number; clientX: number; clientY: number };
    if (e.type === "gesturestart") {
      gesturing = true;
      gestureScale = 1;
    } else if (e.type === "gestureend") {
      gesturing = false;
    } else if (node && pointers.size < 2) {
      const box = viewport.getBoundingClientRect();
      zoomAt(g.scale / gestureScale, g.clientX - box.left, g.clientY - box.top);
      gestureScale = g.scale;
    }
  }
  let gestureScale = 1;

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Shift" || e.key === "Alt") {
      mods = { shift: e.shiftKey, alt: e.altKey };
      // a marquee being dragged follows the keys at once (square, from the centre)
      if (gesture?.kind === "draw") drawTo(gesture.last, e.shiftKey, e.altKey);
      if (gesture?.kind === "move") moveTo(gesture.last, e.shiftKey);
    }
    if (e.key === "Control") ctrlDown = true;
    if (dialogs.current || app.settingsOpen || forControl(e)) return;
    // Alt alone opens the menu bar in some browsers; here it picks a selection mode and zooms
    if (e.key === "Alt" && node) e.preventDefault();
    if (gesture && e.key === "Escape") {
      // as in Photoshop: Esc drops the drag under way
      e.preventDefault();
      cancelGesture();
      return;
    }
    if (poly && (e.metaKey || e.ctrlKey)) {
      // ⌘Z takes back the last corner, ⌘D drops the polygon; nothing else of the app's (nor
      // the browser's ⌘D bookmark) while it is open
      const k = e.key.toLowerCase();
      if (k === "z" || k === "d" || k === "a" || k === "y") {
        e.preventDefault();
        if (k === "d") cancelPolygon();
        else if (k === "z") {
          poly = poly.points.length > 1 ? { ...poly, points: poly.points.slice(0, -1) } : null;
          if (!poly) app.polygonOpen = false;
        }
        return;
      }
    }
    if (poly) {
      if (e.key === "Enter") finishPolygon();
      else if (e.key === "Escape") cancelPolygon();
      else if (e.key === "Backspace" || e.key === "Delete") {
        poly = poly.points.length > 1 ? { ...poly, points: poly.points.slice(0, -1) } : null;
        if (!poly) app.polygonOpen = false;
      } else if (e.code !== "Space") return;
      if (e.code !== "Space") {
        e.preventDefault();
        return;
      }
    }
    const mod = e.metaKey || e.ctrlKey;
    // Zoom as in Photoshop: ⌘/Ctrl with 0, 1, + and −, or the keys alone
    const zoomKey = (k: string) => {
      if (k === "0") refit();
      else if (k === "1") actualSize();
      else if (k === "=" || k === "+") zoomStep(1);
      else if (k === "-") zoomStep(-1);
      else return false;
      return true;
    };
    // Page Up and Page Down scroll a screen (Shift: 10 px), Home and End go to the corners
    if (node && !mod && !e.altKey && ["PageUp", "PageDown", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const page = e.shiftKey ? 10 : height * 0.9;
      if (e.key === "PageUp") scrollBy(0, -page);
      else if (e.key === "PageDown") scrollBy(0, page);
      else {
        const end = e.key === "End";
        setView({ ...view, x: end ? width - dims!.width * view.scale : 0, y: end ? height - dims!.height * view.scale : 0 });
        fitted = false;
      }
      return;
    }
    if (mod && !e.altKey) {
      if (node && zoomKey(e.key)) e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space" && !e.repeat) {
      spaceHeld = true;
      e.preventDefault();
    } else zoomKey(e.key);
  }

  function startGenerate() {
    app.setMode("generate");
    if (app.layout === "narrow") app.sheetOpen = true;
    requestAnimationFrame(() => document.getElementById("prompt")?.focus());
  }

  const RESIZE: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

  /** a crosshair with the mode's sign beside it, as Photoshop's selection cursors have */
  function crosshair(mode: SelectMode): string {
    const sign =
      mode === "add"
        ? "M17 21h6M20 18v6"
        : mode === "subtract"
          ? "M17 21h6"
          : mode === "intersect"
            ? "M17.5 18.5l5 5M22.5 18.5l-5 5"
            : "";
    const lines = `M12 2v7M12 15v7M2 12h7M15 12h7${sign ? sign.replace(/^/, "") : ""}`;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'><path d='${lines.replace(/(M)/g, " $1")}' stroke='white' stroke-width='3' stroke-linecap='round' fill='none'/><path d='${lines.replace(/(M)/g, " $1")}' stroke='black' stroke-width='1.2' stroke-linecap='round' fill='none'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
  }

  const cursorStyle = $derived.by(() => {
    if (gesture?.kind === "draw" && spaceHeld) return "move";
    if (gesture?.kind === "pan" || gesture?.kind === "pinch" || spaceHeld) return "grabbing";
    if (comparing) return "ew-resize";
    if (gesture?.kind === "move") return "move";
    if (gesture?.kind === "scale") return RESIZE[gesture.handle];
    if (!editing) return "default";
    if (app.tool === "select") {
      const h = hover && handleAt(hover);
      if (h) return RESIZE[h];
      return hover && hitRegion(toImage(...hover), app.draft.regions) >= 0 ? "move" : "default";
    }
    if (app.tool === "brush" || app.tool === "eraser") return "none";
    return crosshair(gesture?.kind === "draw" ? gesture.mode : poly ? poly.mode : liveMode);
  });

  const tip = $derived.by((): string => {
    if (viewing) return node && madeWith.length ? t(viewing.status === "failed" ? "canvas.jobFailedTip" : "canvas.jobTip") : "";
    if (!node || comparing) return "";
    if (part) return t("canvas.partTip");
    if (madeWith.length && editing) return t("canvas.madeWithTip");
    if (!editing) return "";
    if (app.tool === "polygon" && (poly || !app.draft.regions.length)) return t(coarse ? "canvas.tipPolygonTouch" : "canvas.tipPolygon");
    if (app.tool === "select" && handleBox && !coarse) return t("canvas.tipTransform", { alt: altKey });
    if (!app.draft.regions.length) return coarse ? t("canvas.tipTouch") : t("canvas.tipMouse", { alt: altKey });
    return "";
  });

  const caption = $derived(node ? app.caption(node) : "");
  const noteText = $derived(node?.note ? app.noteText(node.note) : "");
  const version = $derived(node ? app.versions[node.id] : "");
</script>

<svelte:window
  onkeydown={onKeydown}
  onkeyup={(e) => {
    if (e.code === "Space") spaceHeld = false;
    if (e.key === "Control") ctrlDown = false;
    if (e.key === "Shift" || e.key === "Alt") {
      mods = { shift: e.shiftKey, alt: e.altKey };
      if (gesture?.kind === "draw") drawTo(gesture.last, e.shiftKey, e.altKey);
      if (gesture?.kind === "move") moveTo(gesture.last, e.shiftKey);
    }
    // letting go of Alt alone moves the focus to the browser's menu on Windows
    if (e.key === "Alt" && node) e.preventDefault();
  }}
  onblur={() => {
    cancelGesture();
    ctrlDown = false;
    spaceHeld = false;
    mods = { shift: false, alt: false };
  }}
/>

<section class="stage" bind:this={stage} aria-label={t("canvas.label")}>
  <div class="toolbar" class:wrap={fitLevel >= 6} class:narrow bind:this={toolbar}>
    <div class="group" role="toolbar" aria-label={t("canvas.tools")}>
      {#each groups as g (g.id)}
        {@const v = shown(g)}
        {@const Icon = v.icon}
        {@const active = editing && !comparing && g.variants.some((x) => x.tool === app.tool)}
        <span class="tool-wrap">
          <button
            class="tool"
            aria-pressed={active}
            disabled={!editing || comparing}
            title="{t(v.label)} ({v.key})"
            aria-label={t(v.label)}
            onclick={(e) => onToolClick(g, v, e)}
            onpointerdown={(e) => g.variants.length > 1 && holdStart(g.id, e)}
            onpointerup={holdEnd}
            onpointerleave={holdEnd}
            oncontextmenu={(e) => {
              if (g.variants.length < 2) return;
              e.preventDefault();
              // a long press on a touch screen has opened it already
              if (menu?.id !== g.id) toggleMenu(g.id, e);
            }}
          >
            <Icon size={15} />{#if app.layout === "wide" && fitLevel < 2}<span>{t(v.label)}</span>{/if}
          </button>
          {#if g.variants.length > 1}
            <button
              class="more"
              disabled={!editing || comparing}
              aria-haspopup="menu"
              aria-expanded={menu?.id === g.id}
              aria-label={t("canvas.moreTools", { group: t(g.label) })}
              title={t("canvas.moreTools", { group: t(g.label) })}
              onclick={(e) => toggleMenu(g.id, e)}></button
            >
          {/if}
        </span>
      {/each}
    </div>
    {#if editing && !comparing && drawsShapes}
      {@const ModeIcon = modeIcon}
      {#if narrow || fitLevel >= 4}
        <button
          class="mode-pick"
          aria-haspopup="menu"
          aria-expanded={menu?.id === "mode"}
          disabled={app.tool === "eraser"}
          title={t("selmode.label")}
          aria-label="{t('selmode.label')}: {t(modes.find((m) => m.id === app.selectMode)!.label)}"
          onclick={(e) => toggleMenu("mode", e)}><ModeIcon size={15} /><ChevronDown size={10} strokeWidth={2.5} /></button
        >
      {:else}
        <div class="modes" role="radiogroup" aria-label={t("selmode.label")}>
          {#each modes as m (m.id)}
            {@const MIcon = m.icon}
            <button
              role="radio"
              class="mode"
              class:held={app.tool !== "eraser" && liveMode === m.id && app.selectMode !== m.id}
              aria-checked={app.tool === "eraser" ? m.id === "subtract" : app.selectMode === m.id}
              disabled={app.tool === "eraser"}
              title="{t(m.label)}{m.hint ? ` (${t('selmode.hold', { key: m.hint })})` : ''}"
              aria-label={t(m.label)}
              onclick={() => pickMode(m.id)}><MIcon size={15} /></button
            >
          {/each}
        </div>
      {/if}
    {/if}
    {#if (app.tool === "brush" || app.tool === "eraser") && editing && !comparing}
      {#if narrow}
        <!-- phones: the size behind a small picker, like Photoshop's brush preset picker -->
        <button
          class="size-pick"
          aria-haspopup="dialog"
          aria-expanded={menu?.id === "size"}
          title={t("canvas.brushSizeName")}
          aria-label="{t('canvas.brushSizeName')}: {app.brushSize}"
          onclick={(e) => toggleMenu("size", e)}
          ><span class="tip-dot"><span style:width="{dotSize}px" style:height="{dotSize}px"></span></span><ChevronDown size={10} strokeWidth={2.5} /></button
        >
      {:else}
        <label class="brush" class:short={fitLevel >= 5} title={t("canvas.brushSize")}>
          <span class="visually-hidden">{t("canvas.brushSize")}</span>
          <input
            type="range"
            min="0"
            max="1000"
            value={sliderOf(app.brushSize)}
            oninput={(e) => (app.brushSize = sizeOf(+e.currentTarget.value))}
            onchange={() => app.persistPrefs()}
          />
          {#if fitLevel < 5}<span class="num">{app.brushSize}</span>{/if}
        </label>
      {/if}
    {/if}
    <span class="history">
      <button
        class="quiet icon"
        title={t("canvas.undo", { key: undoKey })}
        aria-label={t("canvas.undoLabel")}
        disabled={!editing || !app.canUndo}
        onclick={() => app.undo()}><Undo2 size={15} /></button
      >
      {#if !narrow}
        <button
          class="quiet icon"
          title={t("canvas.redo", { key: redoKey })}
          aria-label={t("canvas.redoLabel")}
          disabled={!editing || !app.canRedo}
          onclick={() => app.redo()}><Redo2 size={15} /></button
        >
      {/if}
    </span>
    {#if fitLevel >= 6}<span class="row-break" aria-hidden="true"></span>{/if}
    <span class="spacer"></span>
    <!-- Phones have no room for it; the outlines go away as soon as you draw -->
    {#if app.madeWithRegions.length && !narrow && !viewing}
      <button
        aria-pressed={app.showMadeWith && !comparing}
        disabled={comparing}
        onclick={() => {
          app.showMadeWith = !app.showMadeWith;
          app.persistPrefs();
        }}
        title={t("canvas.madeWithTitle")}
        aria-label={t("canvas.madeWithLabel")}
      >
        <ScanEye size={15} />{#if app.layout === "wide" && fitLevel < 3}<span>{t("canvas.madeWith")}</span>{/if}
      </button>
    {/if}
    {#if app.parentNode && !viewing}
      <button aria-pressed={app.compare} onclick={() => (app.compare = !app.compare)} title={t("canvas.compareTitle")} aria-label={t("canvas.compareLabel")}>
        <Columns2 size={15} />{#if !narrow && fitLevel < 3}<span>{t("canvas.compare")}</span>{/if}
      </button>
    {/if}
    {#if altSha && !viewing}
      <button
        aria-pressed={app.showAlt}
        onclick={() => {
          app.showAlt = !app.showAlt;
          app.partView = null;
        }}
        title={usingRaw ? t("canvas.altMergedTitle") : t("canvas.altRawTitle")}
        aria-label={altLabel}
      >
        {fitLevel >= 3 ? altShort : altLabel}
      </button>
    {/if}
    {#if !narrow}
      <span class="divider" aria-hidden="true"></span>
      {#if fitLevel < 1}<button class="quiet icon" disabled={!node} title={t("canvas.zoomOut")} aria-label={t("canvas.zoomOut")} onclick={() => zoomStep(-1)}>
        <ZoomOut size={15} />
      </button>{/if}
      <button class="quiet zoom" disabled={!node} title={t("canvas.actualSize")} onclick={actualSize}>{zoomText(view.scale)}</button>
      {#if fitLevel < 1}<button class="quiet icon" disabled={!node} title={t("canvas.zoomIn")} aria-label={t("canvas.zoomIn")} onclick={() => zoomStep(1)}>
        <ZoomIn size={15} />
      </button>{/if}
    {/if}
    <button class="quiet icon" disabled={!node} title={t("canvas.fit")} aria-label={t("canvas.fit")} onclick={refit}>
      <Maximize size={15} />
    </button>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="viewport"
    tabindex="-1"
    bind:this={viewport}
    style:cursor={cursorStyle}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onpointerleave={() => {
      hover = null;
      app.cursor = null;
    }}
    onwheel={onWheel}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <canvas bind:this={canvas} style:width="{width}px" style:height="{height}px"></canvas>
    {#if viewing && !node}
      <div class="welcome">
        <p class="lead serif">{viewing.status === "failed" ? t("canvas.jobNewFailed") : t("canvas.jobNew")}</p>
        <p class="job-prompt">{describeJob(viewing)}</p>
      </div>
    {:else if !node}
      <div class="welcome">
        {#if app.nodeCount}
          <p class="lead serif">{t("canvas.pickTitle")}</p>
          <p>{app.layout === "wide" ? t("canvas.pickWide") : t("canvas.pickNarrow")}</p>
          {#if app.layout !== "wide"}
            <div class="actions"><button onclick={() => (app.treeOpen = true)}>{t("canvas.openTree")}</button></div>
          {/if}
        {:else}
          <p class="lead serif">{t("canvas.startTitle")}</p>
          <p>{t("canvas.startBody")}</p>
          <div class="actions">
            <button class="primary" onclick={() => fileInput?.click()}><ImageUp size={15} />{t("canvas.import")}</button>
            <button onclick={startGenerate}><WandSparkles size={15} />{t("canvas.generate")}</button>
          </div>
          {#if !coarse}<p class="small">{t("canvas.dropHint")}</p>{/if}
          <input
            bind:this={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onchange={(e) => {
              void app.upload(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
            }}
          />
        {/if}
      </div>
    {:else if tip}
      <div class="tip">{tip}</div>
    {/if}
  </div>

  {#if menu}
    <div
      class="flyout"
      role={menu.id === "size" ? "dialog" : "menu"}
      aria-label={menu.id === "size" ? t("canvas.brushSizeName") : undefined}
      style:left="{menu.x}px"
      style:top="{menu.y}px"
      {@attach dismissible(closeMenu)}
    >
      {#if menu.id === "size"}
        <label class="size-panel">
          <span class="row"><span>{t("canvas.brushSizeName")}</span><span class="num">{app.brushSize}</span></span>
          <input
            type="range"
            min="0"
            max="1000"
            value={sliderOf(app.brushSize)}
            oninput={(e) => (app.brushSize = sizeOf(+e.currentTarget.value))}
            onchange={() => app.persistPrefs()}
          />
        </label>
      {:else if menu.id === "mode"}
        {#each modes as m (m.id)}
          {@const MIcon = m.icon}
          <button
            role="menuitemradio"
            aria-checked={app.selectMode === m.id}
            onclick={() => {
              pickMode(m.id);
              closeMenu();
            }}><MIcon size={15} /><span class="name">{t(m.label)}</span><span class="key">{coarse ? "" : m.hint}</span></button
          >
        {/each}
      {:else}
        {#each groups.find((g) => g.id === menu?.id)?.variants ?? [] as v (v.tool)}
          {@const VIcon = v.icon}
          <button
            role="menuitemradio"
            aria-checked={app.tool === v.tool}
            onclick={() => {
              pickTool(v.tool);
              closeMenu();
            }}><VIcon size={15} /><span class="name">{t(v.label)}</span><span class="key">{coarse ? "" : v.key}</span></button
          >
        {/each}
      {/if}
    </div>
  {/if}

  {#if viewing}
    <footer class="caption">
      <p class="figure">
        <span class="num job-state {viewing.status}">{t(`status.${viewing.status}`)}</span>
        <span class="text" title={describeJob(viewing)}>{describeJob(viewing)}</span>
      </p>
      <span class="caption-actions">
        {#if viewing.status === "failed"}
          <button class="quiet icon delete" title={t("tree.dismiss")} aria-label={t("tree.dismiss")} onclick={() => app.dismissJob(viewing)}>
            <Trash2 size={15} />
          </button>
        {/if}
      </span>
    </footer>
  {:else if node}
    <footer class="caption">
      <p class="figure">
        <span class="num serif">{fig(version)}</span>
        <span class="text" title={caption}
          >{caption}{part
            ? t("canvas.viewingPart", { k: part.part.request + 1, what: part.kind === "raw" ? t("canvas.altRawName") : t("canvas.altMergedName") })
            : app.showAlt
              ? t("canvas.viewingAlt", { alt: altName })
              : ""}</span
        >
        {#if noteText && !narrow}<span class="footnote" title={noteText}>{t("canvas.notePrefix")}{noteText}</span>{/if}
      </p>
      {#if app.lineage.length > 1 && !narrow}
        <ol class="path" aria-label={t("canvas.lineage")}>
          {#each app.lineage as step (step.id)}
            <li>
              <button class="serif" aria-current={step.id === node.id} onclick={() => app.select(step.id)}>
                {app.versions[step.id]}
              </button>
            </li>
          {/each}
        </ol>
      {/if}
      <span class="caption-actions">
        {#if part}
          <button class="quiet" title={t("canvas.partExitTitle")} onclick={() => (app.partView = null)}>{t("canvas.partExit")}</button>
        {/if}
        <button
          class="quiet icon"
          class:starred={node.starred}
          aria-label={node.starred ? t("tree.unstar") : t("tree.star")}
          title={node.starred ? t("tree.unstar") : t("tree.star")}
          onclick={() => app.toggleStar(node)}
        >
          <Star size={15} fill={node.starred ? "currentColor" : "none"} />
        </button>
        <button class="quiet icon" title={t("canvas.saveAsAsset")} aria-label={t("canvas.saveAsAsset")} onclick={() => void app.saveAsAsset(node)}>
          <BookmarkPlus size={15} />
        </button>
        <button class="quiet icon" title={t("canvas.download")} aria-label={t("canvas.download")} onclick={() => void backend.download(node.image, `brushgraft-${version}`)}>
          <Download size={15} />
        </button>
        <button class="quiet icon delete" title={t("tree.delete")} aria-label={t("tree.delete")} onclick={() => app.deleteNode(node)}>
          <Trash2 size={15} />
        </button>
      </span>
    </footer>
  {/if}
</section>

<style>
  .stage {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--well);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 40px;
    flex: none;
    padding: 0 8px;
    background: var(--panel);
    border-bottom: 1px solid var(--rule);
    overflow-x: auto;
    scrollbar-width: none;
  }

  /* phones: tighter, so a full set of buttons still fits one row on a 390px screen */
  .toolbar.narrow {
    gap: 2px;
    padding: 0 4px;
  }

  .toolbar.narrow .tool {
    padding: 2px 6px;
  }

  .toolbar.narrow .tool-wrap:has(.more) .tool {
    padding-right: 10px;
  }

  .toolbar.narrow > button:not(.icon, .mode-pick, .size-pick) {
    padding: 2px 7px;
  }

  .toolbar.narrow .mode-pick,
  .toolbar.narrow .size-pick {
    margin-left: 2px;
    padding: 2px 3px;
  }

  /* too narrow for one row: the view controls go to a second one */
  /* buttons keep their size; if they don't fit, fitToolbar sees the overflow and makes room */
  .toolbar > :not(.spacer) {
    flex-shrink: 0;
  }

  .toolbar.wrap {
    flex-wrap: wrap;
    height: auto;
    min-height: 40px;
    padding: 5px 8px;
    row-gap: 5px;
  }

  .toolbar.narrow.wrap {
    padding: 5px 4px;
  }

  .row-break {
    flex-basis: 100%;
    height: 0;
  }

  .group {
    display: flex;
    flex: none;
    gap: 2px;
    padding: 2px;
    border-radius: calc(var(--r-s) + 2px);
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .tool {
    min-height: 26px;
    padding: 2px 8px;
    border-color: transparent;
    background: transparent;
    color: var(--ink-2);
  }

  .tool-wrap {
    position: relative;
    display: inline-flex;
  }

  /* a tool with variants has a small triangle in its corner, as in Photoshop's toolbar */
  .more {
    position: absolute;
    right: 1px;
    bottom: 1px;
    width: 12px;
    height: 12px;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: none;
    color: var(--ink-3);
  }

  .more::after {
    content: "";
    position: absolute;
    right: 2px;
    bottom: 2px;
    border-left: 5px solid transparent;
    border-bottom: 5px solid currentColor;
  }

  .more:hover:not(:disabled) {
    color: var(--ink);
  }

  .tool[aria-pressed="true"] + .more {
    color: var(--ink-2);
  }

  .tool-wrap:has(.more) .tool {
    padding-right: 12px;
  }

  .modes {
    display: flex;
    flex: none;
    gap: 1px;
    margin-left: 4px;
    padding: 2px;
    border-radius: calc(var(--r-s) + 2px);
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .mode {
    display: grid;
    place-items: center;
    width: 28px;
    min-height: 26px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: var(--ink-2);
  }

  .mode[aria-checked="true"] {
    background: var(--panel);
    color: var(--ink);
    box-shadow:
      0 0 0 1px var(--rule-2),
      0 1px 2px rgb(0 0 0 / 0.06);
  }

  /* the mode held with Shift or Alt right now */
  .mode.held {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .mode-pick {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 1px;
    min-height: 26px;
    padding: 2px 6px;
  }

  .history {
    display: flex;
    flex: none;
  }

  .flyout {
    position: absolute;
    z-index: 30;
    display: grid;
    min-width: 200px;
    padding: 4px;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
  }

  .flyout button {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 3px 8px;
    border: 0;
    background: none;
    color: var(--ink);
    text-align: left;
  }

  .flyout button:hover {
    background: var(--hover);
  }

  .flyout button[aria-checked="true"] {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .flyout .key {
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .tool[aria-pressed="true"] {
    background: var(--panel);
    color: var(--ink);
    box-shadow:
      0 0 0 1px var(--rule-2),
      0 1px 2px rgb(0 0 0 / 0.06);
  }

  .size-pick {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 1px;
    min-height: 26px;
    padding: 2px 6px;
  }

  .tip-dot {
    display: grid;
    place-items: center;
    width: 15px;
    height: 15px;
  }

  .tip-dot span {
    border-radius: 50%;
    background: currentColor;
  }

  .size-panel {
    display: grid;
    gap: 6px;
    padding: 6px 8px 4px;
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  .size-panel .row {
    display: flex;
    justify-content: space-between;
  }

  .size-panel input {
    width: 100%;
  }

  .size-panel .num {
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .brush {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    margin-left: 4px;
    color: var(--ink-2);
  }

  .brush input {
    width: 96px;
  }

  .brush.short input {
    width: 64px;
  }

  .brush .num {
    width: 2.6em;
    font-size: var(--fs-s);
    font-variant-numeric: tabular-nums;
  }

  .spacer {
    flex: 1;
  }

  .divider {
    flex: none;
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--rule);
  }

  .zoom {
    min-width: 52px;
    padding: 3px 4px;
    font-size: var(--fs-s);
  }

  .viewport {
    position: relative;
    outline: none;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  canvas {
    position: absolute;
    inset: 0;
    display: block;
  }

  .welcome {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 2px;
    padding: 24px;
    text-align: center;
    color: var(--ink-2);
  }

  .welcome p {
    max-width: 28em;
    margin: 0;
  }

  .welcome .lead {
    margin-bottom: 8px;
    font-size: 24px;
    color: var(--ink);
  }

  .welcome .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin: 20px 0 12px;
  }

  .welcome .small {
    font-size: var(--fs-s);
    color: var(--ink-3);
  }

  .tip {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100% - 24px);
    padding: 4px 10px;
    border-radius: var(--r-s);
    background: rgb(20 23 27 / 0.66);
    color: #fff;
    font-size: var(--fs-s);
    pointer-events: none;
    text-align: center;
  }


  .caption {
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    min-height: 38px;
    padding: 0 6px 0 14px;
    border-top: 1px solid var(--rule);
    background: var(--panel);
  }

  .figure {
    flex: 1;
    display: flex;
    gap: 10px;
    align-items: baseline;
    min-width: 0;
    margin: 0;
  }

  .figure .num {
    flex: none;
    font-size: 14px;
    font-weight: 600;
  }

  .figure .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-serif);
    font-size: 14px;
    color: var(--ink-2);
  }

  .figure .footnote {
    flex: 0 1 auto;
    min-width: 6em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .path {
    display: flex;
    flex: none;
    align-items: center;
    max-width: 40%;
    overflow: hidden;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .path li {
    display: flex;
    align-items: center;
  }

  .path li + li::before {
    content: "›";
    margin: 0 1px;
    color: var(--ink-3);
  }

  .path button {
    min-height: 24px;
    padding: 0 4px;
    border: 0;
    background: none;
    color: var(--ink-2);
  }

  .path button:hover {
    color: var(--ink);
  }

  .path button[aria-current="true"] {
    color: var(--ink);
    font-weight: 600;
  }

  .job-state {
    flex: none;
    font-size: var(--fs-s);
    font-weight: 600;
  }

  .job-state.running,
  .job-state.queued {
    color: var(--warn);
  }

  .job-state.failed {
    color: var(--danger);
  }

  .job-prompt {
    max-width: 36em;
    color: var(--ink-2);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .caption-actions {
    display: flex;
    flex: none;
  }

  .starred {
    color: var(--warn);
  }

  .caption-actions .delete:hover:not(:disabled) {
    color: var(--danger);
  }

  @media (pointer: coarse) {
    .tool {
      min-height: 32px;
      padding: 2px 10px;
    }
  }
</style>
