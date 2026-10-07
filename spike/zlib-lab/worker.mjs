// workerd side: run with `workerd test config.capnp` (one-shot, no server).
import * as zlibMod from "node:zlib";
import { CASES, experiment, row } from "./experiment.mjs";

export default {
  async test() {
    console.log("workerd results");
    for (const c of CASES) console.log("  " + row(await experiment(zlibMod, c)));
  },
};
