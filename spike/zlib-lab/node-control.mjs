// Node control: the same experiment on the reference runtime.
import * as zlibMod from "node:zlib";
import { CASES, experiment, row } from "./experiment.mjs";

console.log(`node ${process.version} results`);
for (const c of CASES) console.log("  " + row(await experiment(zlibMod, c)));
