import { Unzip, UnzipInflate } from "fflate";

export const ARTIFACT_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_TEXT_DEFAULT_MAX_BYTES = 64 * 1024;
export const ARTIFACT_TEXT_MAX_BYTES = 128 * 1024;
export const ARTIFACT_LIST_DEFAULT_LIMIT = 50;
export const ARTIFACT_LIST_MAX_LIMIT = 100;
export const ARTIFACT_ENTRY_DEFAULT_LIMIT = 100;
export const ARTIFACT_ENTRY_MAX_LIMIT = 200;

export interface ArtifactEntry {
	name: string;
	compressedBytes?: number;
	uncompressedBytes?: number;
}

export function artifactEntries(data: Uint8Array, requestedLimit?: number): { entries: ArtifactEntry[]; truncated: boolean } {
	const limit = boundedArtifactInteger(requestedLimit ?? ARTIFACT_ENTRY_DEFAULT_LIMIT, 1, ARTIFACT_ENTRY_MAX_LIMIT, "maxEntries");
	const entries: ArtifactEntry[] = [];
	let discovered = 0;
	const unzip = new Unzip((file) => {
		discovered++;
		if (entries.length < limit) {
			entries.push({ name: file.name, compressedBytes: file.size, uncompressedBytes: file.originalSize });
		}
	});
	unzip.register(UnzipInflate);
	unzip.push(data, true);
	return { entries, truncated: discovered > limit };
}

export function artifactText(
	data: Uint8Array,
	entryName: string,
	requestedMaxBytes?: number,
): { text: string; bytes: number; truncated: false } {
	if (!entryName || entryName.length > 1024) throw new Error("artifact entry must be 1 to 1024 characters");
	const maxBytes = boundedArtifactInteger(requestedMaxBytes ?? ARTIFACT_TEXT_DEFAULT_MAX_BYTES, 1, ARTIFACT_TEXT_MAX_BYTES, "maxBytes");
	let found = false;
	let failure: Error | undefined;
	let total = 0;
	const chunks: Uint8Array[] = [];
	const unzip = new Unzip((file) => {
		if (file.name !== entryName) return;
		found = true;
		if (file.originalSize !== undefined && file.originalSize > maxBytes) {
			failure = new Error(`artifact entry exceeds maxBytes ${maxBytes}`);
			return;
		}
		file.ondata = (error, chunk, final) => {
			if (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				return;
			}
			if (!chunk) return;
			total += chunk.length;
			if (total > maxBytes) {
				failure = new Error(`artifact entry exceeds maxBytes ${maxBytes}`);
				file.terminate();
				return;
			}
			chunks.push(chunk);
			if (final) file.terminate();
		};
		file.start();
	});
	unzip.register(UnzipInflate);
	unzip.push(data, true);
	if (failure) throw failure;
	if (!found) throw new Error(`artifact entry not found: ${entryName}`);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`artifact entry is not UTF-8 text: ${entryName}`);
	}
	return { text, bytes: total, truncated: false };
}

export function assertArtifactArchiveBound(data: Uint8Array): void {
	if (data.length === 0 || data.length > ARTIFACT_ARCHIVE_MAX_BYTES) {
		throw new Error(`artifact archive must be 1 to ${ARTIFACT_ARCHIVE_MAX_BYTES} bytes`);
	}
}

export function boundedArtifactInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}
