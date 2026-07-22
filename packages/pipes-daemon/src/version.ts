import { readPackageVersion } from "@danypops/daemon-kit/version";

export const VERSION: string = readPackageVersion(new URL("../package.json", import.meta.url), "Pipes");
