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
		const { backends, pipelines } = await client.call("ci.help", {});
		console.log(JSON.stringify({ backends, pipelines }));
		break;
	}
	case "call": {
		const [, , , op, inputJson] = process.argv;
		if (!op) {
			console.error("usage: pipes-daemon call <op> [json-input]");
			process.exit(1);
		}
		const client = connectPipesClient();
		const input = inputJson ? JSON.parse(inputJson) : {};
		const result = await client.call(op as Parameters<typeof client.call>[0], input);
		console.log(JSON.stringify(result));
		break;
	}
	default:
		console.error("usage: pipes-daemon <serve|health|backends|call>\n  call <op> [json-input]  invoke any ci.* operation, e.g. call ci.pool '{\"backend\":\"gh\",\"jobRef\":\"job\"}'");
		process.exit(1);
}
