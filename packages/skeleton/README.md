# fhold Skeleton

Skeleton contains files selectively copied into `FH_HOME`.

Release-owned `system/` files are overwritten whole. Operator-owned `config/`
and knowledge defaults are seeded only when absent. Both distributions use the
same explicit [asset allowlists](../lib/src/control-plane/seed.ts); adding a file
to this directory does not activate it.

Fresh fhold homes seed no task definitions. Users create recurring work through
the agent's natural-language schedule flow; restored task definitions remain
inactive until reviewed and explicitly resumed.
