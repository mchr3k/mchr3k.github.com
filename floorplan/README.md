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
- **Google Drive sync** (optional) to keep one plan in sync across devices — see
  below.

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

## Google Drive sync (optional)

The **☁ Drive** button syncs your plan to a single `floorplan.json` in your
Google Drive and keeps it up to date automatically. Conflicts resolve by
**newest-wins** (the most recently edited copy overwrites the other), so you can
edit on a laptop and a phone and they converge.

Notes:

- It uses the least-privilege **`drive.file`** scope — the app can only see the
  one file it creates, never the rest of your Drive.
- It works on the **hosted HTTPS site** (e.g. `https://mchr3k.github.io/floorplan/`),
  not when opening the file locally (Google OAuth can't run from `file://`).
  Export/Import remains the offline path.
- No secret is stored in the repo or the page — browser apps use the OAuth
  *token* flow. Your Client ID lives only in your browser's localStorage.

### One-time setup (~5 minutes)

You need a free Google OAuth **Client ID**:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (or pick an existing one).
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:** choose **External**, fill in the
   app name and your email. Under **Scopes** you don't need to add anything
   (`drive.file` is non-sensitive). Add your own Google account under **Test
   users** (or click **Publish** — `drive.file` needs no Google verification).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Web application.**
   - Under **Authorised JavaScript origins** add the origin you'll use, e.g.
     `https://mchr3k.github.io` (add `http://localhost:8000` too if you serve it
     locally over http for testing).
   - You can leave **Authorised redirect URIs** empty — the token flow uses the
     origin only.
5. Copy the **Client ID** (looks like `…apps.googleusercontent.com`).

### Connecting

The deployed site already has a Client ID baked in, so the setup above is only
needed if you fork this to a different origin.

1. Open the site over HTTPS, click **☁ Drive**, and click **Connect Google
   Drive** (the Client ID is pre-filled; paste your own only to use a different
   Google project).
2. Approve the consent prompt. From then on, changes auto-upload (within a few
   seconds) and the latest version is pulled when you open the app. Use
   **Sync now** to force a sync, or untick **Auto-sync** to go manual.

If you ever see “Sign-in expired”, just open the dialog and connect again
(browser OAuth tokens are short-lived and aren't stored).

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
