# Vendored scripts

| File | Source | Version | SHA-256 |
| --- | --- | --- | --- |
| `openvpn-install.sh` | <https://github.com/angristan/openvpn-install> | master, fetched 2026-09-25 | `f10e139ee7f7a52fc022208c1c9ac110093605bddbe7e3fa19897d1af0c77c51` |

The copy is byte-identical to upstream and is executed only after
`scripts/install.sh` re-verifies its SHA-256 against the pinned value above.
To vendor a newer upstream revision: replace the file, update the table here
**and** the `OPENVPN_INSTALL_SHA256` constant in `scripts/install.sh`.
