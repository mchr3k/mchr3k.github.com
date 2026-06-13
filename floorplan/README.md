# Floor Plan Designer

A small, dependency-free tool for sketching room layouts to scale and trying
out furniture arrangements. Everything runs in the browser — no build step, no
server, no accounts.

## Running it locally

Just open `floorplan/index.html` in any modern browser (double-click it, or
drag it into a browser tab). That's it.

> It also works fully offline and on phones/tablets (touch drag, pinch‑to‑zoom).

## What you can do

- **Add rooms** — sized in metres (e.g. `4.2 x 3.5`); stored and shown to scale.
- **Add objects** (furniture) inside a room, with defined dimensions.
- **Drag** rooms and objects to position them. Whole rooms move with their
  contents, so you can assemble an overall floor plan.
- **Rotate** an object by 90°, **duplicate** it, or **delete** it.
- **Name** every room and object — the name is shown on it and is editable.
- **Edit any edge length directly**: every straight edge shows its length in
  **cm**; click the label to type an exact value.
- **Layouts** — duplicate the *entire* arrangement into a new named layout so
  you can explore several alternatives side by side and switch between them.
- **Grid + snapping** (10 cm) to keep things aligned, with pan and zoom.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `R` | Rotate selected object 90° |
| `Del` / `Backspace` | Delete selection |
| `Ctrl/⌘ + D` | Duplicate selection |
| Arrow keys | Nudge selection (hold `Shift` for larger steps) |
| `Esc` | Deselect |

## Saving your work

- Your plan is **auto-saved in this browser** (localStorage) as you work.
- Use **Export** to download the whole document (all layouts) as a JSON file,
  and **Import** to load it back — handy for backups or moving between devices.

## Units & model

Everything is stored internally in **centimetres**. Rooms are entered in metres
purely for convenience; every edge reads and writes in cm.

Shapes are axis-aligned rectangles today, but rendering and edge editing go
through a small geometry layer (`localCorners` / `edgesOf` in `app.js`) so the
model can grow to **rectilinear polygons with cut-outs/cut-ins** (chimney
breasts, bay windows) without rewriting the canvas.

## Hosting (optional)

These are plain static files, so they work as-is on GitHub Pages. Since this
repo already publishes with Jekyll, the folder is served verbatim at
`/floorplan/` (e.g. `https://mchr3k.github.io/floorplan/`) — no extra setup.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and toolbar/panel structure |
| `styles.css` | Styling, including the responsive/mobile layout |
| `app.js` | All application logic (state, rendering, interaction, persistence) |
