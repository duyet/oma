---
"@getoma/cli": patch
---

Read ok responses as text and parse only when there is a body, so an empty 2xx resolves instead of throwing: `oma sessions message` no longer exits 1 with "Unexpected end of JSON input" on the `202` that `POST /v1/sessions/:id/events` returns after queueing the turn. Closes the leftover publish path from #436 reported in #474.