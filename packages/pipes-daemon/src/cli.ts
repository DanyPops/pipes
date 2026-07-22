#!/usr/bin/env bun
import { connectPipesClient } from "./client.ts";
import { serveMain } from "./daemon.ts";

const [, , command] = process.argv;

switch (command) {
	case "serve":
		serveMain();
		break;
	case "health": {
		const client = connectPipesClient();
		const health = await client.health();
		console.log(JSON.stringify(health));
		break;
	}
	case "backends": {
		const client = connectPipesClient();
		const { backends } = await client.call("backends.list", {});
		console.log(JSON.stringify(backends));
		break;
	}
	default:
		console.error("usage: pipes-daemon <serve|health|backends>");
		process.exit(1);
}
