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
