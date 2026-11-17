# Skins

A skin gives the web player a different look. It is one CSS file, `skin.css`, in its own folder. Velvet loads it after
its own stylesheet, so a skin only has to override what it wants to change. Usually that is the colours; a skin can
also restyle shapes, sizes and fonts.

Velvet ships one example skin, **goud** (black and gold), in `webapp/skins/goud/skin.css`.

## Adding a skin

1. Create a folder for it in `save/skins/`, named with lowercase letters, digits, `-` or `_` (at most 40 characters),
   for example `save/skins/midnight/`.
2. Put a `skin.css` in that folder. Images or fonts the skin uses can go in the same folder and are referenced
   relatively, for example `url(logo.png)`.
3. The skin shows up straight away: no restart is needed. Reload the player and pick it.

Your own skins live in `save/skins/` (change it with `storage.skinsDirectory` in the config, see
[json_config.md](json_config.md)), so updates never touch them. A skin in `save/skins/` with the same name as a built-in
one replaces the built-in one.

## Choosing a skin

- **Users:** User Settings → **Skin**. *Server default* follows the admin's choice, *None* shows Velvet without a skin.
  The choice follows the user to other browsers.
- **Admins:** Admin → Settings → User Interface → **Default Skin**. It applies to every user who has not picked a skin
  (config key `skin`, API `POST /api/v1/admin/config/skin`).

A skin applies to the web player. The admin panel, mobile web app and shared-playlist pages keep their own look.

## Writing a skin

Start every selector with `:root[data-skin]`. Velvet sets `data-skin` on the page while a skin is active, and the
selector makes your rules win over the built-in themes (light, dark, high contrast) as well.

Most of the work is setting Velvet's colour variables:

| Variable | Used for |
|---|---|
| `--bg` | Page background |
| `--surface` | Sidebar, player bar |
| `--raised` | Raised controls, small buttons |
| `--card` | Cards, menus, dialogs |
| `--border`, `--border2` | Lines and outlines (`--border2` slightly stronger) |
| `--hover`, `--active` | Hover and selected backgrounds |
| `--primary`, `--primary-h` | Accent colour and its hover shade |
| `--primary-d`, `--primary-g` | Soft and glowing versions of the accent (transparent) |
| `--accent` | Second accent (progress, links) |
| `--focus` | Keyboard focus ring |
| `--t1`, `--t2`, `--t3`, `--t4` | Text: main, secondary, muted, faint |
| `--green`, `--red`, `--yellow` | Status colours |
| `--r`, `--r2` | Corner radius: small and large |

The example skin, `webapp/skins/goud/skin.css`:

```css
:root[data-skin] {
  --bg: #0d0d0f;  --surface: #141416;  --raised: #1d1c20;  --card: #18181b;
  --border: #2a2722;  --border2: #3a352c;
  --hover: rgba(255, 255, 255, .05);  --active: rgba(212, 168, 75, .14);
  --primary: #d4a84b;  --primary-h: #c0943a;
  --primary-d: rgba(212, 168, 75, .14);  --primary-g: rgba(212, 168, 75, .4);
  --accent: #f0d58c;  --focus: #f0d58c;
  --t1: #f4efe4;  --t2: #aaa293;  --t3: #8d867a;  --t4: #3a352c;
}
:root[data-skin] .q-dj-tag {
  color: #f0d58c;
  background: rgba(212, 168, 75, .12);
  border-color: rgba(212, 168, 75, .4);
}
:root[data-skin] .play-main {
  background: linear-gradient(145deg, #f0d58c, #b8862f);
  color: #141416 !important;
  box-shadow: 0 0 0 6px rgba(212, 168, 75, .12), 0 6px 18px rgba(212, 168, 75, .25);
}
```

To restyle a single part, look up its class in the browser's developer tools and add a rule, for example
`:root[data-skin] .song-row { border-radius: 0; }`.

## Limits

- A skin is CSS only. It cannot run scripts or change what the player does.
- When a user turns on the dynamic colour from album art (Audio Settings), that colour replaces the skin's
  `--primary` and `--accent` while a song plays. That is the user's own choice, so it wins over the skin.
- Class names can change between Velvet versions. Colour variables are stable; rules for specific classes may need a
  touch-up after an update.
- Only the admin can add skins (they live on the server). The files are served publicly at `/skins/<name>/`, like the
  rest of the player's stylesheets, so do not put anything private in a skin folder.

## API

`GET /api/v1/ping` lists the installed skins (`skins: [{ id, v }]`) and the admin's default (`defaultSkin`).
See [API.md](API.md).
