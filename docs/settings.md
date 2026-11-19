# Polaroica settings

All of Polaroica's settings live under **Settings › Extensions › Polaroica**: open the Settings
editor (Ctrl/Cmd+,) and search for `polaroica`. You can also put them in `settings.json`
(Command Palette → **Preferences: Open User Settings (JSON)**), which is what the samples below
show. Each can be set for your user or for one workspace.

Libraries are not a setting: add and remove them in the **Polaroica** view.

## Browsing

### `polaroica.sortBy`

The order of photos in the grid and in photo tabs, until you pick another order in the grid's
toolbar.

| Value | Order |
| --- | --- |
| `name` (default) | File name, in natural order: `IMG_2` comes before `IMG_10`. |
| `modified` | Date the file was last modified. |
| `size` | File size. |

```json
"polaroica.sortBy": "modified"
```

### `polaroica.showPhotoCounts`

Shows how many photos each album holds next to its name in the Libraries tree. Counting means
listing every folder, which can be slow on a slow network share; turn it off there.

Default: `true`.

```json
"polaroica.showPhotoCounts": false
```

## Thumbnails and cache

### `polaroica.thumbnailSize`

The long edge of the thumbnails Polaroica makes, in pixels: `192`, `256` (default) or `320`.
Bigger thumbnails look sharper when the grid's size slider is turned up, but take more disk space:
about 4, 6 and 9 KB per photo. Changing it makes all thumbnails again.

```json
"polaroica.thumbnailSize": 320
```

### `polaroica.cacheSizeMB`

The most disk space the local thumbnail cache may use, in MB (at least 50). When it's full, the
albums you viewed longest ago are removed first. At the default thumbnail size a photo takes
about 5 KB, so the default of `1024` holds roughly 200,000 photos. **Show Cache Info** in the
Command Palette shows how much is used.

```json
"polaroica.cacheSizeMB": 4096
```

### `polaroica.backgroundThumbnails`

Builds thumbnails for every photo in every library in the background, starting when the window
opens. It makes a quick pass from each photo's small EXIF preview first, then sharp thumbnails
from the camera's built-in preview (or the full file).

Default: `false`. Thumbnails are then built as you open albums, and **Build Thumbnails Here…**
(right-click an album) builds them ahead of time. For a very large library, raise
`polaroica.cacheSizeMB` before turning this on, or older thumbnails are removed as new ones are
made.

```json
"polaroica.backgroundThumbnails": true
```

## Auto-Rank

### `polaroica.autoRank.burstSeconds`

Photos taken at most this many seconds apart that look alike count as one burst. Auto-Rank picks
the best of each burst and keeps near-ties.

Default: `2`. Range: 0.2–30. Raise it if you shoot slowly between frames of the same moment;
lower it if separate moments are being grouped together.

```json
"polaroica.autoRank.burstSeconds": 4
```

### `polaroica.autoRank.sceneSeconds`

Photos taken up to this many seconds apart are also grouped when they show the same scene and
framing, with the same colours in the same places. This catches the same pose shot again after a
short pause, which `burstSeconds` misses.

Default: `60`. Range: 0–600. `0` turns this grouping off.

```json
"polaroica.autoRank.sceneSeconds": 120
```

## Auto adjust

The **Auto** button (the wand at the top of the ADJUST panel) sets the Light and Color sliders
for a balanced picture. These settings add your own correction on top of every Auto result: each
value is added to what Auto chose for that slider, then kept within the slider's range. They are
all `0` by default, which leaves Auto's result as it is. They don't change photos you have already
edited; they apply the next time you press Auto, including in photo tabs that are already open.

A typical set, for photos a little brighter, warmer and punchier than Auto makes them:

```json
"polaroica.autoAdjust.exposure": 0.3,
"polaroica.autoAdjust.temperature": 10,
"polaroica.autoAdjust.contrast": 10,
"polaroica.autoAdjust.vibrance": 10
```

### `polaroica.autoAdjust.exposure`

Added to Auto's Exposure, in EV (stops of light): `1` is twice as bright, `-1` half as bright.

Range: −2 to 2.

```json
"polaroica.autoAdjust.exposure": 0.3
```

### `polaroica.autoAdjust.contrast`

Added to Auto's Contrast. Positive makes darks darker and lights lighter; negative flattens the
picture.

Range: −100 to 100.

```json
"polaroica.autoAdjust.contrast": 15
```

### `polaroica.autoAdjust.highlights`

Added to Auto's Highlights. Negative brings back detail in bright areas such as skies; positive
brightens them.

Range: −100 to 100.

```json
"polaroica.autoAdjust.highlights": -20
```

### `polaroica.autoAdjust.shadows`

Added to Auto's Shadows. Positive opens up dark areas; negative deepens them.

Range: −100 to 100.

```json
"polaroica.autoAdjust.shadows": 15
```

### `polaroica.autoAdjust.whites`

Added to Auto's Whites, which sets where the brightest tones end. Positive pushes more of the
picture to pure white; negative keeps whites softer.

Range: −100 to 100.

```json
"polaroica.autoAdjust.whites": 10
```

### `polaroica.autoAdjust.blacks`

Added to Auto's Blacks, which sets where the darkest tones end. Negative gives deeper, richer
blacks; positive lifts them for a faded look.

Range: −100 to 100.

```json
"polaroica.autoAdjust.blacks": -10
```

### `polaroica.autoAdjust.temperature`

Warms or cools the picture after Auto's white balance. Positive is warmer (more yellow), negative
cooler (more blue). The panel shows the result as a Kelvin value on the Temp slider.

Range: −100 to 100. Small values go a long way: `10` is a gentle warming.

```json
"polaroica.autoAdjust.temperature": 10
```

### `polaroica.autoAdjust.tint`

Added to Auto's Tint. Positive is more magenta, negative more green.

Range: −100 to 100.

```json
"polaroica.autoAdjust.tint": -5
```

### `polaroica.autoAdjust.vibrance`

Added to Auto's Vibrance, which strengthens muted colours more than colours that are already
strong, so skin stays natural.

Range: −100 to 100.

```json
"polaroica.autoAdjust.vibrance": 15
```

### `polaroica.autoAdjust.saturation`

Added to Saturation, which Auto itself leaves alone. It strengthens (or, below 0, weakens) every
colour by the same amount; `-100` makes the picture black and white.

Range: −100 to 100.

```json
"polaroica.autoAdjust.saturation": -10
```

## Export

### `polaroica.export.quality`

JPEG quality of photos made by **Export to JPEG…**, from 50 to 100. The default of `90` keeps all
visible detail; above 95 mostly makes files bigger.

```json
"polaroica.export.quality": 95
```
