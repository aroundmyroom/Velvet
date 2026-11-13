# Notices

Velvet is licensed under the GNU General Public License v3.0 (see `LICENSE`).
This file lists third-party specifications, trademarks and material that
parts of Velvet are based on.

## Sendspin protocol (Velvet Rooms)

Velvet implements the Sendspin protocol specification, protocol version 1
(release candidate RC1), from github.com/Sendspin/spec (revision `9d2f15e`,
November 2026). The specification is published under the Community
Specification License 1.0; a copy is included as
`COMMUNITY-SPEC-LICENSE-1.0.md` in the root of this source tree.

"Sendspin" and the Sendspin logo are trademarks of the Open Home Foundation.
Velvet is not affiliated with, endorsed by or certified by the Open Home
Foundation; "Velvet Rooms" works with Sendspin speakers.

The test vectors in `test/fixtures/sendspin/` (`noise-vectors.json`,
`pairing-vectors.json`) were generated with aiosendspin
(github.com/Sendspin/aiosendspin, Apache License 2.0) using the scripts
`gen_vectors.py` and `gen_pairing_vectors.py` in the same folder.

## VoltViz (visualizer)

The VoltViz visualizers in `webapp/assets/js/lib/voltviz/` are built from
VoltViz by Sander de Wildt (github.com/sanderdw/voltviz, MIT License,
Copyright (c) 2026 VoltViz Contributors). The exact upstream version and
commit are recorded in `webapp/assets/js/lib/voltviz/VERSION`; the bundle is
produced by `scripts/build-voltviz.cjs`, which adapts the audio engine to
Velvet's player graph and leaves out the neural beat model (onnxruntime-web).

Shipped next to the bundle:

- `LICENSE`: the VoltViz MIT license.
- `THIRD_PARTY_NOTICES.md`: upstream's notices for adapted code and data.
- `THIRD_PARTY_LICENSES.txt`: the license texts of the npm packages bundled
  into it (three, d3-geo, d3-array, react, react-dom and lucide-react, all MIT
  or ISC).

Of the material listed in upstream's notices, Velvet ships:

- Halftone Pulse: shape library ported from "Dither / ASCII Effect Pro" by
  sabosugi (codepen.io/sabosugi/pen/bNegbmy, MIT).
- Dutch Grid visualizers: municipality boundaries 2023 of Statistics
  Netherlands (CBS) and Kadaster via PDOK, CC BY 4.0. Source: © CBS, Kadaster.

The Moss Ball (CC BY-NC 4.0 shaders by ledhieu) and Flame (CC BY-NC-SA 3.0
shader by kuvkar) visualizers are not included: their non-commercial licenses
are incompatible with the GPL. Aurora Waves, Shambhala, Inside Quantum, Holo
Blinds and Particles Stream are not included either: their source code says
they were adapted from an outside shader or demo without naming it or its
license (Aurora Waves explicitly from Shadertoy, whose default license is
CC BY-NC-SA 3.0), so their license cannot be confirmed as GPL-compatible. The
reasons are recorded in `VERSION`. The *Beat This!* model is not included
either.

Names used for visualizers (Winamp, Windows 95, Disney, Defqon.1, Razor 1911
and others) are trademarks of their respective owners, used descriptively.
