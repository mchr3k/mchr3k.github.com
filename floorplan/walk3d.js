// First-person "walk around the plan" 3D mode. Reads the plan as plain box data
// from app.js (window.__plan3d.build) and renders it with three.js (loaded on
// demand). Kept fully separate from the 2D app; if three.js can't load the 2D
// app is unaffected. Controls work on both desktop (drag + WASD) and touch
// (drag to look + an on-screen movement pad) — iOS has no pointer lock.
(function () {
  "use strict";
  const btn = document.getElementById("btn-walk3d");
  const overlay = document.getElementById("walk3d");
  const holder = document.getElementById("walk3d-canvas");
  const statusEl = document.getElementById("walk3d-status");
  const exitBtn = document.getElementById("walk3d-exit");
  if (!btn || !overlay || !holder) return;

  const EYE = 160;      // eye height above the floor (cm)
  const RADIUS = 18;    // body radius for wall collision (cm)
  const SPEED = 185;    // walk speed (cm/s) — a natural human pace (comfort)
  const FLY = 220;      // vertical fly speed (cm/s)
  const STEP_UP = 50;   // most you can step up in one go (climb stairs / split levels)
  const EYE_SMOOTH = 9; // how fast the eye height eases to the floor (per second) — damps stair-step jolts
  const PITCH_LIM = Math.PI / 2 - 0.05;

  const roomHud = document.getElementById("walk3d-room");

  let THREE = null, renderer = null, scene = null, camera = null;
  let raf = 0, active = false, last = 0;
  let colliders = [], grounds = [], roomsList = [];
  let yaw = 0, pitch = 0, flyOffset = 0, groundY = 0, eyeY = 0, curRoom = null, hiQual = false;
  const keys = Object.create(null);

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    // three.js ships only an ES module build now (the UMD global was removed in
    // r150), so load it with a dynamic import from a CDN.
    return import("https://unpkg.com/three@0.160.0/build/three.module.js")
      .then((mod) => (window.THREE = mod, mod))
      .catch(() => { throw new Error("Couldn't load the 3D library — check your connection (needs the hosted site)."); });
  }

  // Is plan point (x,z) inside box b's footprint (honouring its rotation)?
  function inFootprint(b, x, z) {
    let dx = x - b.cx, dz = z - b.cy;
    if (b.rot) {
      const a = (b.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const rx = dx * c + dz * s, rz = -dx * s + dz * c;
      dx = rx; dz = rz;
    }
    return Math.abs(dx) <= b.w / 2 && Math.abs(dz) <= b.d / 2;
  }

  // Walkable surface under (x,z): the highest floor / stair top no more than
  // STEP_UP above your feet (climb stairs a step at a time; stay on the floor
  // under them). You can always drop to a lower surface (the floor is at 0).
  function groundAt(x, z, feetY) {
    let g = 0;
    for (const b of grounds) {
      if (!inFootprint(b, x, z)) continue;
      const top = b.z + b.h;
      if (top <= feetY + STEP_UP && top > g) g = top;
    }
    return g;
  }

  // Resolve the camera circle out of any wall box it overlaps (axis-aligned).
  function collide(x, z) {
    for (let iter = 0; iter < 3; iter++) {
      let hit = false;
      for (const b of colliders) {
        const hw = b.w / 2 + RADIUS, hd = b.d / 2 + RADIUS;
        const dx = x - b.cx, dz = z - b.cy;
        if (Math.abs(dx) < hw && Math.abs(dz) < hd) {
          hit = true;
          const px = hw - Math.abs(dx), pz = hd - Math.abs(dz);
          if (px < pz) x = b.cx + (dx < 0 ? -hw : hw);
          else z = b.cy + (dz < 0 ? -hd : hd);
        }
      }
      if (!hit) break;
    }
    return [x, z];
  }

  let edgeMat = null;
  function addEdges(geo, position, rotationY) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    if (position) e.position.copy(position);
    if (rotationY) e.rotation.y = rotationY;
    scene.add(e);
  }

  // A gradient sky dome (vertex colours, no shader) so doorways/windows look out
  // onto a rough sky + horizon.
  function makeSky() {
    const geo = new THREE.SphereGeometry(24000, 24, 16);
    const pos = geo.attributes.position, colors = [];
    const top = new THREE.Color("#5b8fd0"), hor = new THREE.Color("#d6e4f2"), grd = new THREE.Color("#8a9a6f"), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 24000;
      if (y >= 0) tmp.copy(hor).lerp(top, Math.min(1, y * 1.5));
      else tmp.copy(hor).lerp(grd, Math.min(1, -y * 3));
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }));
    sky.renderOrder = -1;
    return sky;
  }

  function build() {
    const data = window.__plan3d.build();
    hiQual = !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); // touch = lean, desktop = full
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#bcd4ec");
    const bx = data.bounds, fin = isFinite(bx.minX);
    const cx = fin ? (bx.minX + bx.maxX) / 2 : 0, cz = fin ? (bx.minY + bx.maxY) / 2 : 0;
    const ext = fin ? Math.max(bx.maxX - bx.minX, bx.maxY - bx.minY, 1000) : 1000;

    const W = holder.clientWidth || window.innerWidth, H = holder.clientHeight || window.innerHeight;
    camera = new THREE.PerspectiveCamera(70, W / H, 4, 60000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    if (hiQual) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
    holder.appendChild(renderer.domElement);
    attachLook(renderer.domElement);
    makeControls();

    // Light comes from the windows and the ceiling orbs (added below), not from a
    // low-angle "sun" (which read as light from nowhere). A soft, even sky ambient
    // keeps the cream walls reading as cream rather than going pure black.
    scene.add(new THREE.HemisphereLight("#f2f5fb", "#c8c2b4", 0.72));
    scene.add(makeSky());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000), new THREE.MeshLambertMaterial({ color: "#93a778" }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -3, cz);
    ground.receiveShadow = hiQual;
    scene.add(ground);
    edgeMat = new THREE.LineBasicMaterial({ color: "#1e293b", transparent: true, opacity: 0.5 });

    colliders = []; grounds = []; roomsList = data.rooms || []; curRoom = null;
    const cache = {};
    const trans = (k) => k === "ceiling" || k === "glass";
    const matFor = (c, kind) => {
      const key = c + kind;
      if (!cache[key]) {
        if (kind === "glass") cache[key] = new THREE.MeshLambertMaterial({ color: c, transparent: true, opacity: 0.3, side: THREE.DoubleSide, emissive: new THREE.Color("#e2f2ff"), emissiveIntensity: 0.55 });
        else cache[key] = new THREE.MeshLambertMaterial({ color: c, transparent: kind === "ceiling", opacity: kind === "ceiling" ? 0.35 : 1, side: kind === "ceiling" ? THREE.DoubleSide : THREE.FrontSide });
      }
      return cache[key];
    };
    // "collider"/"ground" boxes are invisible (they only block or carry the walk
    // surface); everything else is drawn.
    const hidden = (k) => k === "collider" || k === "ground";
    for (const b of data.boxes) {
      if (!hidden(b.kind)) {
        const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
        const mesh = new THREE.Mesh(geo, matFor(b.color, b.kind));
        mesh.position.set(b.cx, b.z + b.h / 2, b.cy);
        const ry = b.rot ? (-b.rot * Math.PI) / 180 : 0;
        if (ry) mesh.rotation.y = ry;
        if (hiQual && !trans(b.kind)) { mesh.castShadow = true; mesh.receiveShadow = true; }
        scene.add(mesh);
        if (b.kind !== "ceiling" && b.kind !== "glass") addEdges(geo, mesh.position, ry);
      }
      // Block on tall walls (at any floor level) and colliders; low sills, lintels
      // and rails don't block. (The old `z < 150` test wrongly let you walk through
      // every upstairs wall.)
      if (b.kind === "collider" || (b.kind === "wall" && b.h >= 150)) colliders.push(b);
      if (b.kind === "ground" || b.kind === "floor" || b.kind === "stair") grounds.push(b);
    }
    // Floors & ceilings are flat outline polygons (with stairwell holes cut out).
    for (const p of data.polys || []) buildPolyFloor(p);
    for (const r of data.rails || []) buildRail(r);
    for (const s of data.stairs || []) buildStair(s);

    // A glowing bulb + a warm point light hanging under every room's ceiling.
    const orbGeo = new THREE.SphereGeometry(9, 16, 12);
    const orbMat = new THREE.MeshBasicMaterial({ color: "#fff6d8" });
    let lit = 0;
    for (const r of roomsList) {
      const ox = (r.minx + r.maxx) / 2, oz = (r.miny + r.maxy) / 2, oy = r.z1 - 16;
      const orb = new THREE.Mesh(orbGeo, orbMat);
      orb.position.set(ox, oy, oz);
      scene.add(orb);
      if (lit++ < 24) {
        const diag = Math.hypot(r.maxx - r.minx, r.maxy - r.miny);
        // decay 1 (softer than inverse-square) so one bulb lights a whole room.
        const pl = new THREE.PointLight("#ffe6b0", 65, Math.max(800, diag * 1.7), 1);
        pl.position.set(ox, oy - 10, oz);
        scene.add(pl);
      }
    }
    // Daylight spilling in through each window (from the glass pane).
    let winLit = 0;
    for (const b of data.boxes) {
      if (b.kind !== "glass" || winLit++ >= 24) continue;
      const wl = new THREE.PointLight("#cfe0ff", 40, 500, 1);
      wl.position.set(b.cx, b.z + b.h / 2, b.cy);
      scene.add(wl);
    }

    groundY = groundAt(data.spawn.x, data.spawn.y, 0);
    eyeY = groundY + EYE;
    camera.position.set(data.spawn.x, eyeY, data.spawn.y);
    yaw = 0; pitch = -0.12; flyOffset = 0; // start looking very slightly down into the room
    onResize();
    // Dev/testing hook: pose the camera and render one frame for a headless
    // screenshot (see floorplan/dev/render3d.cjs and floorplan/CLAUDE.md). Inert in
    // normal use — the walk loop resumes on any input.
    window.__walk3d = { view(px, py, pz, yw, pt) { active = false; camera.position.set(px, py, pz); camera.rotation.set(pt, yw, 0, "YXZ"); renderer.render(scene, camera); }, rooms: () => roomsList };
  }

  // A flat floor/ceiling drawn to the room's real outline (a plan-space polygon),
  // with any stairwell openings cut out as holes, laid flat at height p.z.
  function buildPolyFloor(p) {
    if (!p.points || p.points.length < 3) return;
    const shape = new THREE.Shape(p.points.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hole of p.holes || []) {
      if (hole.length < 3) continue;
      shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    }
    const geo = new THREE.ShapeGeometry(shape);
    // ShapeGeometry lies in the XY plane (z = 0); remap (x, y) -> (x, height, y)
    // so it lies flat at p.z.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i), p.z, pos.getY(i));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: p.color, side: THREE.DoubleSide }));
    if (hiQual) mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // A banister rail whose foot follows a raking floor (alongside split-level
  // steps): a vertical strip from each floor point up by `h`. pts = [x, planY, z].
  function buildRail(r) {
    if (!r.pts || r.pts.length < 2) return;
    const pos = [];
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, ay, az] = r.pts[i], [bx, by, bz] = r.pts[i + 1];
      const a0 = [ax, az, ay], b0 = [bx, bz, by], a1 = [ax, az + r.h, ay], b1 = [bx, bz + r.h, by];
      pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: r.color, side: THREE.DoubleSide }));
    if (hiQual) { mesh.castShadow = true; mesh.receiveShadow = true; }
    scene.add(mesh);
  }

  // Custom stair mesh: a diagonal soffit (the understair-cupboard roof, with the
  // flat treads sitting on it) plus solid triangular side walls, each with a door
  // hole on a door side — flat-topped, or diagonally cut where it meets the soffit.
  function buildStair(s) {
    const V = (px, py, h) => new THREE.Vector3(px, h, py); // plan (px,py) + height -> three
    const z0 = s.zBase, z1 = s.zBase + s.rise;
    const bl = V(s.bl[0], s.bl[1], z0), br = V(s.br[0], s.br[1], z0);
    const tr = V(s.tr[0], s.tr[1], z1), tl = V(s.tl[0], s.tl[1], z1);
    const pos = [];
    const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    tri(bl, br, tr); tri(bl, tr, tl); // diagonal soffit quad
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const soffit = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: s.color, side: THREE.DoubleSide }));
    if (hiQual) { soffit.castShadow = true; soffit.receiveShadow = true; }
    scene.add(soffit);
    buildStairSide(s, s.bl, s.tl, s.doors.left);
    buildStairSide(s, s.br, s.tr, s.doors.right);
  }

  function buildStairSide(s, low, high, door) {
    const runLen = Math.hypot(high[0] - low[0], high[1] - low[1]) || 1;
    const rise = s.rise;
    const soffitH = (a) => (rise * a) / runLen; // roof height along the run
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(runLen, 0); shape.lineTo(runLen, rise); shape.lineTo(0, 0);
    if (door) {
      // The doorway, positioned along the run (pos = cm up from the bottom).
      const dw = Math.min(door.width, runLen), c = Math.max(dw / 2, Math.min(runLen - dw / 2, door.pos));
      const dL = c - dw / 2, dR = c + dw / 2;
      const topAt = (a) => Math.max(5, Math.min(s.doorHeight, soffitH(a) - 2)); // stay under the soffit
      const hole = new THREE.Path();
      hole.moveTo(dL, 0); hole.lineTo(dR, 0);
      for (let k = 0; k <= 6; k++) { const a = dR - (dR - dL) * (k / 6); hole.lineTo(a, topAt(a)); }
      shape.holes.push(hole);
    }
    const geo = new THREE.ShapeGeometry(shape);
    const p = geo.attributes.position;
    const runDir = [(high[0] - low[0]) / runLen, (high[1] - low[1]) / runLen];
    for (let i = 0; i < p.count; i++) {
      const a = p.getX(i), z = p.getY(i);
      p.setXYZ(i, low[0] + runDir[0] * a, s.zBase + z, low[1] + runDir[1] * a);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    const wall = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: s.color, side: THREE.DoubleSide }));
    if (hiQual) { wall.castShadow = true; wall.receiveShadow = true; }
    scene.add(wall);
    scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat)); // outline the door shape
  }

  // ----- Look (drag) — works for both touch and mouse; no pointer lock -----
  function attachLook(el) {
    let drag = null;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch (_) {} });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      yaw -= (e.clientX - drag.x) * 0.004;
      pitch -= (e.clientY - drag.y) * 0.004;
      pitch = Math.max(-PITCH_LIM, Math.min(PITCH_LIM, pitch));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // ----- On-screen movement pad (touch) -----
  function makeControls() {
    const mk = (label, code, cls) => {
      const b = document.createElement("button");
      b.className = "walk3d-key " + (cls || "");
      b.textContent = label;
      const set = (v) => (e) => { e.preventDefault(); e.stopPropagation(); keys[code] = v; };
      b.addEventListener("pointerdown", set(true));
      b.addEventListener("pointerup", set(false));
      b.addEventListener("pointerleave", set(false));
      b.addEventListener("pointercancel", set(false));
      return b;
    };
    const pad = document.createElement("div");
    pad.className = "walk3d-pad";
    pad.append(
      mk("▲", "keyw", "up"), mk("◀", "keya", "left"),
      mk("▶", "keyd", "right"), mk("▼", "keys", "down")
    );
    holder.appendChild(pad);
    const vpad = document.createElement("div");
    vpad.className = "walk3d-vpad";
    vpad.append(mk("⤒", "space"), mk("⤓", "shiftleft"));
    holder.appendChild(vpad);
  }

  function onResize() {
    if (!renderer || !camera) return;
    const W = holder.clientWidth || window.innerWidth, H = holder.clientHeight || window.innerHeight;
    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }

  function frame(t) {
    if (!active) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0);
    last = t;

    camera.rotation.set(pitch, yaw, 0, "YXZ");
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let fx = 0, fz = 0;
    if (keys["keyw"] || keys["arrowup"]) { fx -= sy; fz -= cy; }
    if (keys["keys"] || keys["arrowdown"]) { fx += sy; fz += cy; }
    if (keys["keya"] || keys["arrowleft"]) { fx -= cy; fz += sy; }
    if (keys["keyd"] || keys["arrowright"]) { fx += cy; fz -= sy; }
    const len = Math.hypot(fx, fz);
    let x = camera.position.x, z = camera.position.z;
    if (len > 0.01) {
      x += (fx / len) * SPEED * dt;
      z += (fz / len) * SPEED * dt;
      [x, z] = collide(x, z);
    }
    if (keys["space"]) flyOffset += FLY * dt;
    if (keys["shiftleft"] || keys["shiftright"]) flyOffset -= FLY * dt;
    flyOffset = Math.max(-EYE + 20, Math.min(flyOffset, 4000));

    camera.position.x = x;
    camera.position.z = z;
    groundY = groundAt(x, z, groundY); // step-up / drop follow (climb or go under stairs)
    // Ease the eye height toward the floor so stepping onto a stair tread or a
    // split level glides instead of snapping (a big motion-sickness culprit).
    const targetY = groundY + EYE + flyOffset;
    eyeY += (targetY - eyeY) * Math.min(1, dt * EYE_SMOOTH);
    camera.position.y = eyeY;

    if (roomHud) {
      let name = "";
      const y = camera.position.y;
      for (const r of roomsList) {
        if (x >= r.minx && x <= r.maxx && z >= r.miny && z <= r.maxy && y >= r.z0 - 40 && y <= r.z1 + 120) { name = r.name; break; }
      }
      if (name !== curRoom) { curRoom = name; roomHud.textContent = name; roomHud.style.display = name ? "block" : "none"; }
    }
    renderer.render(scene, camera);
  }

  function onKey(down) {
    // Only movement keys — no keyboard "fly up / down" (that stays on the
    // on-screen ⤒ ⤓ buttons).
    const moveKeys = ["keyw", "keya", "keys", "keyd", "arrowup", "arrowdown", "arrowleft", "arrowright"];
    return (e) => {
      if (!active) return;
      const c = e.code.toLowerCase();
      if (!moveKeys.includes(c)) return;
      e.preventDefault();
      keys[c] = down;
    };
  }

  async function open() {
    overlay.hidden = false;
    statusEl.textContent = "Loading 3D…";
    try {
      THREE = await loadThree();
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    if (!window.__plan3d) { statusEl.textContent = "3D unavailable."; return; }
    build();
    active = true;
    last = 0;
    statusEl.textContent = "Drag to look";
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", keyDown, { passive: false });
    window.addEventListener("keyup", keyUp);
    raf = requestAnimationFrame(frame);
  }

  function close() {
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    for (const k in keys) delete keys[k];
    if (roomHud) roomHud.style.display = "none";
    overlay.hidden = true;
    if (renderer) { renderer.dispose(); }
    holder.innerHTML = "";
    renderer = null; scene = null; camera = null;
  }

  const keyDown = onKey(true), keyUp = onKey(false);
  btn.addEventListener("click", open);
  exitBtn.addEventListener("click", close);
  window.addEventListener("keydown", (e) => { if (active && e.code === "Escape") close(); });
})();
