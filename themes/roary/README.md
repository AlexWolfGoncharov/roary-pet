# Roary theme (v1)

Roarbank lion mascot theme for clawd-on-desk. Built from Lottie animations
(`Roary_lottie/`) converted to APNG + static SVG poses.

## Run
```bash
cd clawd-on-desk
npm install
npm start
```
Then Settings… → Theme → **Roary**.

## State → asset
| State | Asset | Source |
|---|---|---|
| idle | idle.apng | cashback_brows.json |
| thinking | thinking.apng | meditation.json (lotus pose) |
| working | working.apng | turkish_chef_salt.json |
| juggling / working-tier-2 | juggling.apng | playing.json |
| error | error.apng | leo-sad.json |
| attention | attention.apng | positiv.json |
| idle-reading (random idle) | idle-reading.apng | leo_reading.json |
| sleeping | sleeping.svg | sleep.svg |
| click reaction | react.apng | brows_head_tg.json |
| notification | → fallback to attention | (art TODO) |
| sweeping | → fallback to working | (art TODO) |
| carrying | → fallback to working | (art TODO) |

## Sizing (v0.2.0)
Pet window is **square** (S 200 / M 280 / L 360). Assets are normalized to a square
**600×600** canvas: each pose's union-alpha bbox is isolated, scaled to fit ~85% width
/ 68% height (contain), and **bottom-anchored** (feet on a common baseline). theme.json
uses a square `viewBox 600×600` + `objectScale` all 1.0 so the image maps 1:1 to the
window. Rebuild script: `tmp/build_roary2.sh` + `tmp/normalize.py` (PIL union bbox).
Earlier bug: no `layout`/`objectScale` → renderer defaulted to 1.9×1.3 → giant crop.

## Eye-tracking (v0.3.0)
`idle.apng` → `idle-follow.svg` as `states.idle[0]` (the engine treats idle[0] as the
follow SVG). Built by `tmp/make_idle_follow.py` from `eye_brow.svg`: geometry normalized
into the 600² bottom-anchored frame via one outer `translate()+scale()` group; the two
pupil shapes (svgelements idx 36/37, the 3.6×3.6 dark dots) are split into `<g id="eyes-js">`,
the rest stays in static `<g id="lion-body">`. fill-rule preserved (holes render right).
theme.json: `eyeTracking.enabled:true, states:["idle"], eyeRatioX:0.516, eyeRatioY:0.430,
maxOffset:4.0, ids.eyes:"eyes-js"`. Engine applies `translate(dx,dy)` to #eyes-js (local
units, inside the scale group). `idle.apng` (blink) + `idle-reading.apng` are idle randoms.

## TODO (next iterations)
- Real art for notification (paw + "!"), sweeping (broom), carrying (box).
- Sleep sequence (yawn/doze/collapse/wake) — currently `direct`.
- Mini mode (8 states) — currently disabled. `cashback_brows_paws.svg` fits mini-peek.
- Per-state framing/scale alignment (thinking & react are head-only crops).
- Rebrand: productName "Roary on Desk", appId, app/tray/dock icons, make Roary default.
