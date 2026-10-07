using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .mainWorker) ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "worker.mjs", esModule = embed "worker.mjs"),
    (name = "experiment.mjs", esModule = embed "experiment.mjs"),
  ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["nodejs_compat"],
);
