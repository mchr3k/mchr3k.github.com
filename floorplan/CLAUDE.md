# Floor Plan Designer — notes for Claude

A vanilla-JS static app (no build step). `index.html` + `app.js` (2D editor & the 3D
scene extraction) + `walk3d.js` (the first-person 3D walk, three.js loaded from a CDN
at runtime) + `styles.css`. State lives in `localStorage` under `floorplan.state.v3`.

## Verifying 3D-walk changes by actually rendering them

The 3D walk is where most bugs hide, and scene-data checks alone miss visual breakage
(z-fighting, missing/again walls, wrong lighting, occluders). **Render it and look.**

- WebGL works in headless Chromium out of the box.
- three.js can't be fetched from the CDN inside the sandbox, so the harness vendors it
  locally and swaps it in for the CDN request via Playwright routing.
- `walk3d.js` exposes a tiny hook when the walk opens:
  `window.__walk3d.view(px, py, pz, yaw, pitch)` poses the camera (plan cm; yaw 0 looks
  north / −y, +yaw turns, +pitch looks up) and renders one frame; `window.__walk3d.rooms()`
  returns each room's world bounds (`minx/maxx/miny/maxy/z0/z1`) so you can pick poses.

### How to render

```
node floorplan/dev/render3d.cjs <plan.json> <label> '<viewsJson>'
```

`viewsJson` is an array of `{ name, px, py, pz, yaw, pitch }`. It prints the room bounds
(use them to place the camera) and writes `floorplan/dev/<label>_<name>.png`. First run
auto-downloads `three.module.js` (git-ignored). Example:

```
node floorplan/dev/render3d.cjs /path/plan.json chk \
  '[{"name":"hall","px":370,"py":160,"pz":30,"yaw":0,"pitch":0.5}]'
```

Then read the PNG. Eye height is ~160 cm above the floor; upstairs rooms sit at their
`z0` (see the printed bounds — split levels/stacked floors raise `z0`).

`floorplan/dev/` (harness, downloaded three.js, screenshots) is dev-only; the app never
references it.

## Scene model quick-reference (app.js → walk3d.js)

`window.__plan3d.build()` returns `{ boxes, polys, stairs, rooms, bounds, spawn }` in plan
cm. Boxes are axis-aligned `box3(cx,cy,z,w,d,h,color,kind,rot)` (cx,cy = plan centre, z =
bottom). Kinds: `wall`/`collider` (collider invisible; both block if tall), `ground`
(invisible walk surface), `floor`/`stair` (walk surface), `frame`/`glass`/`door`/`object`/
`electric`. Floors & ceilings are flat outline `polys` (with stairwell `holes`). Walls are
~1 cm ("zero thickness"). Split levels raise a room's `z` and split its floor at a
within-room stair; banister cut-ins are floor voids with low rails + a full-height outer
wall + an open inner face where the stair arrives.
