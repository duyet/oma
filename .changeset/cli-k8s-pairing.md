---
"@getoma/cli": patch
---
Add non-interactive runtime pairing (`oma bridge pair` + `OMA_PAIRING_CODE`/`_STATE`/`_SERVER_URL` self-pair) for the in-cluster bridge daemon — redeems a multi-use `k8s_pairing` code via `/agents/runtime/exchange` without a browser. Companion to the `oma-bridge-daemon` chart's `pairing.existingSecret` values block.
