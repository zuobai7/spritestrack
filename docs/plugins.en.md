# Plugins: procedural generators

[中文](plugins.md)

Every entry in SpriteStrack's Generate dialog is a **generator**: it takes a few parameters and fills a voxel grid. Besides the built-in terrain, tree, rock, shape, house and flame generators you can write your own in two ways:

- **Custom script**: pick "Custom script" in the Generate dialog and write JavaScript right there. Good for one-off ideas.
- **Plugin**: a `.js` file that registers generators, with a parameter UI, that you can share.

## Loading a plugin

- Top bar → **Import → Load plugin (.js)** and pick the file. It runs as an ES module.
- Or run the plugin code in the browser console.
- On a self-hosted copy, add `<script type="module" src="./my-plugin.js"></script>` to `index.html` (after `src/main.ts`).

Try the example plugin [examples/spiral-tower.js](examples/spiral-tower.js).

## `window.SpriteStrack`

| Member | Description |
| --- | --- |
| `registerGenerator(generator)` | Registers a generator; the same `id` replaces the old one |
| `getGenerators()` | Registered generators |
| `version` | App version |
| `isDesktop` | True inside the desktop app |
| `editor` | The editor object (advanced; may change between versions) |

## Writing a generator

```js
SpriteStrack.registerGenerator({
  id: 'pillar', // unique id
  name: { zh: '柱子', en: 'Pillar' }, // or a plain string
  description: { zh: '一根带柱头的圆柱', en: 'A round pillar with a capital' }, // optional
  animated: false, // true if the result changes with ctx.t ("New animation" needs it)
  params: [
    { key: 'radius', label: { zh: '半径', en: 'Radius' }, type: 'number', default: 3, min: 1, max: 16, step: 0.5 },
    { key: 'color', label: { zh: '颜色', en: 'Color' }, type: 'color', default: '#8b9bb4' },
    { key: 'capital', label: { zh: '柱头', en: 'Capital' }, type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const c = ctx.color(p.color);
    const cx = ctx.sx / 2;
    const cz = ctx.sz / 2;
    for (let y = 0; y < ctx.sy; y++) ctx.sphere(cx, y + 0.5, cz, p.radius, c, 0.5);
    if (p.capital) ctx.box(cx - p.radius - 1, ctx.sy - 2, cz - p.radius - 1, cx + p.radius, ctx.sy - 1, cz + p.radius, c);
  },
});
```

### Parameter types

| `type` | Control | Value |
| --- | --- | --- |
| `int` | Slider, step 1 | number |
| `number` | Slider using `min` / `max` / `step` | number |
| `bool` | Checkbox | `true` / `false` |
| `color` | Color picker | `'#rrggbb'` string |
| `select` | Dropdown, `options: [{ value, label }]` | the chosen `value` |

`label` and `options[].label` can be `{ zh, en }` to follow the UI language.

### The `ctx` API

| Member | Description |
| --- | --- |
| `sx`, `sy`, `sz` | Model size (width, height, depth) |
| `t` | Animation time in `[0, 1)`; 0 for a single frame |
| `frame`, `frameCount` | Current frame and number of frames |
| `rand()` | Seeded random number in `[0, 1)` |
| `randInt(min, max)` | Seeded random integer, both ends included |
| `noise2(x, y)`, `noise3(x, y, z)` | Perlin noise, about `[-1, 1]` |
| `fbm2(x, y, octaves?)`, `fbm3(x, y, z, octaves?)` | Layered (fractal) noise |
| `get(x, y, z)` | Reads a voxel (palette index, 0 = empty) |
| `set(x, y, z, color)` | Writes a voxel; coordinates are floored, out-of-range writes are ignored, `color` 0 erases |
| `box(x0, y0, z0, x1, y1, z1, color)` | Fills a box (both corners included) |
| `sphere(cx, cy, cz, rx, color, ry?, rz?)` | Fills a sphere or ellipsoid |
| `color('#rrggbb' or 0xrrggbb)` | Palette index of a color; adds it if missing, or picks the closest when the palette is full |
| `clear()` | Empties the grid |

### Conventions

- **Coordinates**: x right, y up, z towards the viewer of the front view. Voxel `(x, y, z)` covers `[x, x+1) × [y, y+1) × [z, z+1)`, so its center is at `x + 0.5`.
- **Randomness**: use `ctx.rand`, `ctx.randInt` and the noise functions so a seed always gives the same result. `Math.random()` defeats the seed.
- **Animation**: with "New animation", `generate` runs once per frame with `ctx.t = frame / frameCount`. Periodic functions such as `Math.sin(2 * Math.PI * ctx.t)` make the animation loop seamlessly.
- **Merging**: with "Merge into current frame" the grid starts with the current frame, so `ctx.get` reads what is there.
- **Colors**: the palette holds up to 255 colors. New colors are added to the active color scheme; other schemes fill missing indices from it.

## Custom scripts

"Custom script" in the Generate dialog is the body of `generate(ctx, params)` and gets the same `ctx`. Scripts run in a background thread (Web Worker):

- a preview that takes longer than 5 seconds is stopped, so an endless loop can't freeze the editor;
- there is no access to the page (no `document`, no `window.SpriteStrack`);
- your script is kept in the browser for next time.
