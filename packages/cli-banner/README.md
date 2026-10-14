# @atlasauth/cli-banner

The animated Atlas mark for command-line tools.

It is a tiny real-time 3D software renderer — the Atlas diamond-on-tile logo as
actual geometry (a gradient tile slab, a white diamond standing proud of it, a
dark centre dot), spun with a z-buffer, Lambert + specular lighting, a luminance
ASCII ramp, and 24-bit colour. No images, no dependencies.

```ts
import { showBanner } from '@atlasauth/cli-banner';

await showBanner(); // animates on a TTY, silent when piped or in CI
```

`showBanner()` is safe to call unconditionally at the top of a CLI:

- animates only on an interactive TTY wide enough to hold the frame;
- prints nothing when output is piped or `CI` is set, so logs stay clean;
- respects `NO_COLOR` (keeps the form, drops the tint) and
  `ATLAS_NO_BANNER=1` (off entirely).

## Preview

```sh
npx atlas-banner           # play it
npx atlas-banner --static  # print the still frame
npx atlas-banner --no-color
```

## Lower-level API

| export | what |
| --- | --- |
| `showBanner()` | animate-or-still, environment-aware. The one you want. |
| `animate()` | force the intro animation (assumes a TTY). |
| `staticBanner(colour?)` | the still frame + wordmark as a string. |
| `bannerAllowed(stream?)` | the gate `showBanner` uses. |
| `frame(ay, ax?, colour?)` | one rendered frame at a given rotation. |

MIT.
