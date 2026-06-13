/* Floor Plan Designer
 * A dependency-free, local-first tool for sketching room layouts.
 *
 * Units: everything is stored internally in centimetres (cm). Rooms are
 * created from a metres input for convenience, but all edges read/write cm.
 *
 * Shapes are modelled as axis-aligned rectangles today (width `w`, height `h`),
 * but rendering and edge editing go through a small "geometry" layer
 * (localCorners / edgesOf) so the model can grow to rectilinear polygons with
 * cut-outs (chimney breasts, bay windows) later without rewriting the canvas.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "floorplan.state.v3";
  const SCHEMA_VERSION = 3;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  /** @typedef {{id:string,name:string,x:number,y:number,w:number,h:number,rot:number,color:string}} FObject */
  /** @typedef {{id:string,name:string,x:number,y:number,w:number,h:number,color:string,objects:FObject[]}} FRoom */
  /** @typedef {{id:string,name:string,rooms:FRoom[]}} FLayout */

  // The document holds many named layouts (full sets of rooms + furniture) so
  // the whole arrangement can be duplicated to explore alternatives. `state`
  // always points at the active layout, so the rest of the code uses
  // `state.rooms` unchanged. Both are assigned in boot() once all the
  // helper declarations below (uid, normalize, …) are initialized.
  let doc;
  let state;
  // View transform: screen_px = world_cm * scale + offset
  let view = { scale: 0.45, ox: 70, oy: 70 };
  let ui = { grid: true, snap: true, gridCm: 10 };
  /** @type {{kind:'room'|'object', roomId:string, objId?:string}|null} */
  let selection = null;

  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#c7d2fe", "#bbf7d0", "#fde68a", "#fecaca", "#bae6fd", "#ddd6fe", "#fbcfe8"];

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  const svg = document.getElementById("canvas");
  const wrap = document.getElementById("canvas-wrap");
  const panel = document.getElementById("panel");
  const panelEmpty = document.getElementById("panel-empty");
  const panelDetails = document.getElementById("panel-details");

  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const uid = (p) => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v) => Math.round(v);

  function snapVal(v) {
    return ui.snap ? Math.round(v / ui.gridCm) * ui.gridCm : Math.round(v);
  }

  function worldToScreen(x, y) {
    return [x * view.scale + view.ox, y * view.scale + view.oy];
  }
  function screenToWorld(px, py) {
    return [(px - view.ox) / view.scale, (py - view.oy) / view.scale];
  }
  function mousePos(e) {
    const r = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function rotatePoint(px, py, cx, cy, deg) {
    const a = (deg * Math.PI) / 180;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const dx = px - cx;
    const dy = py - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  // ---------- Geometry layer (the seam for future polygon shapes) ----------
  // Local corners of an item in its own coordinate frame (cm), clockwise.
  function localCorners(item) {
    return [
      [0, 0],
      [item.w, 0],
      [item.w, item.h],
      [0, item.h],
    ];
  }
  // Edges of a rectangle, each annotated with which dimension drives it.
  // For future polygons this would return per-edge lengths instead.
  function edgesOf(item) {
    const c = localCorners(item);
    return [
      { i: 0, a: c[0], b: c[1], len: item.w, dim: "w" },
      { i: 1, a: c[1], b: c[2], len: item.h, dim: "h" },
      { i: 2, a: c[2], b: c[3], len: item.w, dim: "w" },
      { i: 3, a: c[3], b: c[0], len: item.h, dim: "h" },
    ];
  }

  // Resolve a selection into the live objects it points at.
  function resolveSel() {
    if (!selection) return null;
    const room = state.rooms.find((r) => r.id === selection.roomId);
    if (!room) return null;
    if (selection.kind === "room") return { kind: "room", room, item: room };
    const obj = room.objects.find((o) => o.id === selection.objId);
    if (!obj) return null;
    return { kind: "object", room, obj, item: obj };
  }

  // World-space geometry for an item, accounting for its room origin & rotation.
  function itemGeometry(room, item, rot) {
    const originX = item === room ? room.x : room.x + item.x;
    const originY = item === room ? room.y : room.y + item.y;
    const cxL = item.w / 2;
    const cyL = item.h / 2;
    const corners = localCorners(item).map(([lx, ly]) => {
      const [rx, ry] = rot ? rotatePoint(lx, ly, cxL, cyL, rot) : [lx, ly];
      return worldToScreen(originX + rx, originY + ry);
    });
    const centerW = worldToScreen(originX + cxL, originY + cyL);
    const edges = edgesOf(item).map((edgeDef) => {
      const aL = edgeDef.a;
      const bL = edgeDef.b;
      const mid = [(aL[0] + bL[0]) / 2, (aL[1] + bL[1]) / 2];
      const [mrx, mry] = rot ? rotatePoint(mid[0], mid[1], cxL, cyL, rot) : mid;
      // push the label slightly outside the shape (away from centre)
      const ox = mid[0] - cxL;
      const oy = mid[1] - cyL;
      const ml = Math.hypot(ox, oy) || 1;
      const off = 14 / view.scale; // ~14px outside, expressed in cm
      const pL = [mid[0] + (ox / ml) * off, mid[1] + (oy / ml) * off];
      const [plx, ply] = rot ? rotatePoint(pL[0], pL[1], cxL, cyL, rot) : pL;
      return {
        dim: edgeDef.dim,
        i: edgeDef.i,
        len: edgeDef.len,
        screen: worldToScreen(originX + mrx, originY + mry),
        labelScreen: worldToScreen(originX + plx, originY + ply),
      };
    });
    return { corners, center: centerW, edges };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVGNS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }

  function render() {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.replaceChildren();

    if (ui.grid) drawGrid(W, H);

    for (const room of state.rooms) {
      drawRoom(room);
      for (const obj of room.objects) drawObject(room, obj);
    }
  }

  function drawGrid(W, H) {
    const g = svgEl("g", {});
    const [w0, h0] = screenToWorld(0, 0);
    const [w1, h1] = screenToWorld(W, H);
    const major = 100; // 1 m
    const minor = 10; // 10 cm
    const minorVisible = minor * view.scale >= 7;
    const step = minorVisible ? minor : major;

    const startX = Math.floor(w0 / step) * step;
    const startY = Math.floor(h0 / step) * step;
    for (let x = startX; x <= w1; x += step) {
      const [sx] = worldToScreen(x, 0);
      const isMajor = Math.round(x) % major === 0;
      g.appendChild(
        svgEl("line", {
          x1: sx, y1: 0, x2: sx, y2: H,
          stroke: isMajor ? "#cfd4da" : "#e3e6ea",
          "stroke-width": 1,
        })
      );
    }
    for (let y = startY; y <= h1; y += step) {
      const [, sy] = worldToScreen(0, y);
      const isMajor = Math.round(y) % major === 0;
      g.appendChild(
        svgEl("line", {
          x1: 0, y1: sy, x2: W, y2: sy,
          stroke: isMajor ? "#cfd4da" : "#e3e6ea",
          "stroke-width": 1,
        })
      );
    }
    svg.appendChild(g);
  }

  function pointsStr(corners) {
    return corners.map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  }

  function drawRoom(room) {
    const sel = selection && selection.kind === "room" && selection.roomId === room.id;
    const geo = itemGeometry(room, room, 0);
    const g = svgEl("g", { class: "room", "data-kind": "room", "data-room": room.id });

    g.appendChild(
      svgEl("polygon", {
        points: pointsStr(geo.corners),
        fill: room.color,
        "fill-opacity": 0.35,
        stroke: sel ? "#2563eb" : "#6b7280",
        "stroke-width": sel ? 3 : 2,
        style: "cursor:move",
      })
    );

    // Room name (top-left, inside)
    const [nx, ny] = geo.corners[0];
    g.appendChild(textLabel(nx + 8, ny + 20, room.name, { weight: 700, size: 15, fill: "#1f2933" }));

    drawEdgeLabels(g, geo, room, room.id, null);
    if (sel) drawHandles(g, geo);
    svg.appendChild(g);
  }

  function drawObject(room, obj) {
    const sel =
      selection &&
      selection.kind === "object" &&
      selection.roomId === room.id &&
      selection.objId === obj.id;
    const geo = itemGeometry(room, obj, obj.rot || 0);
    const g = svgEl("g", {
      class: "object",
      "data-kind": "object",
      "data-room": room.id,
      "data-obj": obj.id,
    });

    g.appendChild(
      svgEl("polygon", {
        points: pointsStr(geo.corners),
        fill: obj.color,
        "fill-opacity": 0.92,
        stroke: sel ? "#2563eb" : "#475569",
        "stroke-width": sel ? 3 : 1.5,
        style: "cursor:move",
      })
    );

    g.appendChild(
      textLabel(geo.center[0], geo.center[1] + 4, obj.name, {
        weight: 600, size: 13, fill: "#1f2933", anchor: "middle",
      })
    );

    drawEdgeLabels(g, geo, obj, room.id, obj.id);
    if (sel) drawHandles(g, geo);
    svg.appendChild(g);
  }

  function textLabel(x, y, str, opt = {}) {
    return svgEl(
      "text",
      {
        x, y,
        "font-size": opt.size || 12,
        "font-weight": opt.weight || 400,
        fill: opt.fill || "#1f2933",
        "text-anchor": opt.anchor || "start",
        "font-family": "system-ui, sans-serif",
        style: "pointer-events:none; user-select:none",
      },
      str
    );
  }

  function drawEdgeLabels(g, geo, item, roomId, objId) {
    for (const e of geo.edges) {
      const [lx, ly] = e.labelScreen;
      const txt = `${round(e.len)} cm`;
      const wpx = txt.length * 6.6 + 8;
      const eg = svgEl("g", {
        class: "edge-label",
        "data-kind": "edge",
        "data-room": roomId,
        "data-dim": e.dim,
        style: "cursor:pointer",
      });
      if (objId) eg.setAttribute("data-obj", objId);
      eg.appendChild(
        svgEl("rect", {
          x: lx - wpx / 2, y: ly - 9, width: wpx, height: 18, rx: 4,
          fill: "#ffffff", "fill-opacity": 0.92, stroke: "#9aa1ab", "stroke-width": 1,
        })
      );
      eg.appendChild(
        svgEl(
          "text",
          {
            x: lx, y: ly + 4,
            "font-size": 11, "text-anchor": "middle", fill: "#374151",
            "font-family": "system-ui, sans-serif", style: "pointer-events:none",
          },
          txt
        )
      );
      g.appendChild(eg);
    }
  }

  function drawHandles(g, geo) {
    for (const [hx, hy] of geo.corners) {
      g.appendChild(
        svgEl("rect", {
          x: hx - 4, y: hy - 4, width: 8, height: 8,
          fill: "#fff", stroke: "#2563eb", "stroke-width": 2,
          style: "pointer-events:none",
        })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer interaction (mouse + touch unified via Pointer Events)
  // ---------------------------------------------------------------------------
  const pointers = new Map(); // pointerId -> {x,y}
  let drag = null; // {type, ...}
  let pinch = null; // {startDist, startScale, cx, cy}

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);

  function onPointerDown(e) {
    pointers.set(e.pointerId, mousePos(e));

    // Two fingers -> pinch zoom / pan; cancel any single-item drag.
    if (pointers.size === 2) {
      drag = null;
      const pts = [...pointers.values()];
      pinch = {
        startDist: dist(pts[0], pts[1]),
        startScale: view.scale,
        startOx: view.ox,
        startOy: view.oy,
        cx: (pts[0][0] + pts[1][0]) / 2,
        cy: (pts[0][1] + pts[1][1]) / 2,
      };
      return;
    }

    const target = e.target.closest("[data-kind]");
    svg.setPointerCapture(e.pointerId);

    if (!target || target.getAttribute("data-kind") === undefined) {
      startPan(e);
      return;
    }
    const kind = target.getAttribute("data-kind");

    if (kind === "edge") {
      openEdgeEditor(target, e);
      return;
    }

    const roomId = target.getAttribute("data-room");
    const objId = target.getAttribute("data-obj");
    if (kind === "object") {
      select({ kind: "object", roomId, objId });
      const room = state.rooms.find((r) => r.id === roomId);
      const obj = room.objects.find((o) => o.id === objId);
      const [wx, wy] = screenToWorld(...mousePos(e));
      drag = { type: "object", room, obj, startX: obj.x, startY: obj.y, grabX: wx, grabY: wy, moved: false };
    } else if (kind === "room") {
      select({ kind: "room", roomId });
      const room = state.rooms.find((r) => r.id === roomId);
      const [wx, wy] = screenToWorld(...mousePos(e));
      drag = { type: "room", room, startX: room.x, startY: room.y, grabX: wx, grabY: wy, moved: false };
    }
  }

  function startPan(e) {
    if (e.target.closest("[data-kind]")) return;
    select(null);
    drag = { type: "pan", startOx: view.ox, startOy: view.oy, startMx: mousePos(e)[0], startMy: mousePos(e)[1] };
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, mousePos(e));

    if (pinch && pointers.size >= 2) {
      const pts = [...pointers.values()];
      const d = dist(pts[0], pts[1]);
      const factor = d / pinch.startDist;
      const newScale = clamp(pinch.startScale * factor, 0.05, 6);
      // keep the pinch centre stable
      const [wx, wy] = [
        (pinch.cx - pinch.startOx) / pinch.startScale,
        (pinch.cy - pinch.startOy) / pinch.startScale,
      ];
      view.scale = newScale;
      view.ox = pinch.cx - wx * newScale;
      view.oy = pinch.cy - wy * newScale;
      render();
      return;
    }

    if (!drag) return;
    const [mx, my] = mousePos(e);

    if (drag.type === "pan") {
      view.ox = drag.startOx + (mx - drag.startMx);
      view.oy = drag.startOy + (my - drag.startMy);
      render();
      return;
    }

    const [wx, wy] = screenToWorld(mx, my);
    const dx = wx - drag.grabX;
    const dy = wy - drag.grabY;
    drag.moved = true;
    if (drag.type === "object") {
      drag.obj.x = snapVal(drag.startX + dx);
      drag.obj.y = snapVal(drag.startY + dy);
    } else if (drag.type === "room") {
      drag.room.x = snapVal(drag.startX + dx);
      drag.room.y = snapVal(drag.startY + dy);
    }
    render();
    syncPanelPosition();
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) {
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    if (pointers.size < 2) pinch = null;
    if (drag && drag.moved) save();
    drag = null;
  }

  function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  // Wheel zoom (desktop)
  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [mx, my] = mousePos(e);
      const [wx, wy] = screenToWorld(mx, my);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.scale = clamp(view.scale * factor, 0.05, 6);
      view.ox = mx - wx * view.scale;
      view.oy = my - wy * view.scale;
      render();
      syncPanelPosition();
    },
    { passive: false }
  );

  // ---------------------------------------------------------------------------
  // Inline edge length editor
  // ---------------------------------------------------------------------------
  let edgeEditor = null;
  function openEdgeEditor(target, e) {
    closeEdgeEditor();
    const roomId = target.getAttribute("data-room");
    const objId = target.getAttribute("data-obj");
    const dim = target.getAttribute("data-dim");
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const item = objId ? room.objects.find((o) => o.id === objId) : room;
    if (!item) return;
    select(objId ? { kind: "object", roomId, objId } : { kind: "room", roomId });

    const [mx, my] = mousePos(e);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = round(item[dim]);
    input.className = "edge-editor";
    input.style.left = mx + "px";
    input.style.top = my + "px";
    wrap.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const v = parseFloat(input.value);
      if (!isNaN(v) && v >= 1) {
        item[dim] = round(v);
        save();
      }
      closeEdgeEditor();
      render();
      refreshPanel();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      else if (ev.key === "Escape") closeEdgeEditor();
    });
    input.addEventListener("blur", commit);
    edgeEditor = input;
  }
  function closeEdgeEditor() {
    if (edgeEditor) {
      const node = edgeEditor;
      edgeEditor = null;
      node.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Selection + property panel
  // ---------------------------------------------------------------------------
  function select(sel) {
    selection = sel;
    render();
    refreshPanel();
  }

  function refreshPanel() {
    const r = resolveSel();
    const hasSel = !!r;
    panelEmpty.hidden = hasSel;
    panelDetails.hidden = !hasSel;
    panel.classList.toggle("collapsed", !hasSel);

    el("btn-rotate").disabled = !(r && r.kind === "object");
    el("btn-duplicate").disabled = !hasSel;
    el("btn-delete").disabled = !hasSel;
    if (!hasSel) return;

    const item = r.item;
    el("panel-title").textContent = r.kind === "room" ? "Room" : "Object";
    el("f-name").value = item.name;
    el("f-w").value = round(item.w);
    el("f-h").value = round(item.h);
    el("f-x").value = round(item.x);
    el("f-y").value = round(item.y);
    el("f-color").value = item.color;
    el("f-x-label").textContent = r.kind === "room" ? "X in plan (cm)" : "X in room (cm)";
    el("f-y-label").textContent = r.kind === "room" ? "Y in plan (cm)" : "Y in room (cm)";

    const rotField = el("f-rot-field");
    rotField.hidden = r.kind !== "object";
    if (r.kind === "object") el("f-rot").value = String(item.rot || 0);

    const contents = el("room-contents");
    contents.hidden = r.kind !== "room";
    if (r.kind === "room") renderContents(r.room);
  }

  function renderContents(room) {
    const list = el("contents-list");
    list.replaceChildren();
    if (!room.objects.length) {
      const li = document.createElement("li");
      li.textContent = "No objects yet — use + Object.";
      li.style.cursor = "default";
      list.appendChild(li);
      return;
    }
    for (const obj of room.objects) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = obj.name;
      const dims = document.createElement("span");
      dims.textContent = `${round(obj.w)}×${round(obj.h)}`;
      dims.style.color = "var(--muted)";
      li.append(span, dims);
      li.addEventListener("click", () => select({ kind: "object", roomId: room.id, objId: obj.id }));
      list.appendChild(li);
    }
  }

  // Live-edit handlers from the panel
  function bindPanel() {
    el("f-name").addEventListener("input", (e) => {
      const r = resolveSel();
      if (r) { r.item.name = e.target.value; render(); saveSoon(); }
    });
    const numField = (id, key, min) =>
      el(id).addEventListener("input", (e) => {
        const r = resolveSel();
        if (!r) return;
        let v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        if (min != null) v = Math.max(min, v);
        r.item[key] = round(v);
        render();
        saveSoon();
      });
    numField("f-w", "w", 1);
    numField("f-h", "h", 1);
    numField("f-x", "x", null);
    numField("f-y", "y", null);
    el("f-rot").addEventListener("change", (e) => {
      const r = resolveSel();
      if (r && r.kind === "object") { r.item.rot = parseInt(e.target.value, 10) || 0; render(); save(); }
    });
    el("f-color").addEventListener("input", (e) => {
      const r = resolveSel();
      if (r) { r.item.color = e.target.value; render(); saveSoon(); }
    });
  }

  // The panel position never moves, but inputs may need refreshing after a drag.
  function syncPanelPosition() {
    const r = resolveSel();
    if (!r) return;
    if (document.activeElement && document.activeElement.closest("#panel-details")) return;
    el("f-x").value = round(r.item.x);
    el("f-y").value = round(r.item.y);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  function addRoom() {
    const input = prompt("New room size as  width x height  in metres\n(e.g. 4.2 x 3.5)", "4 x 3");
    if (input == null) return;
    const m = input.replace(/,/g, ".").match(/([\d.]+)\s*[x×*by\s]+\s*([\d.]+)/i);
    let wM = 4, hM = 3;
    if (m) { wM = parseFloat(m[1]); hM = parseFloat(m[2]); }
    if (!(wM > 0) || !(hM > 0)) { alert("Please enter two positive numbers, e.g. 4 x 3"); return; }

    // place new room near the current view centre, snapped
    const [cx, cy] = screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
    const room = {
      id: uid("r"),
      name: "Room " + (state.rooms.length + 1),
      x: snapVal(cx - (wM * 100) / 2),
      y: snapVal(cy - (hM * 100) / 2),
      w: round(wM * 100),
      h: round(hM * 100),
      color: PALETTE[state.rooms.length % PALETTE.length],
      objects: [],
    };
    state.rooms.push(room);
    save();
    select({ kind: "room", roomId: room.id });
  }

  function addObject() {
    let room = null;
    const r = resolveSel();
    if (r) room = r.room;
    else if (state.rooms.length === 1) room = state.rooms[0];
    if (!room) {
      alert("Select the room you want to add the object to first.");
      return;
    }
    const obj = {
      id: uid("o"),
      name: "Object",
      x: snapVal(room.w / 2 - 40),
      y: snapVal(room.h / 2 - 40),
      w: 80,
      h: 80,
      rot: 0,
      color: "#94a3b8",
    };
    room.objects.push(obj);
    save();
    select({ kind: "object", roomId: room.id, objId: obj.id });
  }

  function rotateSel() {
    const r = resolveSel();
    if (!r || r.kind !== "object") return;
    r.item.rot = ((r.item.rot || 0) + 90) % 360;
    save();
    render();
    refreshPanel();
  }

  function duplicateSel() {
    const r = resolveSel();
    if (!r) return;
    if (r.kind === "object") {
      const clone = { ...r.obj, id: uid("o"), name: r.obj.name, x: r.obj.x + 20, y: r.obj.y + 20 };
      r.room.objects.push(clone);
      save();
      select({ kind: "object", roomId: r.room.id, objId: clone.id });
    } else {
      const clone = {
        ...r.room,
        id: uid("r"),
        name: r.room.name + " copy",
        x: r.room.x + 30,
        y: r.room.y + 30,
        objects: r.room.objects.map((o) => ({ ...o, id: uid("o") })),
      };
      state.rooms.push(clone);
      save();
      select({ kind: "room", roomId: clone.id });
    }
  }

  function deleteSel() {
    const r = resolveSel();
    if (!r) return;
    if (r.kind === "object") {
      r.room.objects = r.room.objects.filter((o) => o.id !== r.obj.id);
    } else {
      if (r.room.objects.length && !confirm(`Delete "${r.room.name}" and its ${r.room.objects.length} object(s)?`))
        return;
      state.rooms = state.rooms.filter((rm) => rm.id !== r.room.id);
    }
    save();
    select(null);
  }

  // ---------- Layout management (duplicate the whole arrangement) ----------
  function renderLayoutBar() {
    const sel = el("layout-select");
    sel.replaceChildren();
    for (const l of doc.layouts) {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.name;
      if (l.id === doc.activeId) opt.selected = true;
      sel.appendChild(opt);
    }
    el("btn-layout-delete").disabled = doc.layouts.length <= 1;
  }

  function setActiveLayout(id) {
    if (!doc.layouts.some((l) => l.id === id)) return;
    doc.activeId = id;
    state = activeLayout();
    selection = null;
    save();
    renderLayoutBar();
    refreshPanel();
    render();
  }

  function cloneLayout(layout, name) {
    return {
      id: uid("l"),
      name,
      rooms: layout.rooms.map((r) => ({
        ...r,
        id: uid("r"),
        objects: r.objects.map((o) => ({ ...o, id: uid("o") })),
      })),
    };
  }

  function duplicateLayout() {
    const copy = cloneLayout(activeLayout(), nextCopyName(activeLayout().name));
    doc.layouts.push(copy);
    setActiveLayout(copy.id);
  }

  function newLayout() {
    const layout = { id: uid("l"), name: "Layout " + (doc.layouts.length + 1), rooms: [] };
    doc.layouts.push(layout);
    setActiveLayout(layout.id);
  }

  function renameLayout() {
    const l = activeLayout();
    const name = prompt("Rename layout", l.name);
    if (name == null) return;
    l.name = name.trim() || l.name;
    save();
    renderLayoutBar();
  }

  function deleteLayout() {
    if (doc.layouts.length <= 1) return;
    const l = activeLayout();
    if (!confirm(`Delete layout "${l.name}"? This cannot be undone.`)) return;
    doc.layouts = doc.layouts.filter((x) => x.id !== l.id);
    setActiveLayout(doc.layouts[0].id);
  }

  // "Layout 1" -> "Layout 1 copy" -> "Layout 1 copy 2" ...
  function nextCopyName(base) {
    const root = base.replace(/ copy( \d+)?$/, "");
    let candidate = root + " copy";
    let n = 2;
    const names = new Set(doc.layouts.map((l) => l.name));
    while (names.has(candidate)) candidate = root + " copy " + n++;
    return candidate;
  }

  function fitView() {
    if (!state.rooms.length) {
      view = { scale: 0.45, ox: 70, oy: 70 };
      render();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const room of state.rooms) {
      minX = Math.min(minX, room.x);
      minY = Math.min(minY, room.y);
      maxX = Math.max(maxX, room.x + room.w);
      maxY = Math.max(maxY, room.y + room.h);
    }
    const pad = 60;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const sx = (W - pad * 2) / Math.max(1, maxX - minX);
    const sy = (H - pad * 2) / Math.max(1, maxY - minY);
    view.scale = clamp(Math.min(sx, sy), 0.05, 6);
    view.ox = pad - minX * view.scale + (W - pad * 2 - (maxX - minX) * view.scale) / 2;
    view.oy = pad - minY * view.scale + (H - pad * 2 - (maxY - minY) * view.scale) / 2;
    render();
  }

  function zoomBy(factor) {
    const [mx, my] = [wrap.clientWidth / 2, wrap.clientHeight / 2];
    const [wx, wy] = screenToWorld(mx, my);
    view.scale = clamp(view.scale * factor, 0.05, 6);
    view.ox = mx - wx * view.scale;
    view.oy = my - wy * view.scale;
    render();
  }

  // ---------------------------------------------------------------------------
  // Import / export / persistence
  // ---------------------------------------------------------------------------
  function serialize() {
    return JSON.stringify(
      { version: SCHEMA_VERSION, activeId: doc.activeId, view, layouts: doc.layouts },
      null,
      2
    );
  }

  function exportPlan() {
    const blob = new Blob([serialize()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floorplan-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importPlan(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || (!Array.isArray(data.rooms) && !Array.isArray(data.layouts)))
          throw new Error("not a floor plan file");
        doc = normalize(data);
        state = activeLayout();
        if (data.view && typeof data.view.scale === "number") view = data.view;
        selection = null;
        save();
        renderLayoutBar();
        render();
        refreshPanel();
        fitView();
      } catch (err) {
        alert("Could not import that file: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function normalizeRoom(r) {
    return {
      id: r.id || uid("r"),
      name: r.name || "Room",
      x: +r.x || 0,
      y: +r.y || 0,
      w: Math.max(1, +r.w || 100),
      h: Math.max(1, +r.h || 100),
      color: r.color || "#c7d2fe",
      objects: (r.objects || []).map((o) => ({
        id: o.id || uid("o"),
        name: o.name || "Object",
        x: +o.x || 0,
        y: +o.y || 0,
        w: Math.max(1, +o.w || 50),
        h: Math.max(1, +o.h || 50),
        rot: [0, 90, 180, 270].includes(+o.rot) ? +o.rot : 0,
        color: o.color || "#94a3b8",
      })),
    };
  }

  // Coerce loaded data into the current schema. Accepts both the current
  // multi-layout shape and the older single-`rooms` shape (and hand edits).
  function normalize(data) {
    let layouts;
    if (Array.isArray(data.layouts) && data.layouts.length) {
      layouts = data.layouts.map((l) => ({
        id: l.id || uid("l"),
        name: l.name || "Layout",
        rooms: (l.rooms || []).map(normalizeRoom),
      }));
    } else {
      layouts = [{ id: uid("l"), name: "Layout 1", rooms: (data.rooms || []).map(normalizeRoom) }];
    }
    const activeId = layouts.some((l) => l.id === data.activeId) ? data.activeId : layouts[0].id;
    return { version: SCHEMA_VERSION, activeId, layouts };
  }

  function activeLayout() {
    return doc.layouts.find((l) => l.id === doc.activeId) || doc.layouts[0];
  }

  let saveTimer = null;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
    } catch (_) {}
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return normalize(data);
    } catch (_) {
      return null;
    }
  }

  function sample() {
    const layoutId = uid("l");
    return {
      version: SCHEMA_VERSION,
      activeId: layoutId,
      layouts: [
        {
          id: layoutId,
          name: "Layout 1",
          rooms: [
            {
              id: uid("r"),
              name: "Living Room",
              x: 0,
              y: 0,
              w: 450,
              h: 360,
              color: PALETTE[0],
              objects: [
                { id: uid("o"), name: "Sofa", x: 30, y: 240, w: 220, h: 90, rot: 0, color: "#94a3b8" },
                { id: uid("o"), name: "TV unit", x: 40, y: 20, w: 180, h: 45, rot: 0, color: "#a8a29e" },
                { id: uid("o"), name: "Coffee table", x: 120, y: 150, w: 110, h: 60, rot: 0, color: "#d6bcab" },
              ],
            },
          ],
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input, select, textarea");
    if (typing) return;
    const r = resolveSel();
    if ((e.key === "Delete" || e.key === "Backspace") && r) { e.preventDefault(); deleteSel(); }
    else if (e.key.toLowerCase() === "r" && r && r.kind === "object") { rotateSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && r) { e.preventDefault(); duplicateSel(); }
    else if (e.key === "Escape") select(null);
    else if (e.key.startsWith("Arrow") && r) {
      e.preventDefault();
      const step = e.shiftKey ? ui.gridCm * 10 : ui.gridCm;
      if (e.key === "ArrowLeft") r.item.x -= step;
      if (e.key === "ArrowRight") r.item.x += step;
      if (e.key === "ArrowUp") r.item.y -= step;
      if (e.key === "ArrowDown") r.item.y += step;
      save();
      render();
      refreshPanel();
    }
  });

  // ---------------------------------------------------------------------------
  // Wire up toolbar
  // ---------------------------------------------------------------------------
  el("btn-add-room").addEventListener("click", addRoom);
  el("btn-add-object").addEventListener("click", addObject);
  el("btn-rotate").addEventListener("click", rotateSel);
  el("btn-duplicate").addEventListener("click", duplicateSel);
  el("btn-delete").addEventListener("click", deleteSel);
  el("btn-zoom-in").addEventListener("click", () => zoomBy(1.2));
  el("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
  el("btn-zoom-reset").addEventListener("click", fitView);
  el("chk-grid").addEventListener("change", (e) => { ui.grid = e.target.checked; render(); });
  el("chk-snap").addEventListener("change", (e) => { ui.snap = e.target.checked; });
  el("btn-export").addEventListener("click", exportPlan);
  el("btn-import").addEventListener("click", () => el("file-import").click());
  el("file-import").addEventListener("change", (e) => {
    if (e.target.files[0]) importPlan(e.target.files[0]);
    e.target.value = "";
  });
  el("btn-clear").addEventListener("click", () => {
    if (!confirm(`Empty the current layout "${state.name}"? This cannot be undone.`)) return;
    state.rooms = [];
    selection = null;
    save();
    render();
    refreshPanel();
  });

  // Layout controls
  el("layout-select").addEventListener("change", (e) => setActiveLayout(e.target.value));
  el("btn-layout-dup").addEventListener("click", duplicateLayout);
  el("btn-layout-new").addEventListener("click", newLayout);
  el("btn-layout-rename").addEventListener("click", renameLayout);
  el("btn-layout-delete").addEventListener("click", deleteLayout);

  window.addEventListener("resize", render);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  doc = load() || sample();
  state = activeLayout();
  bindPanel();
  renderLayoutBar();
  refreshPanel();
  fitView();
})();
