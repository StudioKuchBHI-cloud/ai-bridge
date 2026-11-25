# AI Canvas 1.5.0: the new drawing operations (rich look)

Needs the AI Canvas plugin 1.5.0 on the board. The same text is built into AI Bridge companion 1.5.0 (`companion/src/main.js`, section "Vector drawing", "Rich look"); an installed companion older than 1.5.0 does not list it in `instructions.md` yet.

Every `pp.shape`, `pp.path` and `pp.restyle` takes an optional `rich` object. `pp.read` returns the saved look as `rich`. The look is saved next to the drawing, so a person editing its points does not lose it. Send only the parts you want to change. A part set to `null` goes back to the plain style, and `rich: null` removes the whole look. A refused look draws nothing.

| Part | Value | Notes |
|---|---|---|
| `stroke`, `fill` | `{type: "linear", colors: ["#ff0000","#0000ff"], angle: 90}`; `type` can also be `radial`, `angular`, `diamond` (with `cx`, `cy`, `r` as 0 to 1 of the shape); or `stops: [{pos, color, opacity}]` instead of `colors` (2 to 8) | A gradient instead of the solid colour. Angle 0 runs left to right, 90 top to bottom. |
| `fill` as spots | `{type: "spots", base: "#101018", spots: [{x, y, r, color, opacity}]}` | Up to 8 soft colour spots (x, y, r as 0 to 1 of the shape, r about 0.3 to 0.6) fading to transparent: a freeform-gradient look. Live vector. |
| `fill` as mesh | `{type: "mesh", cols: 3, rows: 3, colors: [9 hex colours, row by row, top left first], smooth: 1}` | A grid of colour points (2 to 6 each way) blended smoothly. FigJam has no native mesh, so it becomes a picture used as the fill: not a live vector, redrawn whenever the shape is edited. Fill only. `smooth` 0 to 1 eases the blend. |
| `profile` | `"TAPER"`, `"WEDGE"`, `"QUARTER_TAPER"`, `"EYE"`, `"MIRRORED_TAPER"`, `"UNIFORM"`, or `{points: [{position: 0..1, width: 0..1}]}` | Thick and thin along the stroke; width is a fraction of `width`. Use a wide `width` (10 to 40). Open paths taper at their ends. |
| `brush` | `{type: "STRETCH", name: "NOIR"}` (HEIST, BLOCKBUSTER, GRINDHOUSE, BIOPIC, SPAGHETTI_WESTERN, SLASHER, HARDBOILED, VERITE, EPIC, SCREWBALL, ROM_COM, NOIR, PROPAGANDA, MELODRAMA, NEW_WAVE); `{type: "SCATTER", name: "BUBBLEGUM", gap, wiggle, sizeJitter, angularJitter, rotation}` (BUBBLEGUM, WITCH_HOUSE, SHOEGAZE, HONKY_TONK, SCREAMO, DRONE, DOO_WOP, SPOKEN_WORD, VAPORWAVE, OI); `{type: "DYNAMIC", frequency, wiggle, smoothen}` | Textured, scattered or wobbly stroke. A brush replaces a profile (you get a warning). Needs a stroke `width` of about 8 or more. |
| `effects` | `{noise: {size, density, opacity}, texture: {size, radius}, progressiveBlur: {radius, start}, blur, shadow: {x, y, blur, color, opacity}}` | Grain, a rough texture, a blur that grows from top to bottom (replaces plain `blur`), a drop shadow. |

Other things that matter when drawing:
- `pp.path` places a drawing by its top-left corner (points and handles), so pass that corner as `x`, `y`. `pp.shape` takes `x`, `y` as the top-left of the shape.
- Stroke off: `strokeOpacity: 0`. No fill: `fill: "none"`.
- Updating an existing drawing: send its `id` plus what changes (`kind`, `w`, `h` for `pp.shape`; `points` for `pp.path`).
- Operations that exist since companion 1.4.1: `feedback` (the notes left as stickies, matched to items) and `maxText` on `context` and `find`.

Example:

```json
{"op":"pp.path","points":[{"x":0,"y":50,"out":{"x":60,"y":0}},{"x":200,"y":50,"in":{"x":140,"y":0}}],"width":18,"stroke":"#222222",
 "rich":{"profile":"TAPER","stroke":{"type":"linear","colors":["#ff5a36","#3b6fd4"],"angle":0}}}
```

Worked examples: `demo/claude-portrait-v2.js` and `demo/designer-portrait.js` build full drawings out of these fields.
