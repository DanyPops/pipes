/** This package's own Vehicle manifest identity name -- the exact string createPipesVehicleRegistry
 * constructs its VehicleRegistry with (vehicle/pipes-vehicle.ts). Exported so a consumer that needs
 * to name "the Vehicle behind Pipes" (e.g. pi-pipes's own persistent widget headers, via
 * @danypops/vehicle-client-pi's vehicleWidgetTitle) has one real source instead of a second
 * hand-typed "pipes" literal that could silently drift from the registry's own. Deliberately its
 * own constant, not a reuse of STATE_DIRECTORY_NAME below -- the two happen to share a value today
 * but name unrelated concepts (Vehicle identity vs. on-disk directory layout). */
export const VEHICLE_NAME = "pipes";

/** XDG state-directory name shared by paths.ts (daemon side) and the
 * pi-pipes' duplicated client (see pi-pipes/src/daemon-client.ts
 * for why it's a duplicate, not an import). Keep these two in sync by hand. */
export const STATE_DIRECTORY_NAME = "pipes";
export const DATABASE_FILENAME = "pipes.db";
export const TOKEN_FILENAME = "auth-token";
export const HANDLE_FILENAME = "daemon.json";
export const SYSTEMD_UNIT_NAME = "pipes.service";

/** Matches conty's differentiated cache TTL for live status polling (see the ported gotchas doc). */
export const RUN_POOL_SYNC_INTERVAL_MS = 30_000;

/** Default ci.tail budget — large enough for a genuinely useful excerpt of a CI log, small enough not to dominate an agent's context on every poll. */
export const DEFAULT_LOG_TAIL_TOKENS = 2000;

/**
 * Hard ceiling on nodes visited by the chain/artifact crawler, independent of
 * the caller's depth (including depth=-1/unlimited) -- mirrors web-spider's
 * crawl.ts maxPages. Every backend's own product team independently
 * concluded a bound was necessary here: GitHub caps reusable-workflow
 * nesting at 10 levels and rejects loops outright; GitLab caps a whole
 * downstream-pipeline hierarchy at 1000. Conty's own chain walker has neither cycle detection nor a node cap and
 * is not safe prior art to copy as-is.
 */
export const CHAIN_CRAWL_MAX_NODES = 200;
