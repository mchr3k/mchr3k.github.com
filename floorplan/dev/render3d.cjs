#!/usr/bin/env node
// Headless 3D-walk renderer — screenshots the WebGL scene from arbitrary camera
// poses so 3D-walk changes can be *seen* (not just inferred from scene data).
//
// Why this exists: three.js can't be fetched from the CDN inside the build
// sandbox, but (a) WebGL runs fine in headless Chromium and (b) three.js can be
// vendored locally and swapped in for the CDN request. walk3d.js exposes a small
// `window.__walk3d.view(...)` hook (see floorplan/CLAUDE.md) that lets us pose the
// camera and render a single frame for a screenshot.
//
// Usage:
//   node floorplan/dev/render3d.cjs <plan.json> <label> '<viewsJson>'
// where viewsJson is an array of { name, px, py, pz, yaw, pitch } (plan cm; yaw 0
// looks north / -y, +pitch looks up). Screenshots are written next to this script
// as <label>_<name>.png. Prints the room bounds (name + min/max/z) to help pick poses.
//
// Needs Playwright (repo has it at /opt/node22/lib/node_modules/playwright) and
// three.module.js (auto-downloaded here on first run; git-ignored).

const fs = require("fs");
const path = require("path");
const https = require("https");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/index.js");

const HERE = __dirname;
const THREE_URL = "https://unpkg.com/three@0.160.0/build/three.module.js";
const THREE_PATH = path.join(HERE, "three.module.js");
const FLOORPLAN_DIR = path.resolve(HERE, "..");

function ensureThree() {
  if (fs.existsSync(THREE_PATH) && fs.statSync(THREE_PATH).size > 100000) return Promise.resolve();
  console.log("downloading three.module.js …");
  return new Promise((resolve, reject) => {
    https.get(THREE_URL, (res) => {
      if (res.statusCode !== 200) return reject(new Error("three download HTTP " + res.statusCode));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { fs.writeFileSync(THREE_PATH, Buffer.concat(chunks)); resolve(); });
    }).on("error", reject);
  });
}

async function main() {
  const [planPath, label = "view", viewsJson = "[]"] = process.argv.slice(2);
  if (!planPath) { console.error("usage: render3d.cjs <plan.json> <label> '<viewsJson>'"); process.exit(1); }
  await ensureThree();
  const THREE = fs.readFileSync(THREE_PATH, "utf8");
  const plan = fs.readFileSync(planPath, "utf8");
  const views = JSON.parse(viewsJson);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.route(THREE_URL, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: THREE }));
  await ctx.addInitScript((p) => localStorage.setItem("floorplan.state.v3", p), plan);
  const page = await ctx.newPage();
  await page.goto("file://" + FLOORPLAN_DIR + "/index.html", { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const b = document.getElementById("welcome-local"); if (b) b.click(); });
  await page.evaluate(() => document.getElementById("btn-walk3d").click());
  await page.waitForFunction(() => window.__walk3d, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);

  const rooms = await page.evaluate(() => (window.__walk3d ? window.__walk3d.rooms().map((r) =>
    ({ name: r.name, minx: Math.round(r.minx), maxx: Math.round(r.maxx), miny: Math.round(r.miny), maxy: Math.round(r.maxy), z0: Math.round(r.z0), z1: Math.round(r.z1) })) : null));
  if (!rooms) { console.error("walk3d didn't initialise (no __walk3d hook)"); await browser.close(); process.exit(2); }
  console.log("rooms:", JSON.stringify(rooms));

  for (const v of views) {
    await page.evaluate((v) => window.__walk3d.view(v.px, v.py, v.pz, v.yaw, v.pitch), v);
    await page.waitForTimeout(50);
    const out = path.join(HERE, `${label}_${v.name}.png`);
    await page.screenshot({ path: out });
    console.log("shot", out);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
