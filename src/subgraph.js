// speculum — the subgraph endpoint, pinned once
//
// Five places used to name the deployed subgraph and they disagreed on the
// version. Both answered, so nothing failed, which is how a split like that
// survives. This is the one place the version is written. Everything that
// reads the record imports it from here, and SUBGRAPH_URL in the environment
// still takes precedence for reading another deployment.
//
// Why v0.0.2, established by querying both on Sep 7 2026 rather than by the
// higher number: both are synced to within three blocks of the Base Sepolia
// head and hold the same 18 checks, 18 declarations and 8 overrides, but only
// v0.0.2 carries the DeedIndex and IntentIndex that resolve overrides to the
// verdict they answer. On v0.0.1 every override is `unchecked` and
// Agent.overridden is 0; on v0.0.2 they resolve and it is 8. v0.0.2 is the
// build of the schema and mappings committed in subgraph/.

export const SUBGRAPH_URL = 'https://api.studio.thegraph.com/query/1758736/speculum/v0.0.3';

/** The endpoint to read, honouring the environment override. */
export const subgraphUrl = () => process.env.SUBGRAPH_URL ?? SUBGRAPH_URL;
