import { readPackageVersion } from "@danypops/vehicle-server/version";

export const VERSION: string = readPackageVersion(new URL("../package.json", import.meta.url), "Pipes");
